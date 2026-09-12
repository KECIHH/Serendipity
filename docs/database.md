# Serendipity · 际遇 数据库规范

本规范是 Phase001 产出的唯一项目数据库设计。authority 顺序为用户范围/根布局规则、冻结 manifest 与 PRD、canonical/术语/状态机、本文件、生产卡的 Prisma 实现。来源 SHA-256 固定在 `docs/phase-plans/Phase001-inputs.json`；本地任务卡仅用于只读校对。根 `docs/project-constitution.md` 的14项决策由根执行契约展开，版本/审计/匿名/鉴权/秘密设计均须同时满足。

本卡不创建 `prisma/schema.prisma`、数据库、迁移、seed 或业务代码。Phase006 起每次建模先同步本文件再生成对应迁移，按登记的 producerPhase 首次建表，不能提前建无外键半模型。相应 producer 到来时，注册表中每个实际持久模型须可定位到其 Prisma schema；未到生产阶段时映射状态为 NOT_CREATED，不把本文的设计当已运行数据库的证据。PrivacyRevocationLedger 使用独立 PostgreSQL 数据库和独立 Prisma schema/Client，不与应用库共用恢复集合。

## 模型首次生产登记

本表固定本路线已命名持久模型的唯一首次生产阶段；`schemaPath` 是相应生产阶段必须实现的目标，并不表示 Phase001 已创建 Prisma。所有路径相对外层 projectRoot=repositoryRoot，`source` 中任务卡仅作为本地只读契约来源。`?` 表示可空，未标 `?` 的身份与关系必填；没有生命周期的不可变事实不增设 status。同记录引用除存在性外必须验证所属记录，版本复合引用不得退化为只验证单列 id。

