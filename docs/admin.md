# Serendipity · 际遇 管理权限与审计契约

Owner: 管理治理；producerPhase: 2；实现消费者: Phase012–015、Phase089–100。本文件拥有管理权限、revision、原子审计和轮换协调规则；端点与 exact DTO 仅由 [API 契约](api.md) 生成，模型字段仅由 [数据库规范](database.md) 定义。认证、密钥和隐私分别消费 [auth](auth.md)、[crypto](crypto.md)、[privacy](privacy-and-user-data.md)。固定路线输入的来源与 hash 见 [输入清单](phase-plans/Phase002-inputs.json)。

## 权限与页面边界

每个管理 Route Handler/Server Action 在任何资源查询前调用 requireAdmin，复核活动数据库会话、ACTIVE ADMIN 与 sessionVersion。写入继续校验 CSRF、Schema、幂等和 CAS。未登录为 AUTH_REQUIRED，非管理员为 FORBIDDEN；不向未授权请求泄露对象是否存在。后台权限不能代替私人行程 owner、分享 token、文件 purpose/usage 或隐私水位授权。

Phase012 的 `src/app/admin/(protected)/layout.tsx` 复用唯一 `src/components/layout/admin-shell.tsx`；根 admin layout 保持中性，`src/app/admin/(public)/login/page.tsx` 不带后台 shell。唯一菜单数组为 `src/components/admin/admin-nav.ts`，当前只含 `/admin/users` 与退出动作。受保护 `/admin` 确定性重定向用户管理，Phase014 首产 Dashboard 后才切换。当前高亮采用完整路径或 `href + '/'` 前缀的最长匹配；导航支持折叠、方向键、Home/End、Escape 回到开关，以及跳到主要内容。

## 用户与配置 CAS

用户管理读取 ADMIN_USER_FIELDS，响应携带 User.revision；不读回 passwordHash/sessionVersion/phone。PATCH 的 expectedVersion 对比 revision，reason 经 trim 后为 1–500 字符。先比较 CAS，再判断同值；同值返回当前安全摘要，不增加 revision/sessionVersion、不伪造变化审计。

Phase012 列表、更新和版本冲突统一使用九字段管理摘要；列表固定 `(createdAt DESC,id DESC)`，签名游标绑定管理员、筛选、排序和首次读取水位。UI 保存读取到的 revision，同一待重试正文复用幂等键；409 显示最新安全摘要、关闭旧编辑并要求重新选择操作，不自动覆盖另一管理员的修改。加载、空列表、服务错误分别展示；窄屏只在表格区域横向滚动。

在 Serializable 事务内锁定目标与 ACTIVE ADMIN 集合，拒绝改变自己的 role/status，任何提交后至少保留一个 ACTIVE ADMIN。role/status 实际变化时同事务将 revision、sessionVersion 各加一、撤销全部活动 AuthSession、完成幂等收据并追加 USER_UPDATE AuditLog。CAS、审计或收据失败全部回滚。两个管理员并发处理最后两个管理员时，同一约束仍成立。

实际服务先取固定 advisory transaction lock，再按 id 顺序锁定活动管理员、actor 和 target，在持锁事务内重新检查 actor 会话及最后管理员数量。仅 serialization、deadlock 与幂等唯一约束竞争进入有界重试；授权、CAS 和审计校验失败不重试成成功。变化审计记录 before/after 的 role、status、revision 与 `sessionVersionIncremented=true`，不记录版本秘密值；reason 沿用隐私自由文本规则，全文替换为 `***`。同值路径先回滚严格审计事务，再以独立 Serializable 事务重新锁定、授权、重查收据与 CAS，只持久化安全成功收据，保持既有审计事务必须包含成功审计的约束。

SystemConfig 的 expectedVersion 比较自己的 revision；updatedAt 只展示。公开配置同时通过 isPublic 和 key 白名单，不准将 Prompt、模型、Provider 或秘密放进 SystemConfig。Phase015 的不可变 PromptVersion/ModelDeployment/ProviderConfigVersion 不原地改写，activatePromptModelTuple 锁定两个 activation，比较共同 revision 并一起加一；PlanningPolicyActivation 使用自身 revision。后期 rollout/停用/回滚继续使用同一治理服务。

## 幂等、轮换与审计

Phase012 首次生产 AdminCommandReceipt、KeyRotationRun，Phase013 复用；Phase016 才注册同一执行器到共享 worker，不提前查询后期任务表。收据域为 ownerUserId/operationId/resourceId/idempotencyKeyHash，requestHash 只包含验证后的非秘密字段与必要 fingerprint。相同 key/hash 重放安全结果；异 hash 返回 409，业务写入为零。活跃收据不按 TTL 过期，终态至少保留 24 小时，轮换收据跟随关联密钥审计期限。

