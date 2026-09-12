# Phase012：受保护后台与用户管理

本阶段接入既有 AdminShell，提供管理员用户列表与角色/状态修改，并首次创建 AdminCommandReceipt、KeyRotationRun 的持久化基础。实现范围不包含密钥管理、审计列表、系统配置、模型/Prompt 页面或共享 worker。阶段输入和来源摘要见 [冻结计划](phase-plans/Phase012.json) 与 [输入清单](phase-plans/Phase012-inputs.json)；本说明不替代真实验收，完成状态以对应 attempt、Gate、artifact/metadata 双提交及双 shell seal 为准。

## 页面与导航

`src/app/admin/layout.tsx` 保持中性。公开登录位于 `src/app/admin/(public)/login/page.tsx`，没有后台导航。`src/app/admin/(protected)/layout.tsx` 通过 requireAdmin 后直接复用唯一 `src/components/layout/admin-shell.tsx`；受保护索引页和用户页也各自验证管理员权限。`/admin` 确定性重定向 `/admin/users`。

唯一导航配置为 `src/components/admin/admin-nav.ts`，当前只有用户管理链接与退出动作。高亮按完整路径或 `href + '/'` 的最长匹配决定。shell 显示当前管理员邮箱，支持折叠、Tab、方向键、Home/End、Escape 回到导航开关和跳到主要内容；退出复用既有 Auth.js 处理器。后台没有预览分支、第二套 shell 或未来页面占位。

用户页支持角色、状态、每页条数筛选和游标翻页。页码与本页条数按实际数据展示，不推算总量。加载、空列表和错误各有独立状态，失败可重试。表格在窄屏自己的滚动区域内横向滚动。编辑保存 GET 带回的 revision；同一待重试正文复用 Idempotency-Key，提交失败保留输入，取消和成功后回到触发按钮。409 显示最新安全摘要、关闭旧编辑并要求重新选择操作，防止自动覆盖并发修改。

## 管理接口与安全摘要