<!-- model-registry:start -->
| model | producerPhase | identity | relations+nullable | status | immutability | deletion | publicProjection | schemaPath | source |
|---|---|---|---|---|---|---|---|---|---|
| `User` | 6 | id PK；normalizeEmailV1(email) unique；revision>=0 | phone/name/avatarUrl/lastLoginAt 可空；6 时 email/passwordHash 必填；84 擦除壳才允许两者为空 | role=USER/ADMIN；status=ACTIVE/DISABLED | id 不变；role/status 实变时 revision 与 sessionVersion 原子递增 | 普通路径禁物理删除；84 专用 ERASE 清除身份并保留不可恢复 DISABLED 壳 | PUBLIC_USER_FIELDS 为 id/email/name/avatarUrl/role/status/lastLoginAt/createdAt，仅授权账户上下文；ADMIN 加 revision；share/public 不含用户 | prisma/schema.prisma#User | Phase006/007/012/084；canonical 2 |
| `SystemConfig` | 7 | id PK；key unique；revision>=0 | updatedBy? -> User，SetNull；description 非空；valueJson 必填 | 无生命周期；group CHECK=AI/UI/EXPORT/SECURITY/GENERAL | key 身份不变；valueJson 以 revision CAS 更新并同事务审计 | 不级联删除 User；受控删除需验证配置无消费者 | 仅 isPublic=true 且命中配置白名单的 key/value；排除秘密和治理正文 | prisma/schema.prisma#SystemConfig | Phase007/014；canonical 2.2 |
| `TravelRecord` | 8 | id PK；version>=0；25 增 requirementRevision 独立 CAS | userId? -> User Restrict 与 anonTokenHash? 恰一非空；requirementJson?；25 增 currentPlanVersionId?/finalPlanVersionId? -> 同记录版本 | DRAFT/NEEDS_INFO/PLANNED/MODIFIED/FINALIZED/NEEDS_REVALIDATION/ARCHIVED | 不含 planJson；current 与 version 同事务移动，final 不跟随 current；CLONE 目标固定 NEEDS_REVALIDATION | ARCHIVED 只读不可恢复；84 专用 ERASE；禁止 owner 删除级联误删他人副本 | owner 安全摘要；share/public 只经指定版本 PlanViewModel，不暴露 owner/需求 | prisma/schema.prisma#TravelRecord | Phase008/025/062/085；PRD 5；state-machines 1 |
| `ChatMessage` | 8 | id PK；(travelRecordId,sequence) unique；非空 (travelRecordId,clientMessageId) unique | travelRecordId -> TravelRecord Cascade；replyToMessageId? -> 同记录消息 SetNull；contentJson?/clientMessageId?；16 增 commandId? | role=USER/ASSISTANT/SYSTEM；kind=TEXT/STRUCTURED | sequence>0；消息追加；命令 USER 和最终 ASSISTANT 各最多一条 | 普通业务禁单条删除；专用 record purge 才 Cascade，保留脱敏审计 | 仅当前 owner；不进入 share/public/公开导出 | prisma/schema.prisma#ChatMessage | Phase008/016 |
| `AuditLog` | 9 | id PK；requestId/traceId 可检索，非唯一 | actorId? -> User SetNull；actorEmailSnapshot?/targetId?/requestId?/traceId?/detailJson?/ipHash?/userAgentSummary? | 无生命周期；action 使用封闭 action registry | append-only；运行期数据库角色禁止 UPDATE/DELETE | 专用 retention/ERASE 去标识流程；禁止业务删除审计；actor 邮箱按隐私规则清除 | 仅 requireAdmin 脱敏投影；不含密钥、token、完整 Prompt 或私人原文 | prisma/schema.prisma#AuditLog | Phase009；根 agent-execution-contract 审计规则 |
| `ApiKeyConfig` | 10 | id PK；keyFingerprint unique；revision>=0 | 无 userId；lastUsedAt?/revokedAt?；secretRef 的目标 | ACTIVE/DISABLED/REVOKED | encryptedKey/versioned envelope 不原地覆盖；轮换新行；REVOKED 终态 | 被治理引用时 Restrict；撤销后按密钥审计保留规则清理 | ADMIN 仅安全名称、provider、状态、派生短 fingerprint、revision；永不读回明文/envelope | prisma/schema.prisma#ApiKeyConfig | Phase010/013；canonical 2 |
| `AuthSession` | 11 | id PK；tokenHash unique | userId -> User；revokedAt?；绑定 audience/sessionVersion/issuedAt/expiresAt | ACTIVE/REVOKED/EXPIRED | tokenHash/归属/会话代数不改；两终态不可恢复 | 退出先撤数据库行；过期保留及 ERASE 按隐私契约，禁止重新激活 | 仅受控会话状态；不返回 tokenHash/sessionVersion | prisma/schema.prisma#AuthSession | Phase011；state-machines 9 |
| `AuthLoginAttempt` | 11 | id PK；(scope,ipHash,createdAt) 与 (scope,accountHash,createdAt) 索引 | 无 User FK，支持不存在账户；completedAt?；ipHash/accountHash 为 HMAC | RESERVED/FAILED/SUCCEEDED/EXPIRED | RESERVED 只收敛一次；终态不可变；双 bucket advisory transaction locks | 活跃预留及限流窗口内失败不可删；TTL 后受控清理，成功不清失败历史 | 无公共投影；只返回不区分 bucket 的 Retry-After | prisma/schema.prisma#AuthLoginAttempt | Phase011；state-machines 9 |
| `AdminCommandReceipt` | 12 | id PK；(ownerUserId,operationId,resourceId,idempotencyKeyHash) unique | ownerUserId -> User；responseJson?/errorCode?/leaseOwner?/leaseUntil?/completedAt? | PENDING/RUNNING/RETRY_WAIT/SUCCEEDED/FAILED | requestHash/幂等域及终态响应不变；16 起租约仅由 DurableTask 协调 | 活跃记录不按 TTL 删；终态至少24h；轮换收据保留至密钥审计到期 | 仅授权 ADMIN 安全响应，不含秘密原文 | prisma/schema.prisma#AdminCommandReceipt | Phase012/013/016 |
| `KeyRotationRun` | 12 | id PK；receiptId unique | receiptId -> AdminCommandReceipt；oldKeyId -> ApiKeyConfig；newKeyId? -> ApiKeyConfig | stage=PREPARING/TESTING/READY/ACTIVATED/ABORTED | referenceSetHash/baseRevisionsJson 固定；checkpoint 受 fencing；ACTIVATED/ABORTED 终态 | 引用密钥/receipt Restrict；同密钥审计保留期 | ADMIN 仅进度/候选安全摘要；不含 key/envelope | prisma/schema.prisma#KeyRotationRun | Phase012/013；16 接共享 worker |
| `PromptDefinition` | 15 | id PK；key unique | 一个 definition 对多个 PromptVersion 和唯一两类 activation；无 nullable 身份 | 无生命周期 | key 与用途身份固定；正文只在版本 | 被版本/activation 引用时 Restrict，不建过渡表 | ADMIN 安全 key/purpose；不进入 share/public | prisma/schema.prisma#PromptDefinition | Phase015；canonical 2 |
| `PromptVersion` | 15 | id PK；(definitionId,version) 与 (definitionId,contentHash) unique | definitionId -> PromptDefinition；createdById? -> User；版本内容/variablesJson 必填 | 无生命周期；候选/激活状态不写版本行 | content/contentHash/schema/createdAt 全部不可变，数据库拒绝 UPDATE/DELETE | 正常业务 Restrict；保留全部引用历史；作者可匿名化 | 仅授权 ADMIN 编辑/比较；业务 DTO 不返回系统 Prompt | prisma/schema.prisma#PromptVersion | Phase015/090 |
| `PromptActivation` | 15 | definitionId PK/unique；revision>=0 | definitionId -> PromptDefinition；championVersionId -> 同 definition PromptVersion；updatedBy? -> User | 无独立生命周期；启停由配对 PromptModelActivation.status | 仅 activatePromptModelTuple 同事务更新两指针和共同 revision | 禁单侧更新/删除；引用版本 Restrict | 仅 ADMIN 配置摘要/统一 activationRevision | prisma/schema.prisma#PromptActivation | Phase015/090；canonical 2.2 |
| `ModelDeployment` | 15 | (id,configVersion) 复合 PK；contentHash 校验 | providerId 为 Provider 身份；实际调用经 activation 精确绑定 providerConfigVersion；createdById? | 无生命周期；不含 enabled/isDefault | providerModelName/paramsJson/capabilitiesJson/configVersion/createdAt 不可变 | 被调用/activation 引用时 Restrict；新配置新版本 | ADMIN 安全能力与版本摘要；不暴露 secret/baseUrl | prisma/schema.prisma#ModelDeployment | Phase015/091 |
| `ProviderConfigVersion` | 15 | (providerId,configVersion) 复合 PK | secretRef? -> ApiKeyConfig；NONE 必须 null；REQUIRED 必须 ACTIVE key；无明文凭据 | mode=MOCK/LIVE；credentialRequirement=NONE/REQUIRED；版本行无启停 status | baseUrl/paramsJson/策略/contentHash/createdAt 不可变；更新新 configVersion | 所有历史调用、事实和治理引用 Restrict | ADMIN 掩码配置；公开只允许安全来源信息，不含 endpoint/secretRef/envelope | prisma/schema.prisma#ProviderConfigVersion | Phase015/028/092；canonical 2.2 |
| `PromptModelActivation` | 15 | definitionId PK/unique；revision>=0 | definitionId/promptVersionId；(deploymentId,deploymentConfigVersion)；(providerId,providerConfigVersion) 精确 FK；updatedBy? | ACTIVE/DISABLED | 兼容元组与 PromptActivation 同事务 CAS，共同 revision；单次调用冻结一致快照 | 禁单侧删除/切换；引用历史版本 Restrict | ADMIN 安全完整元组和 activationRevision | prisma/schema.prisma#PromptModelActivation | Phase015/090/091 |
| `PlanningPolicyVersion` | 15 | id PK；version unique；contentHash 校验 | createdById? -> User；contentJson/schema 必填 | 无生命周期；状态不得回写版本 | 内容、单位、阈值、hash、createdAt 不可变 | 被 activation/run/trace/报告引用时 Restrict | ADMIN 策略摘要；普通用户仅适用规则的安全说明 | prisma/schema.prisma#PlanningPolicyVersion | Phase015/093 |
| `PlanningPolicyActivation` | 15 | policyKey PK；单例 active pointer；revision>=0 | activeVersionId -> PlanningPolicyVersion；updatedBy? -> User | 无独立生命周期 | 自身 revision CAS，不要求与 Prompt revision 数值相同 | activation 不因缓存 TTL 消失；引用版本 Restrict | ADMIN 指针/revision；不公开内部阈值 | prisma/schema.prisma#PlanningPolicyActivation | Phase015/093 |
| `AiOutputRecord` | 15 | id PK；(traceId,attemptNo) unique | travelRecordId?；promptVersionId -> PromptVersion；deployment/provider 均精确复合 FK；rawOutput?/errorMessage?/inputTokens?/outputTokens? | attempt 结果：SUCCEEDED/FAILED/CANCELLED；parsedOk 为独立布尔 | 每次 attempt 完成后追加；production rawOutput=null；精确版本不可改 | 跟随 trace/审计保留期；受引用时 Restrict；专用隐私清理原文 | ADMIN 脱敏状态/hash/token/duration；mock-debug 仅显式 capturePolicy 裁剪内容 | prisma/schema.prisma#AiOutputRecord | Phase001/015/018；attempt 终态为现有调用结果的派生细化 |
| `AiUsageReservation` | 15 | id PK；(traceId,attemptNo) unique | actualTokens?/actualCost?/providerRequestId?/settledAt?；绑定本 attempt 的计价/版本证据 | RESERVED/RECONCILING/SETTLED/RELEASED；submissionState=NOT_SENT/MAY_HAVE_BEEN_SENT/ACCEPTED | 上界与幂等域固定；结算/释放只一次；未知费用继续占额 | expiresAt 只触发对账，不能释放未知费用；结算证据按财务最小保留规则 | 无公共投影；ADMIN 仅聚合费用与安全对账状态 | prisma/schema.prisma#AiUsageReservation | Phase015；canonical 2.2；state-machines 16 |
| `ChatCommand` | 16 | id PK；(ownerKeyHash,kind,idempotencyKeyHash) unique | travelRecordId/userMessageId/payloadRef 必填；assistantMessageId?/errorCode?/errorMessage?/startedAt?/completedAt? | kind=PLAN_DRAFT/CHAT_MESSAGE；PENDING/RUNNING/COMPLETED/FAILED/CANCELLED | 接受输入/历史 ownerKeyHash 不变；终态不重开 | 活跃 payload pin；终态按隐私期；归属合并不改历史幂等域 | 仅当前 owner 安全状态/消息；无 share/public 投影 | prisma/schema.prisma#ChatCommand | Phase016/023/082；state-machines 3 |
| `ChatCommandEvent` | 16 | eventId PK；(aggregateId,sequence) unique | aggregateId -> ChatCommand；traceId 非空；payloadJson 按事件 schema | status 记录所属 ChatCommand 当次状态；type 是独立事件名 | append-only；assistant.delta/瞬时心跳不入库 | 持久 replay 窗口后按隐私清理；已引用终态收据先保留 | 仅合法 owner SSE 白名单，不含 payload 原文/秘密 | prisma/schema.prisma#ChatCommandEvent | Phase016；canonical 3 |
| `CommandIdempotency` | 16 | (ownerKeyHash,kind,idempotencyKeyHash) 复合 PK | commandId? -> ChatCommand；responseJson?；接受事务完成后 commandId 非空 | 与绑定 ChatCommand 的 PENDING/RUNNING/COMPLETED/FAILED/CANCELLED 对账 | requestHash/历史幂等域不改；终态响应不可变；不同请求 hash 为409 | 活跃命令不按 expiresAt 删除；终态重放保留按隐私期 | 仅原 owner 安全响应与 replayed；不返回 hash/原始幂等头 | prisma/schema.prisma#CommandIdempotency | Phase016/023/049；ChatCommand 状态的收据投影 |
| `DurableTask` | 16 | id PK；(kind,aggregateId) unique | payloadRef 指 TaskPayload 或已登记不可变业务输入；leaseOwner?/leaseUntil?/resultRef?/errorCategory? | PENDING/RUNNING/SUCCEEDED/FAILED/CANCELLED | 领取/心跳/提交校验租约和递增 fencingToken；终态不重开 | 仅无领域 pin 且达到 retention 的终态任务可清；ERASE 后继用新 task | 无公共表投影；领域 API 提供安全进度 | prisma/schema.prisma#DurableTask | Phase016；canonical 3.7；state-machines 14 |
| `TaskPayload` | 16 | id PK；contentHash/schemaVersion 校验 | ownerKeyHash 非空；所有引用为受控 tagged payloadRef；expiresAt 非空 | 无生命周期 | AES-GCM ciphertext 和已校验输入不可变；追加新输入不覆盖旧输入 | 版本、未消费澄清/clone 覆盖、未完成 ERASE 引用时禁止 TTL 清理 | 无公共投影，不进日志/SSE/导出 | prisma/schema.prisma#TaskPayload | Phase016/053/084/087；canonical 3.7 |
| `Outbox` | 16 | id PK；eventId unique | aggregateId/type/payloadHash/payloadJson 非空；publishedAt? | PENDING/DELIVERED | 事件内容不变；投递 ACK 可重试，至少一次投递 | 未交付/未完成对象删除不得清；终态按重放期保留 | 无公共投影；投递前另做目标权限投影 | prisma/schema.prisma#Outbox | Phase016；canonical 3.7 |
| `AiDebugRun` | 18 | id PK；idempotencyReceiptId/taskId/traceId 各 unique | adminUserId -> User；idempotencyReceiptId -> AdminCommandReceipt；taskId -> DurableTask；payloadRef；finalSummaryJson?/errorCode?/completedAt? | PENDING/RUNNING/SUCCEEDED/FAILED/CANCELLED | 输入/trace 不变；终态不重开；attempt 只关联015记录 | 活跃输入 pin；终态按 debug retention 删除，审计只留脱敏摘要 | 仅 ADMIN 安全状态/attempt 引用；GET 零外呼 | prisma/schema.prisma#AiDebugRun | Phase018 |
| `TravelPlanVersion` | 25 | id PK；(travelRecordId,version)、(id,travelRecordId)、(id,travelRecordId,version) unique | travelRecordId -> TravelRecord；workspaceSnapshotId -> 同记录 PlanWorkspaceSnapshot；traceId -> 唯一 PlanTrace；factSnapshotRefs 在30接真实快照；无可空正文/三个hash | qualityStatus=pass/needs_review/fail/revalidation_required；trigger=GENERATE/MUTATION/REPLAN/RESTORE/CLONE/REVALIDATE | planJson 是正式正文唯一存储；三hash固定顺序；正常版本不得 fail；revalidation_required 仅 CLONE version1；25只建表，49首存业务v1 | 数据库禁止普通 UPDATE/DELETE；被引用上下文同保留期；仅84专用ERASE处理私人正文 | 只经 PlanViewModel owner/share/public 分支；公开需目标 PlanFinalization 与当前资格 | prisma/schema.prisma#TravelPlanVersion | Phase025/049/087；canonical 2/3.3 |
| `PlannerRun` | 25 | id PK；traceId unique；同记录活动 PLAN run 排他 | travelRecordId?；PLAN必须有record；workspaceSnapshotId? -> PlanWorkspaceSnapshot；payloadRef必填；completedAt?/错误字段? | PENDING/RUNNING/SUCCEEDED/BLOCKED/FAILED/CANCELLED；purpose=PLAN/FACT_EVALUATION | 接受时 expectedVersion/expectedRequirementRevision/配置快照固定；终态不重开 | 活跃run及版本依赖不可清；终态按领域保留；FACT_EVALUATION不写版本/record | 当前owner安全阶段/错误/结果引用；不公开输入/trace内部内容 | prisma/schema.prisma#PlannerRun | Phase025/026；state-machines 2 |
| `PlanTrace` | 25 | id PK；traceId/attemptId/plannerRunId 各 unique；planVersionId 非空时 unique | plannerRunId -> PlannerRun；travelRecordId?/planVersionId?/policyVersionId?/requirementRevision?/completedAt?/finalDecision?/errorCategory? | RUNNING/SAVED/EVALUATED/REJECTED/FAILED/CANCELLED | 26每attempt同事务创建；成功版本同事务CAS为SAVED；EVALUATED仅FACT_EVALUATION且版本为空；终态不重开 | 最小trace与所绑版本同保留；普通删除受限；97只扩事件/索引/retention | owner仅安全状态引用；ADMIN受权脱敏诊断；share/public无trace | prisma/schema.prisma#PlanTrace | Phase025/026/049/097；state-machines 8 |
| `PlanWorkspaceSnapshot` | 25 | id PK；(plannerRunId,revision) 与 (id,travelRecordId) unique | plannerRunId -> PlannerRun；travelRecordId? 仅事实评测可空；contentJson/requirementHash/contentHash/schemaVersion 必填 | 无生命周期；stage为当前已生产流水线checkpoint标签，不是可变status | contentJson含需求、日身份、假设、锁和上下文；追加revision；绑定版本后永久不可改 | 被版本引用时与版本同保留，禁止按task TTL清理；专用ERASE例外 | 仅当前owner内部恢复；不进入share/public/公开导出 | prisma/schema.prisma#PlanWorkspaceSnapshot | Phase025；canonical 3.7；术语七 |
| `FactSnapshot` | 30 | id PK；collectionAttemptId unique；querySetHash/contentHash 不unique | plannerRunId -> PlannerRun；traceId绑定同run；facts/sourceCatalog/providerPolicy等放受校验JSON；来源引用限同snapshot | 无生命周期；嵌入FactStatus=verified/estimated/unknown/conflicting/stale | 一经采集即不可变；新刷新新collectionAttemptId与snapshot，即使内容hash相同 | 版本/run引用时Restrict且同保留；缓存淘汰不得删除；ERASE按主体范围 | PlanViewModel只投影安全事实与SourceSummary，保留fetchedAt/生成与当前freshness | prisma/schema.prisma#FactSnapshot | Phase030；canonical 3.5/3.11 |
| `CacheEnvelope` | 30 | cacheKey PK，含provider/capability/query/date/region/locale/profileVersion | 无record/run FK；本设计选valueJson内联facts/sourceCatalog，不同时存payloadRef；providerValidUntil?；providerVersion/schemaVersion必填 | fresh/stale_revalidating/stale_fallback/expired/unavailable | 可刷新缓存值；不改历史FactSnapshot；仅缓存已授权可共享公开内容 | 按TTL/LRU淘汰；先物化当前run快照；不删除被版本引用内容 | 无直接公共投影；缓存状态不是用户FactFreshness标签 | prisma/schema.prisma#CacheEnvelope | Phase030/107/108/110；canonical 3.11 |
| `PlanMutation` | 53 | id PK；commandId unique；沿ChatCommand幂等域 | travelRecordId/commandId/userMessageId/sourcePlanVersionId/payloadRef必填；resolvedPayloadRef?/plannerRunId?/resultStatus?/resultRef?/errorCode?/causationId?/completedAt? | executionStatus=PENDING/RUNNING/COMPLETED/FAILED/CANCELLED；resultStatus=APPLIED/NEEDS_CLARIFICATION/INFEASIBLE或null | 接受输入/两个expected revision固定；只有APPLIED有结果版本；NO_CHANGE为INFEASIBLE | 活跃输入与未消费确认pin；终态按重放期；版本关联同保留 | 当前owner仅安全结果/Diff/选择，不泄漏私人原文至share/public | prisma/schema.prisma#PlanMutation | Phase053；canonical 3.10 |
| `MutationClarification` | 53 | id PK；consumedByCommandId非空时unique | mutationId/commandId/basePlanVersionId -> 同记录；optionsRef/pendingPayloadRef -> TaskPayload；consumedByCommandId?仅CONSUMED非空 | OPEN/CONSUMED/CANCELLED/EXPIRED；issueCode=AMBIGUOUS_TARGET/AMBIGUOUS_VALUE/SCOPE_EXPANSION_REQUIRED/LOCK_CONFIRMATION_REQUIRED | optionsHash/allowedImpactScopeHash/基线/签名输入固定；只存tokenKeyVersion不存token；终态不重开 | OPEN时pin选项；消费/取消/过期后按隐私期，不能丢失有效确认输入 | 仅当前owner question/choices/安全summary；有效签名按固定输入重建 | prisma/schema.prisma#MutationClarification | Phase053；state-machines 15 |
| `PlanDiff` | 53 | id PK；(basePlanVersionId,newPlanVersionId) unique | 两版本都同travelRecordId；diffJson含TargetRef、字段摘要、重算模块、tradeoffs；无可空版本引用 | 无生命周期 | 已保存语义Diff不可变，不以自然语言或文本diff作权威 | 与关联版本同保留，专用ERASE清私人摘要；不级联其他记录副本 | 仅owner安全语义比较；share/public不可读取其他版本或私人差异 | prisma/schema.prisma#PlanDiff | Phase053/058/059/060 |
| `ReplanCommand` | 58 | id PK；plannerRunId unique；(ownerKeyHash,travelRecordId,idempotencyKeyHash) unique | travelRecordId/sourcePlanVersionId/sourceWorkspaceSnapshotId/payloadRef/plannerRunId必填且同记录；resultPlanVersionId?/errorCode?/causationId?/completedAt? | PENDING/RUNNING/SUCCEEDED/BLOCKED/FAILED/CANCELLED | 请求/需求确认hash固定；与唯一PlannerRun终态同名；只有SUCCEEDED有结果版本 | 活跃payload pin；终态重放/版本上下文各按保留期，普通不删历史版本 | 仅当前owner命令进度/结果/Diff；无公共投影 | prisma/schema.prisma#ReplanCommand | Phase058；state-machines 5 |
| `RestoreCommand` | 59 | id PK；plannerRunId unique；(ownerKeyHash,travelRecordId,idempotencyKeyHash) unique | 同记录 sourcePlanVersionId/sourceWorkspaceSnapshotId/plannerRunId/payloadRef必填；resultPlanVersionId?/errorCode?/completedAt? | PENDING/RUNNING/SUCCEEDED/BLOCKED/FAILED/CANCELLED；requirementStrategy=REQUIRE_MATCH/RESTORE_TARGET | 固定目标需求/workspace hash与显式策略；保留当前锁；成功追加新版本，不改旧版 | 被版本引用上下文同保留；失败不留孤儿版本；ERASE专用清理 | 当前owner恢复收据；禁止恢复其他owner/已擦除记录 | prisma/schema.prisma#RestoreCommand | Phase059；state-machines 15 |
| `TravelReadinessReport` | 60 | id PK；绑定planVersionId/planVersion与三hash | planVersionId -> TravelPlanVersion；policy/validator/evaluator/factSnapshotRefs/checks/checkedAt/expiresAt必填 | READY/READY_WITH_WARNINGS/BLOCKED；检查项READY/ACTION_REQUIRED/BLOCKED/UNKNOWN | 每次检查新报告，结论不可变；过期或绑定变化需重检，不改旧报告 | 被PlanFinalization引用时Restrict且同版本保留；未引用报告按隐私期 | owner检查细节；share/public仅安全质量/时效摘要，不含私人原因 | prisma/schema.prisma#TravelReadinessReport | Phase060；state-machines 4 |
| `PlanFinalization` | 60 | id PK；planVersionId unique | travelRecordId/planVersionId/readinessReportId必填且同记录同版本；finalizedByOwnerKeyHash/警告集合/finalizedAt必填 | 无生命周期 | 确认凭证不可变；重复确认回放；后续修改/确认不覆盖历史凭证 | 普通UPDATE/DELETE拒绝；仅专用ERASE处理；不随final指针移动删除 | owner确认状态；share/public仅合法目标finalizedAt，不公开owner hash/私人警告 | prisma/schema.prisma#PlanFinalization | Phase060；canonical 3.7 |
| `RequirementPatchReceipt` | 62 | id PK；(ownerKeyHash,travelRecordId,idempotencyKeyHash) unique | travelRecordId -> TravelRecord；expectedRequirementRevision/resultRequirementRevision/resultRef必填；resultRef内plannerRunId? | 无生命周期；原子已提交收据 | requestHash/结果不可变；continue无答案不伪增revision；同键只重放 | 重放期保留；活跃run所需引用pin；专用ERASE清私人结果 | 当前owner安全RequirementReceipt；无share/public投影 | prisma/schema.prisma#RequirementPatchReceipt | Phase062；canonical 3.10 |
| `AnonymousMergeReceipt` | 82 | id PK；anonTokenHash unique一次消费 | targetUserId -> User；requestHash/合并计数/createdAt必填；无凭据原文 | 无生命周期；不可逆消费标记 | 原子切TravelRecord owner并保留历史ownerKeyHash；同目标凭据验证后可回放 | ERASE保留不可重用tombstone；不可因账号擦除让旧匿名token复活 | 同目标登录主体仅receiptId/计数/安全trace；不授登录权 | prisma/schema.prisma#AnonymousMergeReceipt | Phase082；术语七 |
| `UserTravelProfile` | 84 | userId PK/unique；profileVersion非负CAS | userId -> User；偏好字段按完整schema明确null/空数组；档案不存在与读取失败区分 | 无生命周期；ProfileLoadResult=PRESENT/ABSENT/UNAVAILABLE是响应判别 | 实变递增profileVersion；计划固定实际采用值/版本，不引用当前可变档案 | 字段清空立即影响新规划；ERASE删除敏感偏好；历史按版本清理协议 | 仅owner最小资料；健康/过敏/行动能力不进share/public/日志 | prisma/schema.prisma#UserTravelProfile | Phase084 |
| `DataRequest` | 84 | id PK；receiptHash unique；ownerKeyHash/type/idempotencyKeyHash唯一幂等域；revision/continuationSequence CAS | ownerKeyHash必填且可不依赖已删除User；startedAt?/completedAt?/errorCategory?/resultAssetRef?/manifestHash?/causationId?/intentId?/nextAttemptAt?；ERASE必有intentId/scopeHash/privacyWatermark | type=EXPORT/ERASE；PENDING/RUNNING/COMPLETED/FAILED；FAILED仅EXPORT | 接受的ERASE意图不可撤销；技术失败保持RUNNING；后继task继承scope/checkpoint，禁止重授权扩范围 | EXPORT产物可过期；ERASE完成前不得删意图/checkpoint；最小tombstone按水位保留 | owner可读安全状态；receipt仅id/type/status/completedAt/errorCategory；下载仍须活动owner | prisma/schema.prisma#DataRequest | Phase084；canonical 3.9；state-machines 14 |
| `PrivacyRevocationLedger` | 84 | intentId+scopeHash幂等；连续sequence unique；独立库受锁head分配 | 独立PostgreSQL数据库/卷/备份集；不设跨库FK；subjectHash/requestId/category/schemaVersion/createdAt；ERASE最小metadata含receiptHash/requestHash/ownerKeyHash和受控定位 | category=ERASE/CONSENT_WITHDRAWAL/SESSION_REVOKE/SHARE_REVOKE/PUBLICATION_REVOKE/MEDIA_REVOKE/KILL_DISABLE；无可回退生命周期 | append-only单调水位；本库投影失败按原intent幂等对账，不宣称跨库事务 | 不随应用备份回滚；不得删恢复所需意图/水位；不保存已删正文或秘密 | 无公共水位/主体投影；receipt仅恢复自身最小删除状态 | prisma/privacy-ledger/schema.prisma#PrivacyRevocationLedger | Phase084；canonical 3.9；独立生成Client/连接 |
| `RevalidationCommand` | 85 | id PK；plannerRunId unique；(ownerKeyHash,recordId,idempotencyKeyHash) unique | recordId/sourcePlanVersionId/sourceWorkspaceSnapshotId/requirementSnapshotRef/payloadRef/plannerRunId/traceId必填；resultPlanVersionId?/causationId?/completedAt?/errorCode? | PENDING/RUNNING/SUCCEEDED/BLOCKED/FAILED/CANCELLED | 实际pendingOverrides与源/当前锁在接受时冻结；成功才消费覆盖并追加REVALIDATE版本 | 活跃payload pin；失败/取消保留原覆盖；版本快照同保留期 | 仅owner进度/结果；非SUCCEEDED无结果版本 | prisma/schema.prisma#RevalidationCommand | Phase085；canonical 3.3/3.10 |
| `ArchiveReceipt` | 85 | id PK；(ownerKeyHash,recordId,idempotencyKeyHash) unique | recordId -> TravelRecord；expectedVersion/archivedAt/安全计数/auditId必填 | 无生命周期；原子已提交收据 | requestHash与归档结果不可变；归档终态不恢复；取消活动run/撤销已有公开授权同事务 | 保留用于幂等/审计；ERASE后只保留必要无正文tombstone | 当前owner仅归档时间/取消与撤销计数，不暴露他人ID | prisma/schema.prisma#ArchiveReceipt | Phase085 |
| `FavoritePlan` | 86 | (userId,planVersionId)复合PK/unique | userId -> User；planVersionId -> 明确TravelPlanVersion；note?；createdAt必填 | 无生命周期；存在即已收藏 | 绑定版本不跟随latest；note仅owner编辑 | 取消收藏可删除该owner自己的收藏行；不删除版本/来源记录 | 仅owner收藏摘要；收藏不授源版本越权访问 | prisma/schema.prisma#FavoritePlan | Phase086 |
| `ClonePlanCommand` | 87 | id PK；(ownerKeyHash,idempotencyKeyHash) unique；resultTravelRecordId/resultPlanVersionId唯一目标 | sourceRecordId/sourcePlanVersionId/payloadRef/resultTravelRecordId/resultPlanVersionId必填；overridesConsumedByCommandId? -> RevalidationCommand | 无异步生命周期；原子完成复制收据 | 源固定版本；目标version1 CLONE且NEEDS_REVALIDATION；重映射ID/hash/快照、独立空锁；覆盖仅存加密payload | 未消费覆盖pin；成功重核才消费；源删除不误删目标独立副本 | 仅owner复制收据/预览，不复制私人素材或授公共权限 | prisma/schema.prisma#ClonePlanCommand | Phase087；canonical 3.3；96扩媒体 |
| `ShareGrant` | 88 | id PK；tokenHash unique；revision非负CAS | planVersionId -> 固定已确认版本；expiresAt?/revokedAt?/reissuedFromId? -> ShareGrant；不存token | ACTIVE/REVOKED/EXPIRED | 固定版本不跟随latest；换发同事务撤旧建新，原期限不延长；同键重放tokenAvailable=false | REVOKED终态；到期下一请求拒绝；归档撤销；ERASE/SHARE_REVOKE先水位后清理 | 仅合法access=share PlanViewModel；首次创建/换发一次交付token；无效统一404 | prisma/schema.prisma#ShareGrant | Phase088；canonical 3.10；state-machines 10 |
| `PromptEvaluationRun` | 90 | id PK；绑定datasetVersion/配置元组/评测policy/hash | promptVersionId -> PromptVersion；deployment/provider精确复合FK；gatePolicyVersionId -> PromptGatePolicyVersion；结果JSON未完成前可空 | 运行复用DurableTask五态；评测结果PASS/FAIL/INCONCLUSIVE，未完成为null | 输入指纹固定；完成后逐项结果/汇总不可变；Provider不可用为INCONCLUSIVE | 与所依据治理激活证据同保留；不得删失败候选伪造通过率 | ADMIN安全逐项指标/结论；不暴露测试私密输入/完整Prompt | prisma/schema.prisma#PromptEvaluationRun | Phase090 |
| `PromptGatePolicyVersion` | 90 | id PK；version unique；contentHash校验 | createdById? -> User；contentJson保存单位化阈值；被PromptEvaluationRun引用 | 无生命周期；激活资格由评测结果决定 | 内容/hash/createdAt不可变；变更新版本 | 被评测/激活证据引用时Restrict | ADMIN规则与安全阈值说明，无普通公共投影 | prisma/schema.prisma#PromptGatePolicyVersion | Phase090 |
| `ModelEvaluationRun` | 91 | id PK；绑定deployment/configVersion与dataset/评测policy/hash | (deploymentId,deploymentConfigVersion) -> ModelDeployment；Prompt/Provider精确引用；结果未完成前可空 | 运行复用DurableTask五态；评测结果PASS/FAIL/INCONCLUSIVE，未完成为null | 输入指纹固定；完成结果不可变；不足样本只展示INSUFFICIENT_DATA，不冒充PASS | 与配置激活/回滚证据同保留；失败历史不可普通删除 | ADMIN聚合质量/延迟/成本/错误与样本量；无秘密 | prisma/schema.prisma#ModelEvaluationRun | Phase091 |
| `ProviderActivation` | 92 | providerId PK；revision非负CAS | (providerId,activeConfigVersion) -> ProviderConfigVersion；updatedBy? -> User；resolutionPolicyVersionId -> ProviderResolutionPolicyVersion | ACTIVE/DISABLED | CAS更新指针；影响AI元组时同事务更新两类Prompt activation；紧急停用优先缓存 | 不删除历史配置；禁用不由TTL/重启恢复；相关引用Restrict | ADMIN安全配置状态；公共仅来源机构/当前可用性摘要 | prisma/schema.prisma#ProviderActivation | Phase092 |
| `ProviderResolutionPolicyVersion` | 92 | id PK；version unique；contentHash校验 | contentJson绑定主Provider/有序fallback/capability/地区与stale策略精确版本；createdById? | 无生命周期 | 内容/hash/单位不可变；策略变更新版本 | 被activation/事实/run引用时Restrict | ADMIN受控策略；公开仅适用降级说明，不公开endpoint | prisma/schema.prisma#ProviderResolutionPolicyVersion | Phase092 |
| `Announcement` | 94 | id PK；revision非负CAS | currentVersionId? -> 同公告AnnouncementVersion，首版事务完成非空；publishedAt?/withdrawnAt?；窗口只在版本 | DRAFT/SCHEDULED/PUBLISHED/WITHDRAWN/EXPIRED | 发布/撤回通过聚合revision CAS；正文版本号不替代revision；终态更正创建关联新公告 | 不普通删除已发布历史；WITHDRAWN/EXPIRED停止展示并保留审计 | 仅有效窗口/范围内SanitizedAnnouncement，不含内部故障或用户信息 | prisma/schema.prisma#Announcement | Phase094；state-machines 11 |
| `AnnouncementVersion` | 94 | id PK；(announcementId,version)及(id,announcementId) unique | announcementId -> Announcement；createdById? -> User；expiresAt?；title/contentJson/contentHash/scopeJson/priority/startsAt必填 | 无独立生命周期；发布状态属于Announcement | 正文/严重度/安全链接存contentJson；作用域存scopeJson；窗口/内容全部不可变；修改新版本 | 已发布内容与审计同保留；不可原地覆盖/删除 | 经内容消毒与范围/时间过滤的title/body/severity/action，不直接返回整行 | prisma/schema.prisma#AnnouncementVersion | Phase094 |
| `TravelQualityFeedback` | 95 | id PK；receiptHash unique；提交者幂等域+idempotencyKeyHash unique；revision CAS | planVersionId -> 精确TravelPlanVersion；submitterUserId?与最小share actor分支；targetRef?依类别；assigneeId?/duplicateOfId?/受控联系字段? | OPEN/TRIAGED/IN_PROGRESS/RESOLVED/REJECTED/DUPLICATE；category=ROUTE_DETOUR/UNREALISTIC_TIME/PLACE_CLOSED/TRANSIT_MISMATCH/BUDGET_ERROR/FOOD_MISMATCH/LODGING_MISMATCH/ACCESSIBILITY/SOURCE_ERROR/UI_ISSUE/OTHER | 目标/原claim固定；分诊与双consent各受CAS/审计；终态不重开；反馈不改事实 | 撤回联系删除字段；撤回评测先水位后清理候选/副本；不可误删他人独立匿名证据 | 仅原提交者/独立receipt的id/status/revision/consents/安全回复；ADMIN分诊另鉴权 | prisma/schema.prisma#TravelQualityFeedback | Phase095；canonical 3.9；state-machines 11 |
| `RegressionCaseCandidate` | 95 | id PK；(feedbackId,consentRevision,contentHash) unique | feedbackId -> TravelQualityFeedback；consentRevision/privacyWatermark/来源与独立复核引用必填；datasetMembershipRefs可为空数组 | 无独立生命周期；是否可采样由当前consent/水位/来源/复核判定 | 去标识候选内容/hash不可变；新revision新候选；claim不自动成为黄金事实 | 撤回使待用候选失效并清可识别副本；历史仅留合规去标识摘要，旧dataset manifest不改 | ADMIN受控候选与机器复核证据；不公开原私有计划/联系信息 | prisma/schema.prisma#RegressionCaseCandidate | Phase095；canonical 3.9 |
| `FileAsset` | 96 | id PK；contentHash校验但不合并不同归属/许可；stateVersion CAS | storedPath/mimeType/detectedMime/sizeBytes/contentHash必填；width?/height?仅图片有值；purpose必填；通过AssetUsage授权 | status=QUARANTINED/ACTIVE/DISABLED；scanStatus=PENDING/PASSED/FAILED/UNAVAILABLE；visibility=PRIVATE/SIGNED；purpose=PLACE_MEDIA/ATTACHMENT/DATA_EXPORT | 三状态正交；初始QUARANTINED/PENDING/PRIVATE；内容不可替换为不同hash | 先撤权写tombstone/outbox，再按对象key/hash幂等删除并对账；被合法他人usage引用不得误删 | 仅受控derivative入口；不公开storedPath/原始存储直链；DATA_EXPORT须活动owner | prisma/schema.prisma#FileAsset | Phase096；canonical 3.9；state-machines 7 |
| `FileDerivative` | 96 | id PK；(assetId,derivativeKey) unique；contentHash校验 | assetId -> FileAsset；storedPath/contentHash/mimeType/sizeBytes必填；非图片width?/height?为空 | 无独立生命周期；读取继承FileAsset/scan/usage/rights实时资格 | 由固定原内容hash和处理版本生成；内容变刷新为新派生 | 与资产撤权/删除对账；活跃使用不可因缓存清理删除唯一受控文件 | 只经授权签名绑定asset/derivative/usage/purpose/access/expiry，no-store | prisma/schema.prisma#FileDerivative | Phase096 |
| `PlaceMedia` | 96 | id PK；assetId+binding+许可证据身份唯一 | assetId -> FileAsset；PUBLIC_POI为providerId/providerPlaceId；VERSION_PLACE为ownerUserId/planVersionId/placeRef；两支CHECK互斥；sourceUrl?与internalProofRef?至少一非空；expiresAt? | rightsStatus=ACTIVE/UNKNOWN/EXPIRED/REVOKED | 许可/归因/usageScopes/地点绑定具证据；不得靠相同placeRef或hash合并跨owner授权 | 版权撤销先水位/拒读再对账；保留必要非识别许可审计 | 仅ACTIVE rights且渠道/时间/资产状态合格；share/public排除私人VERSION_PLACE与redacted地点媒体 | prisma/schema.prisma#PlaceMedia | Phase096；术语七；state-machines 7 |
| `AssetUsage` | 96 | id PK；asset+purpose+授权对象+渠道唯一使用域；revision CAS | assetId -> FileAsset；ownerUserId?/planVersionId?/dataRequestId?依purpose；DATA_EXPORT必有同owner DataRequest；revokedAt? | 无独立status；revokedAt非空即撤权，资格还依资产/版权/访问上下文 | 绑定用途/owner/版本不可偷换；clone创建目标独立usage；签名不代替实时鉴权 | 撤销下一请求拒绝；对象清理前保留tombstone/outbox；不删除他人独立授权 | 仅受控usage-bound资源读取；receipt不授下载或计划权限 | prisma/schema.prisma#AssetUsage | Phase096；canonical 3.9 |
| `TraceEvent` | 97 | eventId PK；(traceId,sequence) unique | traceId -> PlanTrace；schemaVersion/type/stage/timestamps/脱敏payloadJson必填；可选业务引用须与trace同run/版本 | 无独立生命周期；记录事件时PlanTrace状态，不可反写其终态 | append-only；typed SDK唯一事件边界；详细事件缺失不能替代/删除最小trace | 按版本化retention清理详细事件；最小PlanTrace与版本仍保留；应用角色禁UPDATE/DELETE | ADMIN脱敏诊断；普通owner仅安全运行摘要；share/public无内部事件 | prisma/schema.prisma#TraceEvent | Phase097；canonical 2 |
| `PlanPublication` | 106 | id PK；slug unique且高熵不可猜；revision CAS | planVersionId -> 固定已确认TravelPlanVersion；createdById -> User；expiresAt?/revokedAt?；publishedAt/createdAt/updatedAt必填 | ACTIVE/REVOKED/EXPIRED | 固定版本不跟随latest；与ShareGrant独立授权；撤销不可恢复 | 归档同事务撤销；ERASE/PUBLICATION_REVOKE先独立水位后清理OG/缓存；保留必要tombstone | 仅当前合格access=public PlanViewModel；sitemap仅有效slug；无效统一404 | prisma/schema.prisma#PlanPublication | Phase106；canonical 3.6；state-machines 10 |
| `PromptModelRollout` | 90 | id PK；definitionId有且只有一个ACTIVE候选rollout；revision CAS | definitionId -> PromptDefinition；championTupleJson/challengerTupleJson精确版本；evaluationRunId -> PromptEvaluationRun；stoppedAt? | ACTIVE/STOPPED/COMPLETED | 两完整元组/依据版本不可变；traffic比例与停流CAS审计；终态不恢复 | 激活/回滚依据同保留，版本/评测引用Restrict | 仅ADMIN受控比例和指标，不含秘密或原始测试输入 | prisma/schema.prisma#PromptModelRollout | Phase090的challenger rollout模型；Phase091复用统一元组 |
<!-- model-registry:end -->