用户更新的 operationId 固定为 `patch.admin.users.id`。首次调用先校验 CAS；终态重放在当前授权之后、原 CAS 之前读取原九字段结果，以响应头 `Idempotency-Replayed: true` 标识，首次成功为 `false`，不扩充 DTO。同步用户命令可直接在业务事务内插入 SUCCEEDED；其他已存在的活动收据只有当前未过期 RUNNING claim 可收敛，leaseOwner/fencingToken 必须匹配。终结时间使用数据库 `auth_now()`，保留截止不得早于该时刻加24小时，终态响应不可改写。

Phase012 只实现 reserve/claim/prepare/checkpoint 持久化基础。prepare 与相应收据在同一事务中保存，失败整笔回滚；后续执行者先重取有效 claim 再续接已保存进度，旧 fence 不能推进。当前 candidateIdsJson 固定 `[]`，尚无 Phase015 adapter；旧密钥与可选新密钥使用现存 ApiKeyConfig FK。KeyRotationRun 当前拒绝 DELETE/TRUNCATE，关联收据也不能被 TTL 删除；专用密钥审计到期清理协议交付前保留整条引用链。以下轮换、紧急撤销和审计查询规则由后续卡消费，不代表本卡已提供这些页面、API、外部连接测试或密钥切换。

常规轮换先持久化一个 DISABLED 候选与候选配置，记录 stage 和候选 ID；受控连接测试在事务外执行，失败保持旧 key/activation 可用。通过后在 Serializable 事务内复核旧 key revision、完整引用集合和各 activation revision，再启用新 key、切换全部引用、撤销旧 key、完成收据和审计。引用增减、旧 key 被紧急撤销、CAS 或审计失败均拒绝部分切换。Phase013 没有 Provider 表时真实引用集合为空，Phase015 创建模型时同步注册真实 KeyReferenceAdapter；禁止用空集合绕过届时已存在的引用。

紧急 REVOKED 是独立受审命令，立即阻止新调用，不等待常规轮换；REVOKED 永不可恢复。KeyRotationRun 的 PREPARING/TESTING/READY/ACTIVATED/ABORTED 仅为轮换阶段，不复用 ApiKeyStatus。密文、版本正文与已完成收据保持不可变。

AuditLog append-only，关键变更与审计同一数据库事务提交，失败不能 best-effort 成功。记录受控 actor/target/action/requestId/traceId/time/result/reason 与安全版本差异；日志、trace 和查询响应递归移除秘密及私人原文。审计查询使用固定白名单 filter、opaque cursor、唯一 tie-breaker 和最大 100 条；不得把审计查询作为登录限流计数。擦除使用专用角色按隐私契约去标识，不授应用角色任意修改历史的能力。

## 可执行规则与验证

<!-- contract:admin-policy -->
```json
{
  "schemaVersion": 1,
  "producerPhase": 2,
  "guard": "DATABASE_ACTIVE_ADMIN_BEFORE_RESOURCE_QUERY",
  "privateDataRequiresOwner": true,
  "userUpdate": {"casField": "revision", "requestField": "expectedVersion", "minActiveAdmins": 1, "allowSelfRoleStatusChange": false, "isolation": "Serializable", "reasonMinLength": 1, "reasonMaxLength": 500, "checkCasBeforeNoop": true, "noopIncrements": false, "changeRevisionIncrement": 1, "changeSessionVersionIncrement": 1, "revokeActiveSessions": true},
  "configUpdate": {"casField": "revision", "updatedAtIsCas": false, "publicRequiresKeyAllowlist": true, "immutableVersions": true, "tupleActivation": "activatePromptModelTuple", "tupleRevisionShared": true},
  "receipt": {"producerPhase": 12, "scope": ["ownerUserId", "operationId", "resourceId", "idempotencyKeyHash"], "minimumTerminalHours": 24, "activeExpires": false, "samePayload": "REPLAY_SAFE_RESULT", "differentPayload": "409_IDEMPOTENCY_KEY_REUSED"},
  "rotation": {"candidateStatus": "DISABLED", "networkInsideTransaction": false, "referenceSetRechecked": true, "allReferencesSwitchAtomically": true, "emergencyRevokeImmediate": true, "historyOverwritten": false},
  "audit": {"appendOnly": true, "sameTransaction": true, "failure": "ROLLBACK", "paginationMax": 100, "tieBreaker": "id", "loginThrottleAuthority": false}
}
```

`Phase002:api` 解释这些规则，覆盖自己/最后管理员、版本过期/同值、审计失败、引用集合变化与撤销终态；临时删除守卫规则必须非零。文档 fixture 不替代 Phase012/013 的真实事务并发与权限测试。

Phase012 的实际验收入口、七组固定场景、真实 PostgreSQL/浏览器与反向验证要求见 [阶段说明](phase012.md)。本文件描述实现和消费契约，是否完成以对应 attempt、Gate、双提交和 seal 为准。
