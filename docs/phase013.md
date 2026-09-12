# Phase013 管理员密钥生命周期与审计读取

本阶段在现有后台增加密钥管理与只读审计查询。复用 ApiKeyConfig、AdminCommandReceipt、KeyRotationRun、AuditLog、requireAdmin 和唯一 AdminShell。输入、六个固定业务场景及执行范围分别见 [冻结计划](phase-plans/Phase013.json) 和 [输入收据](phase-plans/Phase013-inputs.json)。本说明描述实现；完成状态以当前 attempt 的真实报告、Gate、artifact/metadata 双提交与双 shell seal 为准。

## 密钥录入与展示

`/admin/api-keys` 支持录入、改名、停用、启用、常规轮换和紧急撤销。每次页面和 API 请求都重新验证当前数据库中的 ACTIVE ADMIN、ADMIN audience、会话状态、期限和 sessionVersion。列表按 provider/status 筛选，以 `(createdAt DESC,id DESC)` 分页；默认20条，上限100。签名游标绑定管理员、筛选、页大小、排序和首屏时间水位。

所有管理结果精确为十字段 `id/name/provider/keyFingerprintDisplay/status/revision/lastUsedAt/revokedAt/createdAt/updatedAt`。数据库列表投影直接取 fingerprint 前12字符加 `…`，不把完整 fingerprint 或 envelope 读入列表对象；终态收据重放再次经过相同字段白名单。所有响应使用 `Cache-Control: no-store`。

密钥输入使用无受控 value 的 password 控件；提交函数短暂读取原值，提交后立即清空，取消、成功和失败也不会保留原值。重试状态只保留请求摘要和幂等键；响应丢失后重新输入相同正文，复用原键取得原结果。JavaScript string 不保证内存清零，因此实现只承诺不缓存、不回显并缩小持有范围。录入、轮换拒绝把本次明文嵌进 name/provider；改名拒绝与当前密钥完整指纹匹配的名称。

`src/server/security/secret-envelope.ts` 为 server-only 模块，复用 Phase010 exact schema、规范化与 AAD。服务先生成记录 ID，再以 JCS UTF-8 `{recordId,provider,envelopeVersion}` 作为 AES-256-GCM AAD。每次使用新的12字节随机 IV 和16字节 tag。主密钥标识为解码后32字节 ENCRYPTION_KEY 的 SHA-256；密钥去重指纹另取规范化 plainKey 的 SHA-256。版本、算法、canonical base64、长度、列绑定、未知主密钥或 GCM 认证任一失败均关闭解密，内部统一 `SECRET_DECRYPT_FAILED`，公开仅 `CONFIG_ERROR`。

## 状态、幂等与事务

写请求依次经过管理员守卫、CSRF、幂等和 exact schema 校验。URL 是旧密钥身份的唯一来源；PATCH/rotate 的 `expectedVersion` 比较 revision，拒绝正文中的重复身份和未知字段。普通创建返回201，更新返回200，轮换返回202；`Idempotency-Replayed` header 标明是否读取原收据。

ACTIVE 可停用或撤销，DISABLED 可启用或撤销；REVOKED 永不能恢复，revokedAt 非空且不可更改。实际名称/状态变化恰递增一次 revision，并与对应审计和成功收据在 Serializable 事务中提交。同值且版本匹配只保存安全收据，不伪造变化审计。版本冲突返回409，界面关闭旧编辑并要求重新选择操作。尚未完成轮换的候选不得通过普通 PATCH 启用。

幂等域沿用 `ownerUserId/operationId/resourceId/idempotencyKeyHash`。创建和轮换的 requestHash 使用经过校验的非秘密字段及必要完整 fingerprint 的 JCS SHA-256，不保存 plainKey；PATCH 使用规范化名称、状态和版本。同键同正文跨进程重放原安全结果，异正文409且零业务写入。每次重放仍先验证当前授权。审计、CAS、收据或引用更新失败均回滚业务事务。

## 轮换与引用适配

`KeyRotationCoordinator` 通过强类型 `KeyReferenceAdapter` 列出全部活跃引用及 revision，持久化不可变配置候选，并进行候选测试与激活。当前尚无 Provider 表，真实 registry 为空；零引用轮换仍实际解密并验证候选 envelope。两引用验收使用独立 PostgreSQL fixture schema 和真实 loopback HTTP。Phase015 创建 Provider 模型时必须注册真实 adapter，并重跑同组集成测试。