## 2. 核心表定义

下列字段为当前已冻结的设计目标。字段表中的合并行逐一适用于列出的同类型字段；`否` 为 NOT NULL，`是` 为 nullable，有条件演进必须等对应 Phase 迁移。无生命周期的不可变对象不强加 status。除明确覆盖外，FK 删除采用 Restrict，所有身份与精确版本引用创建后不变，索引责任见后文。

### 2.1 User

| 字段 | 类型 | nullable | 约束 |
|---|---|---|---|
| id | String | 否 | PK，cuid()，不作为授权凭据 |
| email | String | 否；Phase084 ERASE 后可空 | 唯一 normalizeEmailV1 输出，unique+数据库canonical CHECK |
| phone | String | 是 | 最小账户资料，不从聊天自动抽取 |
| name | String | 是 | 展示名称，不是身份 |
| avatarUrl | String | 是 | 受控资源，读取仍校验公开边界 |
| passwordHash | String | 否；Phase084 ERASE 后可空 | bcryptjs cost 12；永不返回客户端 |
| role | Role | 否 | USER/ADMIN，default USER，无 UserRole 同义枚举 |
| status | UserStatus | 否 | ACTIVE/DISABLED，default ACTIVE |
| sessionVersion | Int | 否 | default 0，CHECK>=0，安全变更递增并撤销会话 |
| revision | Int | 否 | default 0，CHECK>=0，角色/状态实际变更才原子+1 |
| lastLoginAt | DateTime | 是 | 登录时间，不参与revision/CAS |
| createdAt | DateTime | 否 | default now() |
| updatedAt | DateTime | 否 | 自动更新，只作展示 |

