# Serendipity · 际遇 管理权限与审计契约

Owner: 管理治理；producerPhase: 2；实现消费者: Phase012–015、Phase089–100。本文件拥有管理权限、revision、原子审计和轮换协调规则；端点与 exact DTO 仅由 [API 契约](api.md) 生成，模型字段仅由 [数据库规范](database.md) 定义。认证、密钥和隐私分别消费 [auth](auth.md)、[crypto](crypto.md)、[privacy](privacy-and-user-data.md)。固定路线输入的来源与 hash 见 [输入清单](phase-plans/Phase002-inputs.json)。

## 权限与页面边界

每个管理 Route Handler/Server Action 在任何资源查询前调用 requireAdmin，复核活动数据库会话、ACTIVE ADMIN 与 sessionVersion。写入继续校验 CSRF、Schema、幂等和 CAS。未登录为 AUTH_REQUIRED，非管理员为 FORBIDDEN；不向未授权请求泄露对象是否存在。后台权限不能代替私人行程 owner、分享 token、文件 purpose/usage 或隐私水位授权。

Phase012 接入唯一 AdminShell，受保护布局与公开登录布局分开。菜单只列已经可到达的页面；012 的 /admin 指向用户管理，014 首产 Dashboard 后才切换。不提前放置死链接、预览后门或另一份导航数组。本卡仅冻结职责，不创建这些页面。

## 用户与配置 CAS

用户管理读取 ADMIN_USER_FIELDS，响应携带 User.revision；不读回 passwordHash/sessionVersion/phone。PATCH 的 expectedVersion 对比 revision，reason 经 trim 后为 1–500 字符。先比较 CAS，再判断同值；同值返回当前安全摘要，不增加 revision/sessionVersion、不伪造变化审计。

在 Serializable 事务内锁定目标与 ACTIVE ADMIN 集合，拒绝改变自己的 role/status，任何提交后至少保留一个 ACTIVE ADMIN。role/status 实际变化时同事务将 revision、sessionVersion 各加一、撤销全部活动 AuthSession、完成幂等收据并追加 USER_UPDATE AuditLog。CAS、审计或收据失败全部回滚。两个管理员并发处理最后两个管理员时，同一约束仍成立。

SystemConfig 的 expectedVersion 比较自己的 revision；updatedAt 只展示。公开配置同时通过 isPublic 和 key 白名单，不准将 Prompt、模型、Provider 或秘密放进 SystemConfig。Phase015 的不可变 PromptVersion/ModelDeployment/ProviderConfigVersion 不原地改写，activatePromptModelTuple 锁定两个 activation，比较共同 revision 并一起加一；PlanningPolicyActivation 使用自身 revision。后期 rollout/停用/回滚继续使用同一治理服务。

## 幂等、轮换与审计

Phase012 首次生产 AdminCommandReceipt、KeyRotationRun，Phase013 复用；Phase016 才注册同一执行器到共享 worker，不提前查询后期任务表。收据域为 ownerUserId/operationId/resourceId/idempotencyKeyHash，requestHash 只包含验证后的非秘密字段与必要 fingerprint。相同 key/hash 重放安全结果；异 hash 返回 409，业务写入为零。活跃收据不按 TTL 过期，终态至少保留 24 小时，轮换收据跟随关联密钥审计期限。

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