同一幂等键只准备一组候选：新密钥以 DISABLED 落库，旧密钥与 activation 保持原状。KeyRotationRun 绑定候选 ID、引用集合 hash、各基线 revision 和受 fencing 保护的 checkpoint。候选连接测试在数据库事务外运行；只有已授权、归属本次 run 的 DISABLED 候选可进入该测试。统一 client 校验目标 inventory、协议、DNS/连接地址、响应大小、超时与候选版本/hash，拒绝重定向及原始外部响应回显。普通调用每次重新检查 ACTIVE，不缓存解密结果。

测试失败保留禁用候选、安全错误和可追溯的 run；收据进入 RETRY_WAIT，同键重试继续使用相同候选。测试通过后，在一个 Serializable 事务内重新核对旧密钥 revision、完整引用集合和每条 activation revision，启用新密钥、切换全部引用、撤销旧密钥、完成幂等收据并追加审计。准备候选对应 API_KEY_CREATE；最终新密钥启用对应 API_KEY_UPDATE，旧密钥撤销对应 API_KEY_ROTATE。第二条 activation、最终审计或收据失败时整笔回滚，候选保持禁用。独立紧急撤销不等待网络测试；常规轮换遇到已撤销旧密钥返回409。

Phase012 的 candidateIdsJson 固定空数组约束无法表达所需的两引用验收，本阶段以追加迁移 `20260912061403_key_rotation_contract` 修复既有表的 SQL 合同，保留此前七份迁移原字节和 Prisma 模型。候选 JSON 精确为 `adapterId/referenceId/candidateId/configVersion/referenceRevision/contentHash`，最多127项；checkpoint 在原三个字段上只允许可选安全 errorCode/verificationHash。没有新增产品表、第二套秘密存储或未来治理页面。

## 审计与错误界面

`/admin/logs` 只读查询 action、actorId、targetType、targetId、from/to；GET 参数总长最多4096，默认20条，上限100。时间必须是真实 RFC3339 时刻。opaque 游标签名绑定当前管理员、筛选、页大小、固定排序和时间水位，`id` 为唯一 tie-breaker；篡改、跨管理员或跨筛选复用均拒绝。

查询只读取必要字段，排除 actorEmailSnapshot、ipHash 和 userAgentSummary；详情复用 Phase009 `sanitizeAuditDetail`，并再次隐藏 seed 与账号/网络关联摘要。输出精确为 `id/actorType/actorId/targetType/targetId/action/requestId/traceId/createdAt/safeSummary`。safeSummary 以文本显示，最多4000字符；无详情明确显示“未记录详情”，不推断成功。查询开始和返回前均复核会话；数据库故障返回503并显示可重试错误，不冒充空列表。

根 not-found 与 client error 页面只显示固定安全文案。后台继续使用一个导航与 shell，包含用户、密钥和审计入口；窄屏表格只在区域内部滚动，保留键盘导航、焦点返回与跳到主要内容。

## 验证与封口

安全边界和共享持久化发生变化，依 [测试执行政策](testing-execution-policy.md) 使用 `testMode=full`，跨 attempt 结果复用关闭。诊断先运行失败项及受影响测试，候选稳定后通过 `node docs/phase-plans/verify-phase013.mjs --all` 执行冻结验收。专用命令为 `npm run test -- admin/api-keys admin/logs secret-envelope`；仓库全量、lint、typecheck、format、build、真实 PostgreSQL、浏览器和基础设施反向验证均另有实际报告。

业务分母固定六项：create-read、disable-enable、rotate-revoke、authorization、crypto-redaction、failure-atomicity。必须6/6，未授权业务写入与秘密泄漏均为0；每个场景映射到原始测试报告的具体断言。反向验证在隔离副本中破坏管理员守卫、AAD、撤销终态和安全投影，必须真实变红，恢复后重跑本卡完整集合。

浏览器覆盖真实登录与未授权读取、创建、停用/启用、轮换/撤销、审计筛选分页、375/1280宽度与键盘操作、数据库读取故障恢复、退出和安全页面。自动 axe 检查不代表真人读屏体验。动态 canary 扫描 HTTP、数据库安全投影、日志、审计、trace、HTML、storage 与最终证据；合成秘密只存于被忽略的准备区，不归档原始请求正文。

最终独立 reviewer 复核受测源码、断言、报告和截图，并绑定当前 planHash。全部通过后提交 `phase(013): artifact`，再生成 Gate、run state 与完成日志并提交其直接子 `phase(013): metadata`。PowerShell 5.1 与7严格 seal 均通过、工作树干净且远端包含 metadata 后才算完成任务013。本次授权不执行任务014。