normalizeEmailV1：trim输入，local-part仅ASCII且1-64 bytes，不允许首尾点或连续点；domain经UTS #46 non-transitional IDNA ToASCII并验证DNS label；整体ASCII lowercase，总长<=254 bytes。数据库CHECK拒绝非canonical值，唯一索引裁决并发，不能只靠路由lowercase。Phase006有status索引，email唯一索引已足够不重复建普通索引。ADMIN专用投影返回revision与expectedVersion比较，不复用sessionVersion/updatedAt；登录不改变revision。Phase084专用擦除流程清空身份并禁用账户壳，不能让允许null成为普通注册的旁路。

### 2.2 TravelRecord

| 字段 | 类型 | nullable | 约束 |
|---|---|---|---|
| id | String | 否 | Phase008；PK，cuid() |
| userId | String | 是 | Phase008；FK User.id，onDelete Restrict / onUpdate Cascade，与anonTokenHash恰好一个非空 |
| anonTokenHash | Char(64) | 是 | Phase008；小写SHA-256，数据库格式CHECK，原文不落库 |
| title | String | 否 | 清洗后的展示标题，不作唯一身份 |
| status | TravelStatus | 否 | Phase008；default DRAFT；DRAFT/NEEDS_INFO/PLANNED/MODIFIED/FINALIZED/NEEDS_REVALIDATION/ARCHIVED |
| requirementJson | Json | 是 | Phase008建JSONB列；无需求为SQL NULL；非空写入必须通过当期需求Schema，见本节持久边界 |
| version | Int | 否 | default 0，CHECK>=0，唯一当前正式版本计数 |
| currentPlanVersionId | String | 是 | Phase025增，同记录同version复合FK |
| finalPlanVersionId | String | 是 | Phase025增，独立同记录复合FK，不跟随current |
| requirementRevision | Int | 否；Phase025增 | default 0，独立需求CAS，供PlannerRun.expectedRequirementRevision，Phase062消费PATCH |
| createdAt | DateTime | 否 | Phase008；Timestamptz(3)，default now() |
| updatedAt | DateTime | 否 | Phase008；Timestamptz(3)，@updatedAt，不作为CAS |

Phase008仅建owner/需求/version=0和时间；无计划正文列，也不提前建版本指针。Phase025增加CHECK `version=0 <=> currentPlanVersionId IS NULL`；`(currentPlanVersionId,id,version)` 引用版本 `(id,travelRecordId,version)` 候选唯一键，final的 `(finalPlanVersionId,id)` 引用 `(id,travelRecordId)`，允许null的final用MATCH SIMPLE。循环写入在同一事务按record、run/workspace、版本、指针顺序完成，确需延迟的FK显式DEFERRABLE并验证COMMIT时约束。

Phase008 的实际标量列 exact 为 `id/userId/anonTokenHash/title/status/version/requirementJson/createdAt/updatedAt`，关系为 `user/messages`，User 反向关系为 `travelRecords`。迁移增加 `TravelRecord_owner_xor`（两列恰一非空）、`TravelRecord_anonTokenHash_format`（非空值转 text 后匹配 `^[0-9a-f]{64}$`）、`TravelRecord_version_nonnegative`（`version>=0`）。后续字段按登记阶段迁移，不能靠 nullable 提前加列。

当前持久边界由 `src/server/repositories/travel-record.ts` 提供。`createTravelRecord({owner,title,requirementJson?})` 只接受缺省或 null 的 requirementJson，并明确写为 `Prisma.DbNull`；Phase017 的真实需求 Schema 尚未生产时，任何非空 JSON 都在 SQL 前以安全 `VALIDATION_ERROR` 拒绝，包括结构看似完整的值。没有允许调用方自报“已校验”的布尔标记、类型断言或验证回调。Phase017 接入 [唯一旅行 Schema](travel-plan-schema.md) 后才能开放同一入口的非空写入；本卡不实现需求提取、合并、readiness 或业务状态转换。

`src/server/anonymous-owner.ts` 的 owner 是 `{userId} | {anonTokenHash}` 排他联合，hash 类型为 branded string；运行时仅接受恰好一个自有数据属性，拒绝附加字段、双字段（另一字段为 undefined/null 也拒绝）、访问器及继承的 owner。服务器 hash utility 只接收已验证 Cookie 封装内的 canonical base64url 原文：无 padding、43 字符、解码为32 bytes且重新编码相同；对该原文字符串的 UTF-8 字节做 SHA-256，返回64字符小写hex。此处不签发 Cookie，也不验证签名或声称随机性由字符串格式证明。原文、签名和 Authorization 不进入数据库、日志或证据。

读取在同一查询中比较记录 ID 和当前 owner；内部匿名到用户的 `transferAnonymousTravelRecordToUser` 在事务中以 `FOR UPDATE` 锁记录、重新比较匿名 owner，再同时设置 userId 与清空 hash。它只是当前记录的所有权原子操作，不消费匿名凭据、不建立 alias/收据，也不实现 Phase082 完整合并。不存在和非 owner 统一 `NOT_FOUND`；数据库故障只抛固定安全错误，不带 SQL、输入或内部 cause。

初稿成功PLANNED，修改追加MODIFIED；FINALIZED只确认一个版本，随后允许追加版本且保留旧PlanFinalization/final指针。clone新记录目标固定NEEDS_REVALIDATION，version1 trigger=CLONE、qualityStatus=revalidation_required，独立空锁、重映射引用；成功REVALIDATE追加版本后转MODIFIED。NEEDS_REVALIDATION禁止finalize/分享/发布及“已核验”导出。ARCHIVED只读不可恢复，归档撤公开授权，不物理删记录。索引为(userId,createdAt,id)、(anonTokenHash,createdAt,id)、(status,updatedAt,id)；两个版本指针按联表/删除检查增加索引。

### 2.3 ChatMessage

| 字段 | 类型 | nullable | 约束 |
|---|---|---|---|
| id | String | 否 | Phase008；PK，cuid() |
| travelRecordId | String | 否 | Phase008；FK TravelRecord，onDelete Cascade / onUpdate Cascade，专用purge使用 |
| role | MessageRole | 否 | Phase008；USER/ASSISTANT/SYSTEM；无默认值 |
| kind | ChatMessageKind | 否 | Phase008；TEXT/STRUCTURED；无默认值 |
| sequence | Int | 否 | Phase008；CHECK >0，Int上界2147483647，(travelRecordId,sequence) unique；无默认值 |
| clientMessageId | String | 是 | 非空时(travelRecordId,clientMessageId) unique，null可重复 |
| replyToMessageId | String | 是 | Self FK onDelete SetNull / onUpdate Cascade，事务校验reply属于同一记录 |
| content | Text | 否 | 应用长度上限，不假设PostgreSQL text为255字符 |
| contentJson | Json | 是 | JSONB；STRUCTURED必须通过当期Schema，TEXT无结构时SQL NULL；当前非空写入关闭 |
| commandId | String | 是；Phase016增 | 与ChatCommand同迁移，USER与最终ASSISTANT各最多一条 |
| createdAt | DateTime | 否 | Phase008；Timestamptz(3)，default now()；同毫秒也按sequence有序 |

普通服务不提供单条删除。序号在record锁或原子分配下产生，不用无锁max+1；分页cursor绑定(travelRecordId,sequence,id)。已有两个复合unique覆盖record前缀，reply和command FK仍按各自访问路径建索引。公开PlanViewModel不含消息。

Phase008 的实际标量列 exact 为 `id/travelRecordId/role/kind/content/contentJson/sequence/clientMessageId/replyToMessageId/createdAt`，关系为 `travelRecord/replyTo/replies`。`ChatMessage_sequence_positive` CHECK 拒绝零和负数；两个唯一索引分别为 `(travelRecordId,sequence)` 与 `(travelRecordId,clientMessageId)`，NULL clientMessageId 可以重复，并建立 `replyToMessageId` 查询索引。本卡共新增 `TravelStatus/MessageRole/ChatMessageKind` 三个枚举，不把任务卡中的概括数量当作删减字段类型的依据。

`src/server/repositories/chat-message.ts` 的 `appendChatMessage` 要求调用方显式提供合法 sequence；Phase016 才生产序号分配和命令账。当前仅接受 TEXT 与缺省/null contentJson，任意 STRUCTURED 或非空 contentJson 均在 SQL 前拒绝，直到实际内容 Schema 生产。TEXT 原文不 trim 或截断，拒绝全空白、NUL 与非法 UTF-16；产品长度上限由后续输入边界确定，不假设 PostgreSQL text 有255字符限制。显示标题会移除标签形态及尖括号、将控制字符和连续空白归一，再拒绝空标题；它不是身份键或 HTML 输出。