端点目录和 exact 请求/响应由 [API 契约](api.md#phase012-用户管理实现) 统一定义。GET `/api/admin/users` 和 PATCH `/api/admin/users/{id}` 都要求当前 ACTIVE ADMIN 的 ADMIN audience 会话，响应均 `Cache-Control: no-store`。身份来自服务器验证的 Cookie，重放和事务提交前仍检查当前授权。

管理摘要始终精确包含 `id/email/name/avatarUrl/role/status/lastLoginAt/createdAt/revision`。name、avatarUrl、lastLoginAt 可为 null，时间输出为 ISO 字符串。列表、成功修改、原收据重放及409最新摘要使用同一字段白名单与 select；passwordHash、sessionVersion、phone 不读回到管理对象，也不先读取完整 User 后删字段。sessionVersion 的授权比较留在数据库 SQL 条件中。

GET 只接受可选 `role=USER|ADMIN`、`status=ACTIVE|DISABLED`、opaque cursor 和 limit。limit 默认20，范围1–100；未知/重复参数和不合法值返回400 VALIDATION_ERROR。固定排序为 `(createdAt DESC,id DESC)`，data 为 `{items,nextCursor}`。HMAC 签名游标绑定当前管理员、筛选 hash、排序、最后位置与首屏数据库时间水位；后续页过滤水位后的新用户。篡改、跨管理员或跨筛选重用均拒绝。游标并非整个数据库的跨请求快照，角色/状态发生变化时应刷新首屏。

PATCH 的 URL 是目标身份唯一来源。正文精确为：

```json
{
  "role": "USER",
  "status": "DISABLED",
  "expectedVersion": 3,
  "reason": "停用该测试账户"
}
```

必须使用 application/json，正文不超过8192 bytes，并提供允许的 Origin、当前会话的 `X-CSRF-Token` 和8–128位安全字符的 `Idempotency-Key`。expectedVersion 取 GET 的非负 Int revision；不接受 expectedUpdatedAt、正文 userId 或未知字段。reason 必须是合法 Unicode，trim 后1–500个 UTF-16 单元且不含控制字符，不应填写秘密或个人正文。成功 body 的 data 仍只有九字段；header `Idempotency-Replayed: false|true` 区分首次完成与原收据重放。

## 事务、保护条件与会话撤销

写服务以 Serializable 事务处理，按固定顺序取得全局用户管理 advisory lock，再按 id 锁定活动管理员集合、actor 与 target。持锁后验证 actor 的 ADMIN audience、角色、状态、会话有效期及 sessionVersion 匹配。只有已授权请求才能查询目标是否存在。

首次请求先比较 expectedVersion 与 User.revision，再判断同值。冲突为409 VERSION_CONFLICT，details 只含 currentVersion、`action:"RELOAD"` 和九字段 current；数据库没有局部业务写入。自身 role/status 实际变化被拒绝，任何导致最后一位 ACTIVE ADMIN 被降权或停用的变化也被拒绝；保护在事务锁内重新计数，并非事务外先 count 再 update。并发管理员互相修改时仍须保留至少一位活动管理员。

合法变化在同一事务执行以下步骤：

1. role/status 写入，revision 与 sessionVersion 各递增1。
2. 将目标全部 ACTIVE AuthSession 改为 REVOKED，revokedAt 使用 `public.auth_now()`。
3. 追加一条 USER_UPDATE 审计，包含 before/after 的 role、status、revision、sessionVersionIncremented 布尔和受控结果/原因码。
4. 持久化九字段成功收据，与业务变化和审计一起提交。

reason 由既有审计脱敏器全文替换为 `***`；不持久化任意自由文案，不记录 sessionVersion 数值。CAS、自保护、最后管理员保护、审计或收据失败都回滚。目标旧 Cookie 的下一次请求即被数据库会话检查拒绝；重新启用目标也不复活旧会话。

同值且 CAS 匹配时不改 User/AuthSession，不增加两个版本，也不写 USER_UPDATE。严格审计事务先通过内部信号回滚，然后在只写收据的独立 Serializable 事务中重新锁定、授权、查收据、比较 CAS 和同值条件；这样不削弱既有“成功审计事务必须包含已等待审计”的约束。若两次事务之间数据变了，第二次检查仍会拒绝过期请求。

服务只对 serialization、deadlock 和幂等唯一竞争进行25/50/100ms的有限退避，最多四次尝试。业务拒绝、未知数据库故障和审计校验失败不会转成假成功；服务不可用以503和安全模板返回，不作为空列表。

## 幂等与轮换账本

收据域为当前 `ownerUserId + patch.admin.users.id + URL resourceId + idempotencyKeyHash`。Idempotency-Key 只保存 SHA-256；验证并规范化后的四字段正文使用 JCS SHA-256 形成 requestHash，reason 原文不进入收据。相同域、键和正文在重启后仍返回原成功摘要，`Idempotency-Replayed: true`；异正文返回409 IDEMPOTENCY_KEY_REUSED。同键并发只能产生一份终态，不能重复增加版本、撤会话或写审计。重放顺序是当前授权→原收据→原结果，不用已过时的首次 CAS 制造第二个结果。

两张新表的完整字段、外键、索引和约束见 [数据库规范](database.md#221-admincommandreceiptphase012)。AdminCommandReceipt 状态为 PENDING/RUNNING/RETRY_WAIT/SUCCEEDED/FAILED。同步用户命令可在业务事务直接插入不可变 SUCCEEDED；已有活动收据的收敛必须持有当前未过期的 RUNNING claim，leaseOwner/fencingToken 匹配。每次领取恰递增 attemptCount/fencingToken，租约有界至60秒。终态 completedAt 以数据库 auth_now() 规范化，expiresAt 至少该时刻后24小时且不能缩短；活动收据不因 TTL 过期而删除。

KeyRotationRun 引用既有 AdminCommandReceipt 和 ApiKeyConfig，receiptId 唯一，所有 FK 均 Restrict。stage 为 PREPARING/TESTING/READY/ACTIVATED/ABORTED；prepare 结果须先落库，再由后续消费者执行测试和推进。当前 candidateIdsJson 固定 `[]`，baseRevisionsJson 只存安全 ID 与非负 revision，checkpointJson 精确为 `{version:1,fencingToken,step}`，没有任意候选或秘密正文。旧 key 须 ACTIVE 且版本匹配，可选新 key 须同 provider 的既存 DISABLED 行。

reserve/claim/prepare/checkpoint helper 都操作真实数据库。首次准备与其收据必须在调用方同一事务中保存，部分准备失败整笔回滚；进程恢复后重取 claim，按已持久化 checkpoint 续接，过期 lease 或旧 fencingToken 无法推进。当前 helper 不创建 key、不切换引用、不执行外呼，也没有 ACTIVATED 业务接口。Phase013 消费管理密钥能力，Phase015 注册真实引用 adapter，Phase016 才接共享 worker。

轮换 run 当前禁止 DELETE/TRUNCATE，关联收据不能因24小时最低期已过而删除。尚无密钥审计到期清理协议，故保留 run→receipt/key 的 FK 链；这不等于已经实现自动清理或生产保留策略。

## 验证与阶段交付

本卡固定七组场景，冻结输入、source hash 和原始命令收据按 attempt 保存。使用任务专属 PostgreSQL17、独立最小权限应用连接、实际 Auth.js Cookie/CSRF 与 Route Handler；浏览器场景启动真实构建。测试凭据和 canary 仅留在被忽略的本地准备区，原始输出在归档前扫描，报告不包含密码、token、Cookie、密文或真实用户资料。

| 场景键                    | 主要验证                                                             |
| ------------------------- | -------------------------------------------------------------------- |
| list                      | 筛选、limit、签名 cursor、相同 createdAt 的稳定分页、SQL/DTO 白名单  |
| role-status               | GET→PATCH、CAS 并发、同值、版本与审计原子性、lastLoginAt 不制造冲突  |
| self-protection           | 自改 role/status 被拒绝，所有相关表零变化                            |
| last-admin                | 单管理员保护和多管理员并发，提交后至少一位 ACTIVE ADMIN              |
| session                   | 变化撤销所有旧会话、旧 Cookie 下一请求失败、同值不递增               |
| authorization-idempotency | 未授权/停用/旧会话/CSRF、重启重放、异正文、并发终态与部分准备回滚    |
| navigation                | 唯一 shell/菜单、真实链接、登录隔离、重定向、375px、键盘焦点与无障碍 |

在计划已冻结、专属数据库准备完成且工具版本匹配后，依次运行：

```powershell
node docs/phase-plans/verify-phase012.mjs --case list
node docs/phase-plans/verify-phase012.mjs --case role-status
node docs/phase-plans/verify-phase012.mjs --case self-protection
node docs/phase-plans/verify-phase012.mjs --case last-admin
node docs/phase-plans/verify-phase012.mjs --case session
node docs/phase-plans/verify-phase012.mjs --case authorization-idempotency
node docs/phase-plans/verify-phase012.mjs --case navigation
node docs/phase-plans/verify-phase012.mjs --quality
```

quality 汇总相关单元/集成测试、旧阶段受影响回归、lint/typecheck/format/build、目录、迁移、API 生成区与证据校验。反向验证在隔离副本临时移除最后管理员复核或 sessionVersion 递增，原断言必须失败，恢复后重新通过；冗余 guard 不能遮蔽应检测的缺陷。测试命令是待执行或可复验的入口，本说明不预先声明其结果。

失败保留原始 attempt 与诊断，使用 `node docs/phase-plans/complete-phase012.mjs --retry` 创建本卡下一尝试，不覆盖历史记录或提前移动 run state。完整七组、补充质量检查及独立 agent 复核一致后，由主 agent 审核差异并提交 artifact；再以 `--metadata` 生成对应 Gate/run state/完成记录并提交直接子 metadata。最后在 PowerShell5.1 和 PowerShell7 执行 `scripts/validate-phase.ps1 -CompletedThrough 12 -Strict -Json`，确认工作树干净、推送成功且远端包含 metadata 提交。仅完成本卡，不自动执行 Phase013。

实现快照以阶段起点为基准，显式使用 `git diff --no-renames`，同时记录移动前路径的删除和移动后路径的内容，保证未暂存、已暂存与已提交时的绑定一致。若 artifact 后生成 metadata 失败，失败收据保留真实 artifactCommit、原命令与原脚本字节；恢复校验核对实际 Git 对象、旧计划、质量与复核报告，不回写既有报告。该未封口提交进入最终 Gate 的 recoveryCommits，修复后重新验收并创建新的 artifact→metadata 直接父子提交。