消息追加在同一事务中锁住当前 owned record，再查重与验证 reply target 属于该记录。相同非空 clientMessageId 的重试比较 `role/kind/content/contentJson/replyToMessageId`：相同返回 `{message,replayed:true}`，不同抛 `IDEMPOTENCY_KEY_REUSED` 且零额外写入；服务端分配的 id/createdAt/sequence 不属于请求 payload，重试不能据新调度值制造第二条消息。新消息返回 `replayed:false`。数据库唯一、CHECK 或外键错误令事务失败并返回固定安全错误，不转换为空列表或成功结果。

`listChatMessages` 返回 `{messages,nextCursor}`，默认 limit=20、范围1–100，按 `sequence ASC,id ASC` 读取。内部游标是 `(travelRecordId,sequence,id)` 数组的 canonical JSON UTF-8 base64url，解码后必须重新编码相等；读取在记录锁内复核当前 owner、游标 record 和数据库锚点的全部三字段，越记录或失效锚点为 `VALIDATION_ERROR`。下一页使用严格更大 sequence，避免同毫秒跳项/重复。此游标仅为 repository 协议，Phase052 的 HTTP 入口还须按 API 契约加签名、owner/filter/水位封装；本卡不提供无签名公共游标端点。

### 2.4 SystemConfig

| 字段 | 类型 | nullable | 约束 |
|---|---|---|---|
| id | String | 否 | PK |
| key | String | 否 | unique，唯一注册键 |
| valueJson | Json | 否 | 类型化非敏感配置，写前Schema校验 |
| description | String | 否 | 键的可执行含义 |
| group | String | 否 | CHECK AI/UI/EXPORT/SECURITY/GENERAL |
| isPublic | Boolean | 否 | default false，公开还须key白名单 |
| revision | Int | 否 | default 0，>=0，PATCH expectedVersion CAS+1 |
| updatedBy | String | 是 | FK User，删除SetNull |
| createdAt | DateTime | 否 | default now() |
| updatedAt | DateTime | 否 | 自动更新 |

无enabled/status生命周期，Prompt/模型/Provider/Policy版本不放本表。updatedBy索引用于审计联表，(group,key)用于管理列表；公开读取不能只靠isPublic而泄露secret。后台改值与AuditLog同事务。

### 2.5 ApiKeyConfig

| 字段 | 类型 | nullable | 约束 |
|---|---|---|---|
| id | String | 否 | PK，secretRef的唯一目标 |
| name | String | 否 | 管理名称 |
| provider | String | 否 | 注册Provider标识，不是客户端URL |
| encryptedKey | String @db.Text | 否 | Phase010首产；版本化AES-256-GCM envelope的RFC8785 JCS canonical JSON文本；解析后Schema校验，保留规范字节 |
| encryptionKeyId | String | 否 | 解码后32-byte主密钥的SHA-256小写64位hex，与envelope.keyId一致 |
| envelopeVersion | Int | 否 | default 1；envelope协议版本，解密必须匹配 |
| keyFingerprint | String @db.Char(64) | 否 | 完整SHA-256小写hex，unique；ADMIN仅运行时派生短指纹 |
| status | ApiKeyStatus | 否 | default ACTIVE；ACTIVE/DISABLED/REVOKED |
| revision | Int | 否 | Phase010首产；default 0，非负CHECK；名称/状态实际变更CAS+1，不复用updatedAt |
| lastUsedAt | DateTime | 是 | 尚未调用为null |
| revokedAt | DateTime | 是 | REVOKED时非空且不可恢复 |
| createdAt | DateTime | 否 | default now() |
| updatedAt | DateTime | 否 | 生命周期/lastUsedAt更新，不允许覆盖密文 |

无user归属。轮换创建新行，经KeyRotationRun验证全部活跃引用后原子切换；DISABLED可恢复，REVOKED终态。被ProviderConfigVersion引用时Restrict，@@index([provider,status])支撑候选/列表。旧envelope不可原地重加密覆盖，key ring轮换保留encryptionKeyId和旧版本解密能力直到受控清理。

Phase010 的新增迁移为此表建立 fingerprint、envelope、revision 与 revocation CHECK，以及更新保护 trigger。`id/provider/encryptedKey/encryptionKeyId/envelopeVersion/keyFingerprint/createdAt` 全部不可变；`name/status` 任一实际改变时 revision 必须且只能加1，两者均不变时 revision 必须保持原值。`lastUsedAt/updatedAt` 不使 revision 递增。`status=REVOKED` 与 `revokedAt IS NOT NULL` 必须等价，进入 REVOKED 后状态和 revokedAt 均不可再改；ACTIVE/DISABLED 的 revokedAt 必须为 null。管理入口对 expectedVersion 的授权与 CAS 由 Phase013 实现，不能把当前数据库 trigger 当作已实现的管理服务。

存储校验与 `src/server/api-key-envelope.ts` 共享 exact v1 边界：只允许 `version/keyId/algorithm/iv/ciphertext/tag` 六字段、规范 RFC8785 JCS 字节、列绑定及标准 padded base64；未知/重复字段、非规范 JSON、错误类型、超长及不匹配的列均拒绝。完整 envelope 文本上限22500 UTF-8 bytes；IV/tag/ciphertext 的解码长度分别为12/16/1–16384 bytes。JCS/AAD、明文规范化与两种指纹的含义以 [加密契约](crypto.md) 为准。结构合法不代表已经验证 GCM tag，实际加解密由 Phase013 消费该 parser 和 `apiKeyAad`。

Phase010 migration 与基础 seed 均不创建 ApiKeyConfig 行。未来 `ProviderConfigVersion.secretRef` 就是本表现有 `id` 的引用，Phase015 才创建该治理表及外键；本阶段没有第二张 secret 表、平行明文字段或占位 Provider 记录。实现范围与验收要求见 [Phase010](phase010.md)。

### 2.6 AuditLog

| 字段 | 类型 | nullable | 约束 |
|---|---|---|---|
| id | String | 否 | PK |
| actorId | String | 是 | FK User SetNull，系统动作为null |
| actorEmailSnapshot | String | 是 | 仅冻结隐私策略允许时保存，ERASE清理身份 |
| targetType | String | 否 | 来源于受控审计目标registry |
| targetId | String | 是 | 泛型目标标识，目标已删除仍保留安全追溯 |
| action | String | 否 | 受控action registry，不接受用户任意写入 |
| requestId | String | 是 | 请求触发必须非空，后台任务可null |
| traceId | String | 是 | AI/规划调用存在时必填 |
| detailJson | Json | 是 | 递归脱敏，保存结果、原因、安全diff和版本 |
| ipHash | String | 是 | HMAC后的地址，无原始IP |
| userAgentSummary | String | 是 | 限长且去除可识别细节 |
| createdAt | DateTime | 否 | default now()，无普通updatedAt |

Phase009 已首产此表，精确字段以该生产卡为准：actor kind 是服务参数 USER/SYSTEM 判别联合，不额外持久化 actorType。五个固定索引为 (targetType,targetId,createdAt)、(actorId,createdAt)、(action,createdAt)、requestId、traceId。时间使用 timestamptz(3)，id 使用 cuid，actor 外键 onDelete:SetNull/onUpdate:Restrict。

action/targetType 最多64字符，targetId/actorId 最多128，邮箱快照最多254，requestId/traceId 为服务端生成的36字符 UUID v4，ipHash 为 Char(64) 小写 HMAC，userAgentSummary 为 VarChar(256)。SYSTEM 两个主体字段均 null，detailJson.systemActor 限 MIGRATION/SCHEDULER/MAINTENANCE。只有可信服务器生成的 opaque context 可传入 helper。递归摘要的完整输入/脱敏输出各限16KiB、8层和1024节点；数据库另设32KiB JSONB文本上限，给其空白序列化开销留界限。

`src/server/services/audit-log-service.ts` 的 writeAuditLog 只接受 runAuditedTransaction 用私有 WeakMap 登记的真实交互事务客户端（拒绝全局 delegate 包装、复制和过期对象），写成功返回安全引用，验证或持久化失败抛出安全错误并由调用事务回滚，调用方吞错、未等待审计或没有成功审计也不能提交。关键业务变更和审计同事务，禁止吞错成功或两次提交。初始封闭 action/target registry 为 CONFIG_UPDATE→SystemConfig、USER_DISABLE→User、API_KEY_ROTATE→ApiKeyConfig；未来动作由首次消费者显式登记。

Phase010 增加 `SEED_ADMIN_CREATE→User`、`SEED_CONFIG_CREATE→SystemConfig` 及受限来源摘要，主体复用 SYSTEM/MIGRATION，保持既有 AuditLog CHECK 不变。CLI 使用 helper 自行创建的 Prisma 连接和 Serializable 事务，不接受调用方伪造事务包装。完全验证后的幂等 no-op 用内部信号中止只读事务并返回 UNCHANGED，不产生审计或业务写入，也不放宽“成功提交必须包含已等待的成功审计”边界。

运行期应用角色非 table/schema owner、非 superuser、无 DDL/角色提升能力，只授审计 SELECT/INSERT。UPDATE/DELETE 行 trigger 与 TRUNCATE statement trigger 拒绝篡改，包括意外授予 DML 权限时。实际 User 删除产生的嵌套 FK action 仅可清 actorId，并核验旧父行消失及其他字段逐值不变，保留邮箱快照；普通直接置空也失败。物理清理和 ERASE 去标识责任仍属后续受控 maintenance role/procedure，必须另留审计；当前不存在应用可用的清理旁路。完整边界及合成实库验证见 [Phase009](phase009.md)。

### 2.7 AuthSession

| 字段 | 类型 | nullable | 约束 |
|---|---|---|---|
| id | String | 否 | PK |
| userId | String | 否 | User FK Restrict |
| tokenHash | Char(64) | 否 | unique，仅hash，原文仅httpOnly Cookie |
| audience | String | 否 | USER/ADMIN访问域，ADMIN入口须ACTIVE ADMIN |
| sessionVersion | Int | 否 | 绑定签发时User.sessionVersion，不变 |
| status | AuthSessionStatus | 否 | ACTIVE/REVOKED/EXPIRED |
| issuedAt | DateTime | 否 | 签发时间 |
| expiresAt | DateTime | 否 | >issuedAt，绝对有效期12小时 |
| lastSeenAt | DateTime | 是 | 未更新活动时null，不延长absolute expiry |
| revokedAt | DateTime | 是 | REVOKED时非空 |
| createdAt | DateTime | 否 | default now() |

每次鉴权同时查会话ACTIVE、expiry、audience、User ACTIVE、role与sessionVersion；退出先数据库CAS撤销再清Cookie。终态不可恢复，索引(userId,status,expiresAt,id)及expiresAt供撤销/清理。仅清Cookie不算撤销。

### 2.8 AuthLoginAttempt

| 字段 | 类型 | nullable | 约束 |
|---|---|---|---|
| id | String | 否 | PK |
| scope | String | 否 | LOGIN/REGISTER双bucket域，共用凭据服务 |
| ipHash | Char(64) | 否 | 服务端HMAC可信地址 |
| accountHash | Char(64) | 否 | 服务端HMAC canonical账户；不存在账户仍计数 |
| status | AuthLoginAttemptStatus | 否 | RESERVED/FAILED/SUCCEEDED/EXPIRED |
| reservedUntil | DateTime | 否 | 短reservation TTL，晚于创建时间 |
| createdAt | DateTime | 否 | 数据库/注入clock统一 |
| completedAt | DateTime | 是 | 三类终态时必填 |
| requestId | String | 否 | 安全诊断标识 |

不建User FK。按已排序IP/account bucket取得PostgreSQL advisory transaction locks，15分钟窗计未过期RESERVED+FAILED；账户5次或IP20次锁15分钟。索引(scope,ipHash,createdAt)、(scope,accountHash,createdAt)与reservation清理索引显式建立。终态只收敛一次，成功不清空同IP失败记录，AuditLog不作限流权威。

Phase011 首产的两张认证表使用唯一 `auth_session_login_attempt` migration；签发、撤销、预留和完成的时间来自 `public.auth_now()`，应用角色不能修改该函数。普通角色只对生命周期列拥有 UPDATE；摘要、归属、版本和绝对期限不可修改，终态不可恢复，DELETE/TRUNCATE拒绝。精确SQL与并发/TTL验收见 [Phase011说明](phase011.md)，旧migration保持原字节。受控保留清理由后续隐私/维护阶段实现，当前不删除历史安全记录。

### 2.9 AiOutputRecord

| 字段 | 类型 | nullable | 约束 |
|---|---|---|---|
| id | String | 否 | PK |
| travelRecordId | String | 是 | FK TravelRecord，未建记录的debug/NLU为null |
| traceId | String | 否 | 调用trace，不在015引用尚不存在的PlanTrace表 |
| attemptNo | Int | 否 | >=1，(traceId,attemptNo) unique |
| promptVersionId | String | 否 | 精确FK PromptVersion |
| deploymentId | String | 否 | 与deploymentConfigVersion组合FK |
| deploymentConfigVersion | Int | 否 | 引用ModelDeployment(id,configVersion) |
| providerId | String | 否 | 与providerConfigVersion组合FK |
| providerConfigVersion | Int | 否 | 引用ProviderConfigVersion(providerId,configVersion) |
| inputHash | Char(64) | 否 | 输入canonical字节SHA-256 |
| outputHash | Char(64) | 否 | 输出字节SHA-256；无返回时hash空字节，不造输出 |
| rawOutput | Text | 是 | 所有生产attempt必须null，mock-debug仅显式capturePolicy裁剪限长 |
| parsedOk | Boolean | 否 | 独立解析结果，非成功替代状态 |
| status | AiOutputStatus | 否 | SUCCEEDED/FAILED/CANCELLED，完成attempt追加 |
| errorCode | String | 否 | 成功NONE，失败为稳定分类；不使用原始服务商body |
| errorMessage | String | 是 | 安全错误，成功为null |
| inputTokens | Int | 是 | 未知为null，不伪0 |
| outputTokens | Int | 是 | 未知为null，不伪0 |
| durationMs | Int | 否 | >=0，实际计时 |
| createdAt | DateTime | 否 | default now() |

Phase015与全部精确治理FK同迁移创建，Phase008不得提前建表。每个attempt完成后追加，不能返回不可追踪的成功；所有FK依版本追溯查询建复合索引，traceId由唯一复合前缀覆盖。解析、安全与外部调用链在015验证，不由本文宣称已通过。

### 2.10 TravelPlanVersion

| 字段 | 类型 | nullable | 约束 |
|---|---|---|---|
| id | String | 否 | PK，组装hash前服务端预生成，同一id保存 |
| travelRecordId | String | 否 | FK TravelRecord，(travelRecordId,version) unique |
| version | Int | 否 | >=1，失败不递增 |
| schemaVersion | String | 否 | 唯一正文Schema版本 |
| trigger | PlanVersionTrigger | 否 | GENERATE/MUTATION/REPLAN/RESTORE/CLONE/REVALIDATE |
| planJson | Json | 否 | 正式计划正文唯一持久位置，完整校验后写入 |
| planContentHash | String | 否 | sha256:前缀+64位小写hex，不含qualityReport正文hash |
| qualityReportHash | String | 否 | 绑定前一hash的完整质量报告hash |
| planHash | String | 否 | 装入qualityReport后的完整正文hash |
| qualityStatus | QualityReportStatus | 否 | pass/needs_review/fail/revalidation_required，保存资格另受CHECK/服务约束 |
| qualityPolicyVersion | String | 否 | 精确不可变PlanningPolicyVersion标识 |
| validatorVersion | String | 否 | 确定性校验器版本 |
| evaluatorVersion | String | 否 | 评测规则版本 |
| qualityCheckedAt | DateTime | 否 | hash之前冻结 |
| factSnapshotRefs | Json | 否 | 固定canonical例外名；Phase030起引用真实快照，保存前逐个核验归属 |
| workspaceSnapshotId | String | 否 | 复合FK(workspaceSnapshotId,travelRecordId)引用工作区同记录候选键 |
| traceId | String | 否 | 唯一PlanTrace，成功保存同事务SAVED |
| createdAt | DateTime | 否 | 不变，无updatedAt |

三个hash按正文、报告、完整计划顺序用JCS canonical JSON字节计算；报告不得包含最终planHash，哈希后禁止再改正文。precise只存pass；quick可存无硬违规且策略允许的needs_review并禁止不可执行动作；正常fail不落版本。revalidation_required只允许CLONE version1。数据库应用角色禁止UPDATE/DELETE，专用Phase084 ERASE可清私人正文并保留安全tombstone。建(id,travelRecordId)、(id,travelRecordId,version)候选unique；工作区/策略/trace FK与fact引用的查询/删除索引都显式验证。Phase025仅建表，Phase049首个正常业务v1，Phase087复制v1。

### 2.11 PlannerRun

| 字段 | 类型 | nullable | 约束 |
|---|---|---|---|
| id | String | 否 | PK，重试新run，不重开终态 |
| traceId | String | 否 | unique，一对一PlanTrace |
| travelRecordId | String | 是 | PLAN必须非空，FACT_EVALUATION可空 |
| purpose | PlannerRunPurpose | 否 | PLAN/FACT_EVALUATION |
| planningMode | String | 否 | quick/precise，JSON canonical小写 |
| schemaVersion | String | 否 | 工作区/计划Schema绑定 |
| expectedVersion | Int | 是 | PLAN非空，FACT_EVALUATION无正式版本为null |
| expectedRequirementRevision | Int | 是 | PLAN非空，独立需求CAS |
| payloadRef | String | 否 | 可恢复受控输入引用，不是仅checksum |
| workspaceSnapshotId | String | 是 | FK最新不可变checkpoint；未创建时null |
| stage | String | 否 | 已生产流水线的注册stageCode，不另造生命周期 |
| status | PlannerRunStatus | 否 | PENDING/RUNNING/SUCCEEDED/BLOCKED/FAILED/CANCELLED |
| versionSnapshotJson | Json | 否 | 冻结Prompt/Model/Provider/Policy/validator/evaluator精确版本 |
| errorJson | Json | 是 | 安全类别、失败阶段、retryable、质量摘要 |
| startedAt | DateTime | 是 | PENDING未开始为null |
| completedAt | DateTime | 是 | 终态非空 |
| createdAt | DateTime | 否 | default now() |

版本提交复核当前owner、状态、expectedVersion、expectedRequirementRevision、活动run和DurableTask的leaseOwner/leaseUntil/fencingToken。PLAN成功绑定唯一版本和SAVED trace；FACT_EVALUATION成功仅snapshot/report与EVALUATED trace，record/current/version变化为0。服务将run终态、消息、版本、审计/outbox同事务收敛。record活动PLAN用部分唯一约束排他，record/status及workspace FK按查询建索引。

### 2.12 PlanTrace

| 字段 | 类型 | nullable | 约束 |
|---|---|---|---|
| id | String | 否 | PK |
| traceId | String | 否 | unique |
| attemptId | String | 否 | unique，与单次PlannerRun attempt一致 |
| plannerRunId | String | 否 | unique，FK PlannerRun |
| travelRecordId | String | 是 | 与run一致，事实评测可空 |
| planVersionId | String | 是 | 非空unique，SAVED时必须绑定版本且同record |
| status | PlanTraceStatus | 否 | RUNNING/SAVED/EVALUATED/REJECTED/FAILED/CANCELLED |
| startedAt | DateTime | 否 | 与attempt开始对应 |
| completedAt | DateTime | 是 | 终态必填 |
| finalDecision | String | 是 | 终态安全决策 |
| errorCategory | String | 是 | 失败/阻断安全类别，不含原文 |
| degraded | Boolean | 否 | 是否使用已获策略允许的降级 |
| policyVersionId | String | 是 | 精确PlanningPolicyVersion FK，尚未解析时null |
| requirementRevision | Int | 是 | PLAN准入时绑定需求revision |
| createdAt | DateTime | 否 | default now() |

Phase025建最小表，Phase026与每个run同事务创建RUNNING。成功版本同事务唯一SAVED；EVALUATED仅FACT_EVALUATION且planVersionId=null；REJECTED/FAILED/CANCELLED也不关联正式版本。其他终态不重开。Phase097只增加TraceEvent、SDK、索引与保留策略，不能晚到成功版本后才建trace。record/策略FK索引和(status,startedAt,id)诊断索引在生产时验证。

### 2.13 FactSnapshot

| 字段 | 类型 | nullable | 约束 |
|---|---|---|---|
| id | String | 否 | PK |
| traceId | String | 否 | 必须等于所属run的traceId |
| plannerRunId | String | 否 | FK PlannerRun，Restrict |
| collectionAttemptId | String | 否 | unique，唯一采集重试去重键 |
| querySetHash | Char(64) | 否 | 非unique，同查询可合法refresh |
| contentHash | Char(64) | 否 | 非unique，同内容可属于不同采集attempt |
| contentJson | Json | 否 | facts/sourceCatalog/providerPolicy/cacheHits/cacheMisses/providerErrors/staleFactRefs及request/attempt身份的受校验封闭结构 |
| createdAt | DateTime | 否 | 不变，事实各自fetchedAt在正文保留 |

Phase030首产，不由028或025提前建表。sourceRefs必须解析到本快照sourceCatalog；相同collectionAttemptId只返回同一snapshot并核验run归属，新采集即使hash相同也新建ID。事实status=verified/estimated/unknown/conflicting/stale；unknown保持value=null/unit=null/sourceRefs=[]/fetchedAt=null/confidence=0等完整null语义；来源可安全URL或成对locator/contentHash，公开投影去除内部locator。索引(plannerRunId,createdAt,id)和traceId；被版本引用时不能随缓存TTL删除。generatedFreshness与currentFreshness都基于同一不可变snapshot、各自clock/policy，不读当前缓存覆盖历史。

### 2.14 FavoritePlan

| 字段 | 类型 | nullable | 约束 |
|---|---|---|---|
| userId | String | 否 | FK User，登录用户所有权 |
| planVersionId | String | 否 | FK TravelPlanVersion，固定已授权明确版本 |
| createdAt | DateTime | 否 | 创建时间 |
| note | String | 是 | 私有备注，公开投影禁止 |

Phase086首建；(userId,planVersionId)为复合PK并提供所需unique，无第二同义id。没有生命周期status，取消收藏可删除关联行，不删版本。以userId前缀分页，planVersionId单列索引用于删除检查；账号ERASE按owner删除该关联，不误删他人收藏。收藏不是版本保存/分享的前置硬依赖。

### 2.15 ShareGrant

| 字段 | 类型 | nullable | 约束 |
|---|---|---|---|
| id | String | 否 | PK，响应投影名shareId不另存第二列 |
| planVersionId | String | 否 | FK固定FINALIZED版本，不跟随latest |
| tokenHash | Char(64) | 否 | unique，仅hash |
| status | ShareGrantStatus | 否 | ACTIVE/REVOKED/EXPIRED |
| revision | Int | 否 | default 0，撤销/换发expectedVersion CAS |
| createdAt | DateTime | 否 | 创建时间 |
| expiresAt | DateTime | 是 | 无明确到期为null，<=now下一次读即拒绝 |
| revokedAt | DateTime | 是 | REVOKED时必填且不恢复 |
| reissuedFromId | String | 是 | 自FK Restrict，换发溯源 |

Phase088首次生产。创建/换发仅首次返回token；同键重放同grant且tokenAvailable=false，不保存token原文或能重建秘密的响应。创建expectedVersion比TravelRecord.version，撤销/换发比ShareGrant.revision。分享默认关闭，固定不可变确认版本，实时验证权限/时效/kill/watermark；公开只返回access=share PlanViewModel，失效统一404。归档同事务撤销，ERASE按独立水位清理；planVersionId、reissuedFromId及(status,expiresAt,id)建索引。

### 2.16 TravelQualityFeedback

| 字段 | 类型 | nullable | 约束 |
|---|---|---|---|
| id | String | 否 | PK |
| planVersionId | String | 否 | FK精确版本，目标引用必须在其中解析 |
| submitterUserId | String | 是 | 登录提交者；guest为null，不能代用分享owner |
| receiptHash | Char(64) | 否 | unique，客户端256-bit回执只存hash |
| idempotencyKeyHash | Char(64) | 否 | 与提交身份/requestHash域唯一，不存原始头 |
| requestHash | Char(64) | 否 | 同键同payload/receipt重放，异值409 |
| targetRefJson | Json | 是 | 目标类反馈必填，UI_ISSUE/OTHER可省略 |
| category | FeedbackCategory | 否 | ROUTE_DETOUR/UNREALISTIC_TIME/PLACE_CLOSED/TRANSIT_MISMATCH/BUDGET_ERROR/FOOD_MISMATCH/LODGING_MISMATCH/ACCESSIBILITY/SOURCE_ERROR/UI_ISSUE/OTHER |
| severityHint | String | 否 | low/medium/high/critical用户提示，不是核实风险 |
| description | Text | 否 | 用户claim，受限且私有 |
| expectedOutcome | Text | 否 | 用户期望，不作事实 |
| status | FeedbackStatus | 否 | OPEN/TRIAGED/IN_PROGRESS/RESOLVED/REJECTED/DUPLICATE |
| revision | Int | 否 | >=0，管理/同意CAS |
| contactConsent | Boolean | 否 | default false，guest不能为true |
| evaluationConsent | Boolean | 否 | default false，独立于联系同意 |
| consentRevision | Int | 否 | 撤回与独立ledger水位绑定 |
| contactJson | Json | 是 | 仅明确同意的提交者自身canonical邮箱及来源；撤回清空 |
| triageJson | Json | 是 | 受控分诊、指派、重复关联、issue/fix/rootCause/regression证据，ADMIN投影 |
| createdAt | DateTime | 否 | 创建时间 |
| updatedAt | DateTime | 否 | 自动更新 |

Phase095首建，目标种类矩阵按该卡固定TargetRef，receipt只授自身最小状态/同意，share撤销不使独立receipt失效。终态RESOLVED/REJECTED/DUPLICATE不重开；反馈不直接改FactSnapshot或黄金集。RegressionCaseCandidate经独立来源/许可/同意水位核验，撤回停止采样并清衍生个人副本。FK(planVersionId,submitterUserId)分别建索引，(status,createdAt,id)用于分诊。

### 2.17 Announcement

| 字段 | 类型 | nullable | 约束 |
|---|---|---|---|
| id | String | 否 | PK，公告聚合身份 |
| currentVersionId | String | 是 | 首版事务结束后非空，FK同announcement版本 |
| status | AnnouncementStatus | 否 | DRAFT/SCHEDULED/PUBLISHED/WITHDRAWN/EXPIRED |
| revision | Int | 否 | >=0，排期/发布/撤回CAS |
| publishedAt | DateTime | 是 | 当前版本首次发布时固定 |
| withdrawnAt | DateTime | 是 | 撤回时必填 |
| createdAt | DateTime | 否 | 创建时间 |
| updatedAt | DateTime | 否 | 生命周期更新时间 |

Phase094与版本同迁移；状态只在聚合，不在不可变版本重复另一套生命周期。DRAFT可SCHEDULED/PUBLISHED，SCHEDULED可DRAFT/PUBLISHED/EXPIRED，PUBLISHED可WITHDRAWN/EXPIRED，两个终态不恢复，更正创建关联新公告。发布作用域/时间由currentVersion确定，不能改写事实freshness。currentVersionId及(status,publishedAt,id)建索引。

### 2.18 AnnouncementVersion

| 字段 | 类型 | nullable | 约束 |
|---|---|---|---|
| id | String | 否 | PK |
| announcementId | String | 否 | FK Announcement，(announcementId,version) unique |
| version | Int | 否 | >=1，追加不覆盖 |
| title | String | 否 | 消毒后的安全标题 |
| contentJson | Json | 否 | 安全正文、模板与来源说明 |
| contentHash | Char(64) | 否 | 不可变内容hash |
| scopeJson | Json | 否 | 已登记地区/能力/用户范围，公开匹配前校验 |
| priority | Int | 否 | 明确排序值，受控范围 |
| startsAt | DateTime | 否 | 起始窗口 |
| expiresAt | DateTime | 是 | 有值则>startsAt |
| createdById | String | 是 | User FK SetNull的作者身份保留例外 |
| createdAt | DateTime | 否 | 不变 |

版本没有status/updatedAt，修改正文或窗口都新增版本；生命周期在Announcement。公开只返回当前适用SanitizedAnnouncement，不含内部错误、账号或安全细节。加入(id,announcementId)候选键约束当前指针，作者FK索引；内容本身不更新，作者去标识走专用隐私协议。

### 2.19 FileAsset

| 字段 | 类型 | nullable | 约束 |
|---|---|---|---|
| id | String | 否 | PK |
| ownerUserId | String | 是 | 私有附件/账号导出必填，公共管理素材可空；User FK |
| purpose | AssetPurpose | 否 | PLACE_MEDIA/ATTACHMENT/DATA_EXPORT |
| storedPath | String | 否 | 不可猜对象键，服务端专用，不返回公共直链 |
| mimeType | String | 否 | 声明类型不能覆盖检测结果 |
| detectedMime | String | 否 | 实际sniffing结果，白名单校验 |
| sizeBytes | BigInt | 否 | >=0，受大小上限限制 |
| width | Int | 是 | 图片解码后正数，非图片null |
| height | Int | 是 | 同width成对 |
| contentHash | Char(64) | 否 | 内容校验，不能据hash合并版权或owner |
| status | AssetStatus | 否 | QUARANTINED/ACTIVE/DISABLED |
| scanStatus | AssetScanStatus | 否 | PENDING/PASSED/FAILED/UNAVAILABLE |
| visibility | AssetVisibility | 否 | PRIVATE/SIGNED |
| stateVersion | Int | 否 | >=0，独立生命周期CAS |
| createdAt | DateTime | 否 | 创建时间 |
| updatedAt | DateTime | 否 | 扫描/生命周期更新时间 |
| deletedAt | DateTime | 是 | 受控对象删除tombstone后设置 |

Phase096首建并扩FileDerivative/PlaceMedia/AssetUsage。初始QUARANTINED/PENDING/PRIVATE；扫描服务不可用保持隔离+UNAVAILABLE，不能直接ACTIVE。公开PLACE_MEDIA额外要求SIGNED、rightsStatus=ACTIVE、有效地点binding/AssetUsage/当前access；附件与DATA_EXPORT不要求PlaceMedia但有各自owner/DataRequest授权。对象删除先禁读和outbox，再worker按key/hash幂等删除对账；保留仍有独立合法使用的公共对象。owner FK、purpose/status/createdAt及各usage FK显式索引。

### 2.20 PlanPublication

| 字段 | 类型 | nullable | 约束 |
|---|---|---|---|
| id | String | 否 | PK |
| planVersionId | String | 否 | FK固定FINALIZED版本，独立发布授权 |
| slug | String | 否 | unique，不可猜，不含token/user/连续ID |
| status | PublicationStatus | 否 | ACTIVE/REVOKED/EXPIRED |
| publishedAt | DateTime | 否 | 发布时间 |
| expiresAt | DateTime | 是 | <=now下一请求即拒绝 |
| revokedAt | DateTime | 是 | REVOKED时必填，不可恢复 |
| createdById | String | 否 | FK当前发布owner User |
| revision | Int | 否 | >=0，撤销CAS |
| createdAt | DateTime | 否 | 创建时间 |
| updatedAt | DateTime | 否 | 生命周期更新时间 |

Phase106首次建表和public页面，不复用ShareGrant。当前隐私/质量/freshness资格通过才发布，公开PlanViewModel不比share更宽；sitemap仅收当前有效slug，撤销/过期立即拒绝读取并移除下一版索引。归档同事务撤销，ERASE先独立PUBLICATION_REVOKE水位。planVersionId、createdById及(status,expiresAt,id)建索引，版本/发布者引用Restrict。

### 2.21 AdminCommandReceipt（Phase012）

Phase012 首次迁移 `20260912013806_admin_commands` 创建管理命令收据和轮换账本，保留六个既有迁移的字节。同步用户修改与成功收据、USER_UPDATE 审计在同一事务提交；同值请求只写安全收据。该表不是第二套认证或共享任务表。

| 字段               | 类型与默认值                    | 约束与用途                                              |
| ------------------ | ------------------------------- | ------------------------------------------------------- |
| id                 | String，cuid()                  | 主键，安全 ID                                           |
| ownerUserId        | String                          | User.id FK，删除/更新 Restrict；由当前管理员身份取得    |
| operationId        | String，VarChar(128)            | 已登记的管理操作；用户修改固定 `patch.admin.users.id`   |
| resourceId         | String，VarChar(128)            | URL 目标 ID，与 operationId 一起定义幂等域              |
| idempotencyKeyHash | String，Char(64)                | Idempotency-Key 的 SHA-256 小写 hex；不存头原文         |
| requestHash        | String，Char(64)                | 已校验、规范化的非秘密 payload 的 JCS SHA-256           |
| status             | AdminCommandStatus，PENDING     | PENDING/RUNNING/RETRY_WAIT/SUCCEEDED/FAILED             |
| responseJson       | Json?                           | 仅终态安全结果；按操作使用用户、密钥或轮换 DTO；对象最大32KiB |
| errorCode          | String?，VarChar(64)            | FAILED 必需的受控大写错误码；SUCCEEDED 为 null          |
| attemptCount       | Int，0                          | 非负；每次成功领取恰加一                                |
| availableAt        | DateTime，now()，Timestamptz(3) | 不早于 createdAt；未到期不能领取                        |
| leaseOwner         | String?，VarChar(128)           | 当前 RUNNING 领取者，非 RUNNING 为 null                 |
| leaseUntil         | DateTime?，Timestamptz(3)       | 与 leaseOwner 同时有值；数据库时钟检查有效期            |
| fencingToken       | Int，0                          | 非负；每次成功领取恰加一，旧值不能提交 checkpoint/终态  |
| createdAt          | DateTime，now()，Timestamptz(3) | 幂等身份的一部分，创建后不可变                          |
| completedAt        | DateTime?，Timestamptz(3)       | 仅终态有值；终结时由数据库 `auth_now()` 规范化          |
| expiresAt          | DateTime，Timestamptz(3)        | 必需；不得缩短，至少终结数据库时刻后24小时              |

唯一约束为 `(ownerUserId,operationId,resourceId,idempotencyKeyHash)`，其 owner 最左前缀覆盖 FK 访问；`(status,availableAt,leaseUntil,id)` 支持领取扫描，expiresAt 单列索引支持后续受控保留清理。两个 hash 固定为64位小写 hex。活动记录没有 responseJson/errorCode/completedAt，RUNNING 必须同时有 leaseOwner/leaseUntil 且两个计数大于0；SUCCEEDED 必须有对象结果且无错误码，FAILED 必须有错误码。

SQL trigger 固定身份/requestHash，禁止终态更新和 TRUNCATE。同步用户命令可在同一业务事务直接插入 SUCCEEDED；已有活动收据必须从当前未过期 RUNNING claim 收敛，事务上下文中的 leaseOwner/fencingToken 要匹配。领取 PENDING、到期 RETRY_WAIT 或租约已失效的 RUNNING 时先锁行，再同时递增 attemptCount/fencingToken，租约至多60秒；TypeScript helper 接受1–60秒。重启后的新 claim 读取原记录续接，不重开终态。completedAt 和最低 expiresAt 以数据库时钟决定，调用方不能倒填历史完成时间缩短保留期。

DELETE 只可能针对已到 expiresAt 的终态且没有 KeyRotationRun 引用；活跃记录即使超过名义 TTL 仍保留。当前没有自动清理任务或轮换审计到期删除协议，因此轮换收据和下述 FK 链继续保留，不能由普通 TTL 任务拆除。

### 2.22 KeyRotationRun（Phase012）

| 字段              | 类型与默认值                         | 约束与用途                                                                               |
| ----------------- | ------------------------------------ | ---------------------------------------------------------------------------------------- |
| id                | String，cuid()                       | 主键                                                                                     |
| receiptId         | String，unique                       | AdminCommandReceipt.id FK，一份收据至多一条轮换记录                                      |
| oldKeyId          | String                               | ApiKeyConfig.id FK；必须与收据 resourceId 一致                                           |
| newKeyId          | String?                              | ApiKeyConfig.id FK；非空时不得等于 oldKeyId                                              |
| candidateIdsJson  | Json，[]                             | Phase013 扩展为 exact 六字段候选标识数组，最多127项/64KiB；空引用仍为 []                |
| referenceSetHash  | String，Char(64)                     | 完整引用集合的64位小写 SHA-256，创建后不可变                                             |
| baseRevisionsJson | Json                                 | 安全 ID 到非负 Int revision 的对象；helper 要求包含 oldKeyId，最多128项；数据库限制16KiB |
| stage             | KeyRotationStage，PREPARING          | PREPARING/TESTING/READY/ACTIVATED/ABORTED                                                |
| checkpointJson    | Json                                 | 必需 `{version:1,fencingToken,step}`，Phase013 只增加可选 errorCode/verificationHash；token 与 stage 均绑定 |
| createdAt         | DateTime，now()，Timestamptz(3)      | 创建后不可变，不得晚于数据库当前时间                                                     |
| updatedAt         | DateTime，@updatedAt，Timestamptz(3) | 单调且不晚于数据库当前时间                                                               |

三个 FK 均为 onDelete/onUpdate Restrict；receiptId unique 已覆盖其 FK，oldKeyId/newKeyId 分别建索引，`(stage,updatedAt,id)` 支持进度读取。run 身份、候选集合、引用 hash 和基线 revision 不可改；newKeyId 只允许在 PREPARING 时从 null 绑定一次。插入必须 PREPARING，然后只向 TESTING→READY→ACTIVATED 前进，非终态可以中止至 ABORTED；同阶段更新只续接 checkpoint。ACTIVATED/ABORTED 终态不可改，DELETE/TRUNCATE 均被拒绝。

`prepareKeyRotationRun` 先验证 live claim，再检查旧 key 为 ACTIVE 且 revision 匹配；可选新 key 必须是同 provider 的既存 DISABLED 行。helper 只持久化准备结果，不创建、启用、撤销或切换 key。首次准备与收据在调用方同一事务内执行，部分准备失败一起回滚；后续测试和推进必须消费已持久化的 checkpoint，旧 lease/fence 无法写入。Phase012 的准备基础由 Phase013 协调器消费，Phase016 共享 worker 尚未生产。

Phase013 追加 `20260912061403_key_rotation_contract`，只修复现有表的 SQL 约束和 trigger，保留原七份迁移及 Prisma schema。candidateIdsJson 每项精确为 `adapterId/referenceId/candidateId/configVersion/referenceRevision/contentHash`，adapterId/referenceId 唯一；版本为非负 Int，contentHash 为64位小写 hex。候选集合、引用 hash 与基线版本创建后不可变，未来 Provider 表不能通过本次迁移提前出现。

checkpoint 的可选 errorCode 只取 CONFIG_ERROR/PROVIDER_UNAVAILABLE/PROVIDER_TIMEOUT/VERSION_CONFLICT/INTERNAL_ERROR，限 TESTING/READY/ABORTED；verificationHash 是64位小写摘要，仅 READY/ACTIVATED 可有。ACTIVATED 必须已经验证、无错误、新密钥 ACTIVE 且旧密钥 REVOKED。服务在同一 Serializable 事务中完成所有 activation CAS、密钥状态、checkpoint、收据与逐次审计；测试失败留禁用候选及 RETRY_WAIT 收据，同键重试复用。实际 Provider 引用为空，两引用仅由隔离测试 schema 验证；模型与真实 adapter 于 Phase015 同时生产。

## 治理版本与激活字段

Phase015第一次即建最终模型。下表展开注册表的必填内容；只标`?`字段可空，其余非空，所有createdAt及内容hash不可变。精确复合FK不能退化为只引用id；所有版本引用采用Restrict，作者去标识只由专用隐私角色处理。

| 模型 | 固定字段与关系 | 唯一性、状态和生产边界 |
|---|---|---|
| PromptDefinition | id、key、purpose、createdAt | key unique；无生命周期，purpose为已注册的Prompt用途 |
| PromptVersion | id、definitionId FK、version、content、contentHash、variablesJson、responseSchemaVersion、createdById?、createdAt | (definitionId,version)/(definitionId,contentHash) unique；正文及版本不可变 |
| PromptActivation | definitionId PK/FK、championVersionId FK、revision、updatedBy?、updatedAt | champion同definition；与PromptModelActivation共同revision，不单独切换 |
| ModelDeployment | id、configVersion、providerId、providerModelName、paramsJson、capabilitiesJson、contextWindowTokens、contentHash、createdById?、createdAt | (id,configVersion) PK；无enabled/isDefault/modelName/model；不可变 |
| ProviderConfigVersion | providerId、configVersion、mode、baseUrl、capabilities、timeout/retry/quota/region/locale策略、credentialRequirement、secretRef? FK、contentHash、createdAt | (providerId,configVersion) PK；mode MOCK/LIVE，credentialRequirement NONE/REQUIRED；NONE=>secretRef=null且不发凭据，REQUIRED=>ACTIVE key |
| PromptModelActivation | definitionId PK/FK、promptVersionId、deploymentId/deploymentConfigVersion、providerId/providerConfigVersion、status、revision、updatedBy?、updatedAt | status ACTIVE/DISABLED；精确FK及兼容元组trigger；一次调用读一致性快照 |
| PlanningPolicyVersion | id、version、contentJson、contentHash、createdById?、createdAt | version unique；安全bootstrap与不可变单位/阈值；无状态 |
| PlanningPolicyActivation | policyKey PK、activeVersionId FK、revision、updatedBy?、updatedAt | 唯一active pointer，自身CAS不要求与Prompt revision相等 |
| AiUsageReservation | id、bucketKey、traceId、attemptNo、estimatedTokens、estimatedCost Decimal、actualTokens?、actualCost?、status、submissionState、providerRequestId?、expiresAt、createdAt、settledAt? | (traceId,attemptNo) unique；RESERVED/RECONCILING/SETTLED/RELEASED；NOT_SENT/MAY_HAVE_BEEN_SENT/ACCEPTED独立 |

activatePromptModelTuple在同一事务锁两指针、比较统一expectedVersion、检查组合后两边revision+1；数据库拒绝单侧更新。seed建完整但DISABLED的MOCK组合，ai.calls.enabled=false；只有受控服务先评测/激活完整元组再显式开启。新调用冻结全部治理版本，紧急停用仍在外呼前复核。过期/取消/未知计费只触发对账，不释放可能已花费的预留；可证明NOT_SENT零费用才RELEASED，无法对账按保守上界SETTLED。

Phase090的champion/challenger通过唯一PromptModelRollout落盘：固定两完整元组、dataset/gate评测引用、cohort规则，`trafficBasisPoints Int`在0..10000，revision>=0、createdAt/updatedAt、stoppedAt?。相同definition至多一条ACTIVE，分流不能另建平行activation，切换仍用activatePromptModelTuple。Phase091复用同表，模型评测gate policy复用不可变PromptGatePolicyVersion的新content schema版本并明确model维度，不创建第二个默认模型。ModelEvaluationRun绑定该精确gatePolicyVersionId、dataset与完整元组，结果不回写配置。

Phase092连接测试/健康记录固定存AdminCommandReceipt的不可变终态responseJson，operationId由该阶段API registry的connection-test注册；resourceId为编码的(providerId,configVersion)，response含availability=available/degraded/unavailable、checkedAt、durationMs、capability、errorCategory，不含原始响应。GET health读取最新已完成收据，不触发重复外呼；不存在结果明确unknown的响应分支，不作为第四个ProviderAvailability枚举。Phase093 dry-run用既有PlannerRun purpose=FACT_EVALUATION及PlanTrace=EVALUATED，结果与策略版本保存在被引用的PlanWorkspaceSnapshot.contentJson，不创建正式计划或改record。这些是已登记模型的消费扩展，不把可变治理状态放进不可变版本正文。

## 嵌入结构与禁止模型

所有实际Prisma模型均登记于上表，隐私独立schema的模型也在同一清单。以下概念有唯一映射但不是额外数据库表，后续卡不得仅因首字母大写就建表：

| 概念 | 唯一存储/输出映射 | 首次语义生产 |
|---|---|---|
| RequirementSnapshot | PlanWorkspaceSnapshot.contentJson中不可变需求快照；版本正文可包含用于解释的规范需求投影，受控原文仍在工作区 | Phase025；无独立表 |
| ManualEvidence | 冻结的版本化证据包，经NormalizedFact/SourceReference进入FactSnapshot.contentJson | Phase028；不是现场任意文本/无来源记录 |
| NormalizedFact/SourceReference | FactSnapshot.contentJson的facts/sourceCatalog，运行Schema校验 | Phase028规范、Phase030持久 |
| QualityReport | TravelPlanVersion.planJson.qualityReport，与三hash绑定 | Phase044校验、Phase049保存 |
| PlanViewModel/MapViewModel | 授权后派生DTO，不缓存私人数据为公共权威 | Phase065/074 |
| VersionDetailReceipt | Phase059版本详情只读响应DTO，不是持久表，不重复创建版本字段 |
| FeedbackReceipt/ShareGrantReceipt | 既有反馈/分享及幂等记录的安全响应，不保存秘密 | Phase095/088 |
| ProviderRegistry/ResolutionPolicy | 服务端注册/解析器与ProviderResolutionPolicyVersion内容 | Phase028/092 |
| GoldenCase/dataset manifest | 受版本管理的合成fixture及不可变manifest；不是产品用户数据表 | Phase046及后续评测卡 |

禁止模型清单：`Order`、`Payment`、`SocialFollow`、`OAuthAccount` 属V1排除事项；`PromptConfig`、`AiModelConfig` 为禁止过渡模型；`Asset` 为FileAsset禁止同义表。禁止同义字段：TravelRecord.planJson、currentVersion、finalPlanVersion，UserRole/sessionEpoch，ModelDeployment.model/modelName/enabled/isDefault。这里只说明禁止项，不作为模型定义。禁止把enabled/status并存作两套生命周期；前台DTO与Prisma字段名有明确投影关系，不为响应别名再加列。

## 字段命名规则

Prisma持久字段统一camelCase；布尔值以is/has/can开头，已有canonical布尔如parsedOk、degraded、contactConsent、evaluationConsent保持唯一原名并在对应表明确语义，不能另造同义列。生命周期使用封闭status，时间字段以At结尾；已有期限expiresAt/reservedUntil/leaseUntil及单位durationMs保持冻结名称。外键名以目标身份表达，引用时精确绑定版本/记录，数组下标、title、显示名不作身份。

## 时间字段规则

createdAt非空，default now()，使用PostgreSQL timestamptz(3)，服务端序列化为带时区的RFC3339。可变聚合updatedAt非空、自动更新；不可变版本、事件、收据不添加误导性updatedAt。deletedAt可空，仅对支持软删除的模型按首次擦除生产卡添加；不能在尚未规定删除能力时批量加软删除列。期限由数据库/注入clock统一，读时即判断过期，不等待清理job。时间戳不作CAS令牌。

## 状态字段规则

数据库生命周期默认Prisma enum、值大写下划线；每个对象在注册表和字段表列出完整集合。已冻结JSON语义如qualityStatus、FactStatus、freshness、availability、quick/precise采用原小写值，Prisma映射或CHECK必须逐值保持一致，不再发明大写同义枚举。枚举约束只保证值集合，转换条件、终态、取消与失败仍按state-machines和服务事务验证。新增状态须先同步本设计、canonical允许的演进、迁移与反向测试。

## JSON 字段规则

新JSON列以Json结尾并用Prisma Json；序列化/反序列化均用唯一Schema校验，不能保存未校验AI输出。JSON列命名的冻结例外为factSnapshotRefs、ProviderConfigVersion.capabilities等生产卡已明确名称，必须登记其结构，不能额外加同义Json列。ApiKeyConfig.encryptedKey单独使用String @db.Text，存RFC8785 JCS canonical JSON文本并在解析后校验envelope Schema，不是Prisma Json列。

TravelRecord只存requirementJson和版本指针，正式正文唯一在TravelPlanVersion.planJson；质量报告与版本同保存，工作区/事实快照不可变。金额业务值使用decimal string/null和明确currency、scope、舍入，数据库费用预留使用Decimal，不用浮点，不以0冒充未知。JSON里引用同样须核验归属；Prisma无法表达的跨JSON引用约束在持锁事务完整解析并集成测试，不能以“不是外键”免验。

## 索引规则

PostgreSQL不会自动为外键创建引用列索引；主键和unique自带索引，但必须检查最左前缀是否覆盖目标访问模式。每个FK在首次迁移记录读取、删除检查和联表路径，并明确`@@index`或已有复合unique覆盖的决定，用EXPLAIN查询计划或真实隔离集成测试证明。不能因“已有外键”跳过设计，也不重复创建等价索引。

业务owner列表用(owner,createdAt,id)稳定分页，版本历史用(travelRecordId,version)，精确配置追溯用完整复合版本，DurableTask的任务claim用(status,availableAt,leaseUntil,id)；nextAttemptAt仅属于DataRequest ERASE续接，不作为共享worker领取字段。限流用双bucket时间窗。nullable字段、部分unique、append-only、同记录复合FK和DEFERRABLE由迁移SQL表达并被测试验证；不只在Prisma注释声称成立。大数据索引调整按实际query plan和相应性能卡执行，不在本卡声称已测查询性能。

## 数据库迁移规则

每次Schema变更在隔离开发数据库执行 `npx prisma migrate dev --name <description>`，或映射相同命令的 `npm run db:migrate -- --name <description>`，负责生成并应用新迁移。`npm run db:generate` 映射 `prisma generate`，只生成Prisma Client，不生成迁移。迁移目录保留Prisma生成时间戳前缀，已应用迁移不可手工改写；修复新建迁移，提交schema/migrations与依赖锁文件。

禁止以db push/migrate reset替代可审计迁移。生产应用迁移由后续部署流程显式migrate deploy执行，启动不隐式migrate/seed。每卡验证数据库身份、版本、所有新增CHECK/FK/unique/trigger、回滚和实际Client类型；生产阶段未到不创建模型。新增或细化字段先更新本文件并登记producer/evolution，再同步Prisma，禁止在路线卡复制冲突表定义。

## seed 执行规则

Phase010 的 `npm run db:seed` 由 `prisma/seed.ts` 读取统一 `env-cli` parser；`ADMIN_EMAIL/ADMIN_INITIAL_PASSWORD` 登记为 `scope=cli`、`producerPhase=10`、`requiredWhen=seed`，不属于 Web 启动必需集，也不进入 `.env.example`。入口只消费它们和 `NODE_ENV/DATABASE_URL`，不要求 Auth 或 Provider 凭据。必须显式指定 development/test；production、缺失或未知环境在创建数据库客户端前拒绝。目标仅限与本次 run 标记一致的 loopback disposable PostgreSQL17，核对数据库名、comment、最小权限运行角色和全部已应用迁移的名称/checksum/完成状态后才读取业务表；具体命名与部署限制见 [托管规范](hosting.md)。

`ADMIN_EMAIL` 经 normalizeEmailV1；密码不 trim、不改大小写或 Unicode，必须是合法 UTF-8 12–72 bytes，包含大小写字母、数字和非空白特殊字符，拒绝控制字符，使用 bcryptjs cost12。合成密码由 CSPRNG 生成并仅用于隔离环境；原值不写文档、输出、审计或证据。基础 seed 只 create，不用 upsert/update：规范邮箱不存在时创建 ADMIN/ACTIVE；已存在时，仅匹配本次 seed 来源的 ACTIVE ADMIN 才可视为重放。USER、DISABLED ADMIN、无来源的管理员或任一来源/凭据冲突均失败，不提权、启用或重置口令。

来源保存在同事务的 append-only 创建审计中，不增加 User/SystemConfig 的 seed 平行列。`sourceMarker=PHASE010_BASE_SEED_V1`，稳定的非秘密 `seedRunId` 由 disposable 命名中的阶段/项目标识和12位运行标识派生。管理员创建审计的 `seedFingerprint` 是以下对象的 JCS UTF-8 SHA-256：`sourceMarker/seedRunId/id/email/passwordHash/role/status/revision/sessionVersion/createdAt`，createdAt 使用 ISO 时间；不保存明文密码的直接摘要。重放要求唯一匹配的 SEED_ADMIN_CREATE、目标行 ID、MIGRATION 系统主体、来源、当前行指纹及 bcrypt cost12 密码验证全部一致。完整匹配才返回 UNCHANGED；变更邮箱或已改动的角色、状态、口令、revision/sessionVersion、来源指纹不会触发修复性写入。

冻结基础配置如下，均为 `group=GENERAL`、`isPublic=false`，不进入 publicProjection。已有同 key 时，valueJson、group 和内部可见性必须一致；不一致即整事务失败。相同内容保持原有描述、revision、时间及操作者信息，缺失项才创建。

| key | valueJson |
|---|---|
| planner.quick.defaultDurationDays | 3 |
| planner.quick.defaultTravelerCount | 1 |
| planner.quick.defaultPace | "moderate" |

首次空库应得到1个管理员、3项配置及4条创建审计；同输入重复 seed 新增/更新业务行和新增审计均为0。业务创建和审计在同一 Serializable 事务；仅 serialization/unique 冲突按固定25/50/100ms退避最多重试3次，每次重读并验证全部内容。耗尽后只做一次只读核对；缺行或冲突仍非零退出，不能把竞争失败伪装成成功。审计失败回滚本次全部创建。

部署环境变量是不可被 DB 动态突破的硬上限，类型化 SystemConfig 只在该范围内提供运行值；seed 默认值只用于首次缺失项初始化，不覆盖已有配置。完整配置优先级与治理来源见 [托管规范](hosting.md)。Phase010 不插入 ApiKeyConfig，不创建 Prompt、Model、Provider、AiOutputRecord 等治理表或记录，也不将 AI_API_KEY 复制到数据库。

Phase015独立seed创建首次不可变Prompt/Model/Provider/PlanningPolicy版本及对应指针，不存在来源过渡表和搬迁导入。MOCK组合DISABLED、ai.calls.enabled=false，经正式受控服务评测/激活后才显式启用。后续扩Prompt产生新不可变版本，不能更新已激活正文或用seed重置用户状态。

## 敏感字段存储规则

API Key使用版本化AES-256-GCM envelope，当前key来自ENCRYPTION_KEY；encryptionKeyId为解码后32字节主key的SHA-256小写64位hex，保留key ring升级空间。envelope v1精确字段为version/keyId/algorithm/iv/ciphertext/tag，version=1、algorithm=A256GCM；只有iv/ciphertext/tag使用带标准padding的canonical base64，解码长度分别12 bytes、1-16384 bytes、16 bytes。version/keyId分别匹配envelopeVersion/encryptionKeyId；RFC8785 JCS文本存于encryptedKey。AAD由recordId/provider/envelopeVersion的JCS UTF-8字节派生，不增加envelope字段。禁止IV重用、解密失败回退明文、原地覆盖旧密文。原始秘密仅一次请求内存可见，日志、Git、审计、截图、公共/ADMIN响应都不读回。

密码不trim/lowercase/Unicode改写，UTF-8长度12-72 bytes后使用bcryptjs cost 12；超过72必须拒绝，不能让bcrypt截断。会话token、匿名token、分享token、反馈/数据请求receipt和Idempotency-Key原文不落库；分别存tokenHash、anonTokenHash及领域hash，IP/account用服务端HMAC减少离线枚举。sessionVersion用于全部session撤销，退出仍单行CAS撤销。

权限、隐私水位和业务状态在读取/发送前重新验证。普通业务删除遵循注册表Restrict/Cascade/SetNull和pin；专用ERASE先独立ledger意图、再禁读/清理/outbox对账，恢复备份先重放水位，不因备份回滚或token轮换复活私人数据。不可变业务版本保留不意味着永久保留已要求删除的个人正文。
