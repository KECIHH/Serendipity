# Serendipity · 际遇 API 与事件契约

owner 为 API contract；producerPhase=2，registry 中的 producerPhase 是首次可运行端点阶段。权威顺序与[项目宪法](project-constitution.md)、[数据库设计](database.md)一致。本文件是唯一 API 项目规范，响应字段不反向产生数据库同义列。Phase002 只生成文档与文档检查器，路由、服务、数据库、网络调用均 NOT_CREATED。

路线包输入：规范化绝对来源、SHA-256 与只读 producer/evolvesAt 卡集合均固定在 [Phase002 输入](phase-plans/Phase002-inputs.json)。端点目录唯一来源为该清单指向的 `roadmap-execution-manifest.json.apiRegistry`，公共策略为同文件 `apiPolicy`；canonical 3、3.9、3.10 展开如下。每次更改后运行 `node scripts/generate-api-contract.mjs --check` 及 `node docs/phase-plans/verify-phase002.mjs --case api`。不得手工修改生成区；合法已登记输入更新才可运行 `--write`，本 run 不更换冻结 manifest。

## 响应与错误

成功 JSON exact 为 `{success:true,data,requestId}`；失败 JSON exact 为 `{success:false,error:{code,message,details?},requestId}`。requestId 由服务端产生，不信任客户端值；同一调用的日志/trace/错误保留相同 requestId/traceId。message 仅安全模板，details 仅本文列明的安全字段，未知异常不含底层异常、SQL、原始输出、Prompt 或秘密。二进制成功响应与 SSE 按 registry 声明传输，失败在发送首字节前使用 JSON 信封。

| HTTP | code | 安全语义与恢复 |
|---|---|---|
| 400 | VALIDATION_ERROR | exact DTO、长度、格式或引用无效；details 只列字段路径/规则代码 |
| 401 | AUTH_REQUIRED | 缺活动 session；匿名首稿无有效 Cookie 时 details.action=BOOTSTRAP_ANONYMOUS_SESSION |
| 403 | FORBIDDEN | 已认证但无 ADMIN 权限；不用于可枚举私人对象 |
| 404 | NOT_FOUND | 不存在、非 owner、无效/撤销/过期 share/receipt、公开停用均同一响应 |
| 409 | IDEMPOTENCY_KEY_REUSED | 同域同键异规范化 payload 或 receipt，零业务写入与外呼 |
| 409 | VERSION_CONFLICT | details={currentVersion,currentRequirementRevision?,action:RELOAD}，安全当前摘要按对应 DTO；零局部写入 |
| 409 | PLANNING_IN_PROGRESS、USE_PLAN_MUTATION、REQUIREMENT_CONFIRMATION_REQUIRED | registry 已登记的领域冲突；分别读取现有 run、采用修改命令、展示差异后显式确认 |
| 410 | RESYNC_REQUIRED | checkpoint 超出重放窗口；重新读取持久消息和聚合终态，不拼接缺失 delta |
| 429 | RATE_LIMITED、COST_LIMIT | 安全 Retry-After；费用只在有可证明余量时重试 |
| 503 | FEATURE_DISABLED | 仅已授权私有操作；retryable=false，直到管理员显式恢复；公开仍 404 |
| 503 | CONFIG_ERROR | 必需配置缺失、失效或秘密解密失败；不得返回具体密文/解密原因 |
| 503 | PROVIDER_UNAVAILABLE、PROVIDER_TIMEOUT | 按固定策略有限重试/降级，不由 AI 补事实 |
| 409 | CANCELLED | 取消已获唯一终态；读取原收据，不重开操作 |
| 500 | INTERNAL_ERROR | 未分类错误脱敏，requestId 可用于安全关联 |

`apiPolicy.errorPolicy.operationErrorsAreAdditional=true`：registry 每行 errors 是该操作附加错误，公共格式、认证、权限及未知错误边界同时适用。Phase053 已登记演进中的 OPERATION_NOT_AVAILABLE(409)、CONFIRMATION_EXPIRED(410)，Phase062 的 REVALIDATION_REQUIRED(409) 是该生产卡明确的领域分支；不得借此增设业务路由。`INVALID_JSON`、`SCHEMA_MISMATCH` 仅 AI attempt 内部分类，对普通 API 映射 503 PROVIDER_UNAVAILABLE；有 ADMIN 权限的 mock/debug 安全结果可查看这两个分类。`SECRET_DECRYPT_FAILED` 仅服务端安全日志/审计，公开统一 CONFIG_ERROR。

SafeCommandError.code 与 widget.error.code 只取机器块 errors 中的公开码；FEATURE_DISABLED 的 retryable 必须 false。受保护调试的 diagnosticCategory 属于独立字段，不能放入普通错误 code。

## 身份、秘密和并发

| access | 凭据与能力 |
|---|---|
| anonymous/PUBLIC | 无秘密授权；anonymous 是 registry 的公开边界标签，不代表匿名业务 owner |
| ANON | 签名 httpOnly `anon_token` Cookie，服务端验证 256-bit 随机值；数据库只存 anonTokenHash |
| USER | 活动 AuthSession + User ACTIVE + audience/role/sessionVersion/到期检查 |
| owner | 从资源当前 TravelRecord 解析 ANON/USER 归属；Phase082 使用已消费匿名 alias 恢复历史幂等，不改历史 ownerKeyHash |
| ADMIN | USER 检查后再检查 ADMIN；角色不自动授予私人计划读取/导出 |
| SHARE | 固定版本的有效 ShareGrant；后续操作用 X-Share-Token，按显式最小访问上下文鉴权 |
| DATA_RECEIPT | X-Data-Request-Receipt 只授自身最小状态查询；无下载、个人资料或写权限 |
| FEEDBACK_RECEIPT / FEEDBACK_OWNER_OR_RECEIPT | 独立 X-Feedback-Receipt 或原反馈提交者，仅读自身状态及管理自身同意；计划 owner 不是 guest 反馈 owner |
| ASSET_USAGE_CONTEXT | 实时 AssetUsage/资产/版权/purpose/版本/水位检查；签名不替代授权 |

登录/退出只使用 Phase011 Auth.js GET/POST `/api/auth/[...nextauth]` framework handler，单列于 apiPolicy，不是额外业务路由。凭据、session、CSRF 与重新认证详见[认证](auth.md)，ADMIN revision/最后管理员/审计详见[管理](admin.md)，秘密 envelope 详见[密码学](crypto.md)。所有 Cookie 写命令验证 Origin/CSRF，权限检查在接受和最终提交/发送前重新执行。

URL path 参数是资源身份唯一来源，JSON 不重复 id/userId/travelRecordId/planVersionId 等同义身份。query 仅筛选、固定版本选择及分页；不传令牌。Idempotency-Key 固定 8-128 安全字符，仅请求头；服务端存 SHA-256，不保存原文。规范化先严格校验 DTO、trim 规定的文本、保持数组语义、明确 null/缺省，再 RFC8785 JCS + SHA-256。密码、Cookie、receipt/token 原文先剥离；需要绑定的一次性字段只把 receiptHash、keyFingerprint 加入散列。

默认幂等域为 serverDerivedOwner + operationId + resourceId；ADMIN 由 AdminCommandReceipt 持有，其他写入由相应首次 producer 的领域收据/命令持有，不增设平行账本。PLAN_DRAFT/CHAT_MESSAGE 特例固定 `(ownerKeyHash,ChatCommand.kind,idempotencyKeyHash)`；Replan/Restore/RequirementPatch/Revalidation 固定 owner+record+key，clone 固定 owner+key。活动命令不按 TTL 删除；终态至少24小时，领域结果收据与聚合同保留，具体合成期限见[隐私](privacy-and-user-data.md)。同键同 payload 先回放原结果且 replayed=true；客户端技术重发不新建 command/run/message/version。秘密交付例外见后文。

所有版本写入比较明确 expectedVersion、expectedRequirementRevision、expectedCurrentVersion、expectedProfileVersion 或 expectedRunState；治理正文 configVersion 不是 activation revision。CAS、业务变更、终态/审计/outbox 同事务，失败无局部结果。终态重放不重新校验已过时的原 CAS 以制造第二结果，但每次读取/发送仍重新检查当前授权、撤回水位与资源有效性。普通 read 不触发 Provider 调用。

游标是不透明且签名的字符串，绑定排序、筛选 hash、读取水位和 owner 域。默认 limit=20、范围1-100，按(createdAt DESC,id DESC)；conversation 按(sequence ASC,id ASC)，版本按(version DESC,id DESC)，Phase099 默认pageSize=50、范围1-100并冻结读取水位。只按 createdAt 排序不合法；篡改、跨筛选/owner 使用返回 VALIDATION_ERROR。

## 唯一端点目录

以下10列全部从 registry 生成，排序键为 operationId；这是唯一 method/path/首次生产者表。语义上 request/response 的 exact 展开由后面的机器块按 operationId 关联；不改写上游登记的显示名称。

<!-- api-registry:start -->
| operationId | method | path | auth | request | response | errors | idempotency | cas | producerPhase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| assets.derivative | GET | /api/assets/{assetId}/derivatives/{derivativeId} | ASSET_USAGE_CONTEXT | AssetUsage access context | Derivative bytes (no-store) | NOT_FOUND | NONE | NONE | 96 |
| dataRequests.create | POST | /api/me/data-requests | USER | DataRequestCreate: type, expectedVersion, causationId?; ERASE requires reauthentication; X-Data-Request-Receipt header | DataRequestReceipt backed by durable accepted intent | NOT_FOUND, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED, VERSION_CONFLICT, AUTH_REQUIRED, FEATURE_DISABLED | HEADER_OWNER_OPERATION | expectedVersion -> User.revision | 84 |
| dataRequests.download | GET | /api/me/data-requests/{id}/download | USER | path id | EXPORT archive bytes | NOT_FOUND | NONE | NONE | 84 |
| dataRequests.get | GET | /api/me/data-requests/{id} | USER | path id | DataRequestStatus | NOT_FOUND | NONE | NONE | 84 |
| dataRequests.receipt | GET | /api/data-requests/receipt | DATA_RECEIPT | X-Data-Request-Receipt header | MinimalDataRequestStatus | NOT_FOUND | NONE | NONE | 84 |
| delete.me.favorites.planVersionId | DELETE | /api/me/favorites/{planVersionId} | USER | — | `FavoriteReceipt` | AUTH_REQUIRED, NOT_FOUND | HEADER_OWNER_OPERATION | NONE | 86 |
| delete.shares.shareId | DELETE | /api/shares/{shareId} | USER | ShareRevokeRequest: expectedVersion | `ShareGrantReceipt` | AUTH_REQUIRED, NOT_FOUND, VERSION_CONFLICT, IDEMPOTENCY_KEY_REUSED, VALIDATION_ERROR | HEADER_OWNER_OPERATION | expectedVersion -> ShareGrant.revision | 88 |
| feedback.consents | PATCH | /api/feedback/{feedbackId}/consents | FEEDBACK_OWNER_OR_RECEIPT | FeedbackConsentsPatch: expectedVersion, contactConsent, evaluationConsent | FeedbackReceiptStatus | NOT_FOUND, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED, VERSION_CONFLICT | HEADER_OWNER_OPERATION | expectedVersion -> TravelQualityFeedback.revision | 95 |
| feedback.get | GET | /api/feedback/{feedbackId} | FEEDBACK_OWNER_OR_RECEIPT | path feedbackId | FeedbackReceiptStatus | NOT_FOUND | NONE | NONE | 95 |
| feedback.receipt | GET | /api/feedback/receipt | FEEDBACK_RECEIPT | X-Feedback-Receipt header | FeedbackReceiptStatus | NOT_FOUND | NONE | NONE | 95 |
| get.admin.ai-debug.runs.id | GET | /api/admin/ai-debug/runs/{id} | ADMIN | — | `AiDebugStatus`（精确attemptId集合及最终安全摘要） | AUTH_REQUIRED, FORBIDDEN, NOT_FOUND | NONE | NONE | 18 |
| get.admin.announcements | GET | /api/admin/announcements | ADMIN | query cursor/filter | version | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED | NONE | NONE | 94 |
| get.admin.api-keys | GET | /api/admin/api-keys | ADMIN | query cursor/filter | masked key | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED | NONE | NONE | 13 |
| get.admin.assets | GET | /api/admin/assets | ADMIN | query cursor/filter | `FileAsset` | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED | NONE | NONE | 96 |
| get.admin.dashboard.stats | GET | /api/admin/dashboard/stats | ADMIN | — | `DashboardStats` | AUTH_REQUIRED, FORBIDDEN | NONE | NONE | 14 |
| get.admin.feedback | GET | /api/admin/feedback | ADMIN | query cursor/filter | `FeedbackPage` | AUTH_REQUIRED, FORBIDDEN | NONE | NONE | 95 |
| get.admin.feedback.id | GET | /api/admin/feedback/{id} | ADMIN | — | `FeedbackDetail` | AUTH_REQUIRED, FORBIDDEN, NOT_FOUND | NONE | NONE | 95 |
| get.admin.logs | GET | /api/admin/logs | ADMIN | query cursor/filter | `AuditLogPage` | AUTH_REQUIRED, FORBIDDEN | NONE | NONE | 13 |
| get.admin.logs.planning | GET | /api/admin/logs/planning | ADMIN | query cursor/filter | `PlanTracePage` | AUTH_REQUIRED, FORBIDDEN | NONE | NONE | 99 |
| get.admin.logs.planning.traceId | GET | /api/admin/logs/planning/{traceId} | ADMIN | — | `PlanTraceSummary` | AUTH_REQUIRED, FORBIDDEN, NOT_FOUND | NONE | NONE | 99 |
| get.admin.model-deployments | GET | /api/admin/model-deployments | ADMIN | query cursor/filter | version | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED | NONE | NONE | 91 |
| get.admin.planning-policies | GET | /api/admin/planning-policies | ADMIN | query cursor/filter | version | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED | NONE | NONE | 93 |
| get.admin.prompts | GET | /api/admin/prompts | ADMIN | query cursor/filter | `PromptVersion` | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED | NONE | NONE | 90 |
| get.admin.provider-configs | GET | /api/admin/provider-configs | ADMIN | query cursor/filter | version | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED | NONE | NONE | 92 |
| get.admin.provider-configs.providerId.versions.configVersion.health | GET | /api/admin/provider-configs/{providerId}/versions/{configVersion}/health | ADMIN | — | `ProviderHealth` | AUTH_REQUIRED, FORBIDDEN, NOT_FOUND | NONE | NONE | 92 |
| get.admin.settings | GET | /api/admin/settings | ADMIN | — | `AdminSettings` | AUTH_REQUIRED, FORBIDDEN | NONE | NONE | 14 |
| get.admin.users | GET | /api/admin/users | ADMIN | query cursor/filter | `AdminUserPage` | AUTH_REQUIRED, FORBIDDEN | NONE | NONE | 12 |
| get.announcements | GET | /api/announcements | anonymous | query cursor | public announcements | INTERNAL_ERROR | NONE | NONE | 94 |
| get.chat-commands.id.events | GET | /api/chat-commands/{id}/events | owner | query `afterSequence` | `EventEnvelope[]` | NOT_FOUND, RESYNC_REQUIRED | NONE | NONE | 51 |
| get.config.public | GET | /api/config/public | anonymous | — | allowlisted `PublicConfig` | INTERNAL_ERROR | NONE | NONE | 14 |
| get.health | GET | /api/health | anonymous | — | `HealthResponse` | INTERNAL_ERROR | NONE | NONE | 120 |
| get.me.favorites | GET | /api/me/favorites | USER | query cursor | `FavoritePage` | AUTH_REQUIRED | NONE | NONE | 86 |
| get.me.travel-profile | GET | /api/me/travel-profile | USER | — | `TravelProfile` | AUTH_REQUIRED | NONE | NONE | 84 |
| get.me.travel-records | GET | /api/me/travel-records | USER | query cursor | `TravelRecordPage` | AUTH_REQUIRED | NONE | NONE | 85 |
| get.planner-runs.id.events | GET | /api/planner-runs/{id}/events | owner | query `afterSequence` | `EventEnvelope[]` | NOT_FOUND, RESYNC_REQUIRED | NONE | NONE | 26 |
| get.public.shares.token | GET | /api/public/shares/{token} | SHARE | — | public `PlanViewModel` projection | NOT_FOUND, RATE_LIMITED | NONE | NONE | 88 |
| get.readiness | GET | /api/readiness | anonymous | — | `ReadinessResponse` | INTERNAL_ERROR | NONE | NONE | 120 |
| get.shares | GET | /api/shares | USER | query cursor | `ShareGrantPage` | AUTH_REQUIRED | NONE | NONE | 88 |
| get.travel-records.id | GET | /api/travel-records/{id} | owner | query `planVersionId?` | `PlanViewModel` | NOT_FOUND | NONE | NONE | 65 |
| get.travel-records.id.conversation | GET | /api/travel-records/{id}/conversation | owner | query cursor | `ConversationPage` | NOT_FOUND | NONE | NONE | 52 |
| get.travel-records.id.version-diff | GET | /api/travel-records/{id}/version-diff | owner | query `fromVersion,toVersion` | `PlanDiff` | NOT_FOUND, VALIDATION_ERROR | NONE | NONE | 59 |
| get.travel-records.id.versions | GET | /api/travel-records/{id}/versions | owner | query cursor | `VersionSummaryPage` | NOT_FOUND | NONE | NONE | 59 |
| get.travel-records.id.versions.version | GET | /api/travel-records/{id}/versions/{version} | owner | — | VersionDetailReceipt (Phase059), PlanViewModel adapter (Phase065) | NOT_FOUND | NONE | NONE | 59 |
| patch.admin.announcements.id | PATCH | /api/admin/announcements/{id} | ADMIN | `AnnouncementPatch` | version | AUTH_REQUIRED, FORBIDDEN, VERSION_CONFLICT | HEADER_OWNER_OPERATION | announcement revision | 94 |
| patch.admin.api-keys.id | PATCH | /api/admin/api-keys/{id} | ADMIN | `ApiKeyPatch` | masked key | AUTH_REQUIRED, FORBIDDEN, VERSION_CONFLICT | HEADER_OWNER_OPERATION | key revision | 13 |
| patch.admin.assets.id | PATCH | /api/admin/assets/{id} | ADMIN | `AssetPatch` | `FileAsset` | AUTH_REQUIRED, FORBIDDEN, VERSION_CONFLICT | HEADER_OWNER_OPERATION | asset revision | 96 |
| patch.admin.feedback.id | PATCH | /api/admin/feedback/{id} | ADMIN | `FeedbackTriagePatch` | `FeedbackDetail` | AUTH_REQUIRED, FORBIDDEN, NOT_FOUND, VERSION_CONFLICT | HEADER_OWNER_OPERATION | feedback revision | 95 |
| patch.admin.settings.key | PATCH | /api/admin/settings/{key} | ADMIN | `SettingPatch` | `AdminSetting` | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, VERSION_CONFLICT | HEADER_OWNER_OPERATION | setting revision | 14 |
| patch.admin.users.id | PATCH | /api/admin/users/{id} | ADMIN | `AdminUserPatch` | `AdminUser` | AUTH_REQUIRED, FORBIDDEN, NOT_FOUND, VERSION_CONFLICT | HEADER_OWNER_OPERATION | user revision | 12 |
| patch.me.travel-profile | PATCH | /api/me/travel-profile | USER | `TravelProfilePatch` | `TravelProfile` | AUTH_REQUIRED, VALIDATION_ERROR, VERSION_CONFLICT | HEADER_OWNER_OPERATION | profile revision | 84 |
| patch.travel-records.id.requirements | PATCH | /api/travel-records/{id}/requirements | owner | RequirementPatchCommand (exact Phase062); no path id in body | RequirementReceipt | VALIDATION_ERROR, NOT_FOUND, IDEMPOTENCY_KEY_REUSED, VERSION_CONFLICT, PLANNING_IN_PROGRESS, USE_PLAN_MUTATION, FEATURE_DISABLED | HEADER_OWNER_OPERATION | expectedRequirementRevision + record version=0 + no active run | 62 |
| plans.revalidate | POST | /api/travel-plan-versions/{planVersionId}/revalidations | USER | RevalidationRequest: expectedVersion, expectedRequirementRevision, pendingOverrides?, causationId? | PlannerRunReceipt | NOT_FOUND, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED, VERSION_CONFLICT, FEATURE_DISABLED, PROVIDER_UNAVAILABLE | HEADER_OWNER_OPERATION | expectedVersion + expectedRequirementRevision | 85 |
| post.admin.ai-debug.stream | POST | /api/admin/ai-debug/stream | ADMIN | `AiDebugRequest` | SSE `AiDebugReceipt`/delta/final | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, CONFIG_ERROR, PROVIDER_UNAVAILABLE, IDEMPOTENCY_KEY_REUSED, FEATURE_DISABLED, PROVIDER_TIMEOUT, RATE_LIMITED, COST_LIMIT, CANCELLED | HEADER_OWNER_OPERATION | NONE | 18 |
| post.admin.ai-debug.test | POST | /api/admin/ai-debug/test | ADMIN | `AiDebugRequest` | `AiDebugReceipt` | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, CONFIG_ERROR, PROVIDER_UNAVAILABLE, IDEMPOTENCY_KEY_REUSED, FEATURE_DISABLED, PROVIDER_TIMEOUT, RATE_LIMITED, COST_LIMIT, CANCELLED | HEADER_OWNER_OPERATION | NONE | 18 |
| post.admin.announcements | POST | /api/admin/announcements | ADMIN | `AnnouncementCreate` | version | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED | HEADER_OWNER_OPERATION | announcement revision | 94 |
| post.admin.api-keys | POST | /api/admin/api-keys | ADMIN | `ApiKeyCreate` | masked key | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED | HEADER_OWNER_OPERATION | NONE | 13 |
| post.admin.api-keys.id.rotate | POST | /api/admin/api-keys/{id}/rotate | ADMIN | `ApiKeyRotateRequest` | masked key | AUTH_REQUIRED, FORBIDDEN, IDEMPOTENCY_KEY_REUSED, VALIDATION_ERROR, VERSION_CONFLICT, CONFIG_ERROR, NOT_FOUND | HEADER_OWNER_OPERATION | key revision | 13 |
| post.admin.assets | POST | /api/admin/assets | ADMIN | `AssetCreate` | `FileAsset` | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED | HEADER_OWNER_OPERATION | asset revision | 96 |
| post.admin.feedback.id.regression-candidates | POST | /api/admin/feedback/{id}/regression-candidates | ADMIN | `RegressionCandidateCreate` | candidate | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED | HEADER_OWNER_OPERATION | feedback revision | 95 |
| post.admin.model-deployments | POST | /api/admin/model-deployments | ADMIN | `ModelDeploymentCreate` | version | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED | HEADER_OWNER_OPERATION | deployment revision | 91 |
| post.admin.model-deployments.id.rollback | POST | /api/admin/model-deployments/{id}/rollback | ADMIN | `RollbackRequest` | activation | AUTH_REQUIRED, FORBIDDEN, VERSION_CONFLICT | HEADER_OWNER_OPERATION | activation revision | 91 |
| post.admin.model-deployments.id.versions.configVersion.activate | POST | /api/admin/model-deployments/{id}/versions/{configVersion}/activate | ADMIN | `ActivationRequest` | activation | AUTH_REQUIRED, FORBIDDEN, VERSION_CONFLICT | HEADER_OWNER_OPERATION | activation revision | 91 |
| post.admin.model-deployments.id.versions.configVersion.disable | POST | /api/admin/model-deployments/{id}/versions/{configVersion}/disable | ADMIN | `DisableRequest` | activation | AUTH_REQUIRED, FORBIDDEN, VERSION_CONFLICT | HEADER_OWNER_OPERATION | activation revision | 91 |
| post.admin.model-deployments.id.versions.configVersion.evaluations | POST | /api/admin/model-deployments/{id}/versions/{configVersion}/evaluations | ADMIN | `ModelEvaluationRequest` | run | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED | HEADER_OWNER_OPERATION | version fixed | 91 |
| post.admin.planning-policies | POST | /api/admin/planning-policies | ADMIN | `PlanningPolicyCreate` | version | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED | HEADER_OWNER_OPERATION | policy revision | 93 |
| post.admin.planning-policies.id.activate | POST | /api/admin/planning-policies/{id}/activate | ADMIN | `ActivationRequest` | activation | AUTH_REQUIRED, FORBIDDEN, VERSION_CONFLICT | HEADER_OWNER_OPERATION | activation revision | 93 |
| post.admin.planning-policies.id.dry-runs | POST | /api/admin/planning-policies/{id}/dry-runs | ADMIN | `PolicyDryRunRequest` | `DryRunReport` | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED | HEADER_OWNER_OPERATION | policy fixed | 93 |
| post.admin.planning-policies.id.rollback | POST | /api/admin/planning-policies/{id}/rollback | ADMIN | `RollbackRequest` | activation | AUTH_REQUIRED, FORBIDDEN, VERSION_CONFLICT | HEADER_OWNER_OPERATION | activation revision | 93 |
| post.admin.prompts | POST | /api/admin/prompts | ADMIN | `PromptCandidateCreate` | `PromptVersion` | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED | HEADER_OWNER_OPERATION | definition revision | 90 |
| post.admin.prompts.promptKey.rollback | POST | /api/admin/prompts/{promptKey}/rollback | ADMIN | `RollbackRequest` | `PromptActivation` | AUTH_REQUIRED, FORBIDDEN, VERSION_CONFLICT | HEADER_OWNER_OPERATION | activation revision | 90 |
| post.admin.prompts.promptKey.versions.version.activate | POST | /api/admin/prompts/{promptKey}/versions/{version}/activate | ADMIN | `ActivationRequest` | `PromptActivation` | AUTH_REQUIRED, FORBIDDEN, VERSION_CONFLICT, VALIDATION_ERROR | HEADER_OWNER_OPERATION | activation revision | 90 |
| post.admin.prompts.promptKey.versions.version.evaluations | POST | /api/admin/prompts/{promptKey}/versions/{version}/evaluations | ADMIN | `PromptEvaluationRequest` | `PromptEvaluationRun` | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED | HEADER_OWNER_OPERATION | version fixed | 90 |
| post.admin.provider-configs | POST | /api/admin/provider-configs | ADMIN | `ProviderConfigCreate` | version | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED | HEADER_OWNER_OPERATION | provider revision | 92 |
| post.admin.provider-configs.providerId.versions.configVersion.activate | POST | /api/admin/provider-configs/{providerId}/versions/{configVersion}/activate | ADMIN | `ActivationRequest` | activation | AUTH_REQUIRED, FORBIDDEN, VERSION_CONFLICT | HEADER_OWNER_OPERATION | activation revision | 92 |
| post.admin.provider-configs.providerId.versions.configVersion.connection-tests | POST | /api/admin/provider-configs/{providerId}/versions/{configVersion}/connection-tests | ADMIN | `ConnectionTestRequest` | `ProviderHealth` | AUTH_REQUIRED, FORBIDDEN, CONFIG_ERROR, RATE_LIMITED | HEADER_OWNER_OPERATION | version fixed | 92 |
| post.admin.provider-configs.providerId.versions.configVersion.disable | POST | /api/admin/provider-configs/{providerId}/versions/{configVersion}/disable | ADMIN | `DisableRequest` | activation | AUTH_REQUIRED, FORBIDDEN, VERSION_CONFLICT | HEADER_OWNER_OPERATION | activation revision | 92 |
| post.auth.register | POST | /api/auth/register | anonymous | `RegisterRequest` | `UserReceipt`（不自动登录、不合并匿名记录） | VALIDATION_ERROR, RATE_LIMITED, IDEMPOTENCY_KEY_REUSED | HEADER_OWNER_OPERATION | NONE | 83 |
| post.chat-commands.id.cancel | POST | /api/chat-commands/{id}/cancel | owner | `CancelRequest` | `ChatCommandReceipt` | NOT_FOUND, CANCELLED, VERSION_CONFLICT | HEADER_OWNER_OPERATION | command CAS | 51 |
| post.plan.draft | POST | /api/plan/draft | ANON/USER | exact `PlanDraftRequest` | PlanDraftReceipt: REQUIREMENT_SUMMARY (023) &#124; PLANNER_RUN (026); commandStatus, summary, exact accepted version | VALIDATION_ERROR, AUTH_REQUIRED, IDEMPOTENCY_KEY_REUSED, CONFIG_ERROR, RATE_LIMITED, FEATURE_DISABLED, PROVIDER_TIMEOUT, PROVIDER_UNAVAILABLE, COST_LIMIT, CANCELLED | HEADER_OWNER_OPERATION | 新记录无需 baseRevision | 23 |
| post.planner-runs.id.cancel | POST | /api/planner-runs/{id}/cancel | owner | CancelRequest (Phase058), no client owner or run id in body | `PlannerRunReceipt` | NOT_FOUND, CANCELLED, VERSION_CONFLICT | HEADER_OWNER_OPERATION | run CAS | 58 |
| post.session.anonymous | POST | /api/session/anonymous | anonymous | `{}` | `AnonymousSessionReceipt`（不返回 token 原文） | VALIDATION_ERROR, RATE_LIMITED, INTERNAL_ERROR | COOKIE_REUSE | NONE | 23 |
| post.travel-plan-versions.planVersionId.clones | POST | /api/travel-plan-versions/{planVersionId}/clones | USER | ClonePlanCommand: pendingOverrides={changes:RequirementChange[]}; fixed source version | CloneReceipt | AUTH_REQUIRED, NOT_FOUND, IDEMPOTENCY_KEY_REUSED, VERSION_CONFLICT | HEADER_OWNER_OPERATION | fixed source authorization; target new record | 87 |
| post.travel-plan-versions.planVersionId.exports.markdown | POST | /api/travel-plan-versions/{planVersionId}/exports/markdown | USER/SHARE | `ExportOptions` | Markdown bytes | AUTH_REQUIRED, NOT_FOUND, FEATURE_DISABLED, COST_LIMIT, INTERNAL_ERROR | HEADER_OWNER_OPERATION | fixed version | 104 |
| post.travel-plan-versions.planVersionId.exports.pdf | POST | /api/travel-plan-versions/{planVersionId}/exports/pdf | USER/SHARE | `ExportOptions` | PDF bytes | AUTH_REQUIRED, NOT_FOUND, FEATURE_DISABLED, COST_LIMIT, INTERNAL_ERROR | HEADER_OWNER_OPERATION | fixed version | 101 |
| post.travel-plan-versions.planVersionId.feedback | POST | /api/travel-plan-versions/{planVersionId}/feedback | USER/SHARE | FeedbackCreateRequest: category, severityHint, description, expectedOutcome, targetRef?, contactConsent=false, evaluationConsent=false; X-Feedback-Receipt header | FeedbackReceipt | AUTH_REQUIRED, NOT_FOUND, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED | HEADER_OWNER_OPERATION | NONE | 95 |
| post.travel-plan-versions.planVersionId.shares | POST | /api/travel-plan-versions/{planVersionId}/shares | USER | ShareCreateRequest: expectedVersion, expiresAt? | ShareGrantReceipt: tokenAvailable and token only on first response | AUTH_REQUIRED, NOT_FOUND, FEATURE_DISABLED, IDEMPOTENCY_KEY_REUSED, VALIDATION_ERROR, VERSION_CONFLICT | HEADER_OWNER_OPERATION | expectedVersion -> TravelRecord.version | 88 |
| post.travel-records.id.commands | POST | /api/travel-records/{id}/commands | owner | ChatCommandCreate (051 text and optional causationId; 053 exact mutation or confirmation union) | ChatCommandReceipt with persistent terminal result | VALIDATION_ERROR, NOT_FOUND, IDEMPOTENCY_KEY_REUSED, VERSION_CONFLICT, RATE_LIMITED, FEATURE_DISABLED, PROVIDER_TIMEOUT, PROVIDER_UNAVAILABLE, COST_LIMIT, CANCELLED | HEADER_OWNER_OPERATION | expectedVersion + expectedRequirementRevision (053) | 51 |
| post.travel-records.id.finalizations | POST | /api/travel-records/{id}/finalizations | owner | `FinalizeRequest` | `FinalizeReceipt` | NOT_FOUND, VERSION_CONFLICT, VALIDATION_ERROR | HEADER_OWNER_OPERATION | `expectedVersion` | 60 |
| post.travel-records.id.readiness-checks | POST | /api/travel-records/{id}/readiness-checks | owner | `ReadinessCheckRequest` | `TravelReadinessReport` | NOT_FOUND, VERSION_CONFLICT, PROVIDER_UNAVAILABLE | HEADER_OWNER_OPERATION | target version CAS | 60 |
| post.travel-records.id.replans | POST | /api/travel-records/{id}/replans | owner | ReplanRequest: FULL &#124; FROM_DAY &#124; ALTERNATIVE, exact Phase058 fields and optional causationId | `ReplanReceipt` | NOT_FOUND, IDEMPOTENCY_KEY_REUSED, VERSION_CONFLICT, PROVIDER_UNAVAILABLE, VALIDATION_ERROR, FEATURE_DISABLED, REQUIREMENT_CONFIRMATION_REQUIRED | HEADER_OWNER_OPERATION | expectedVersion + expectedRequirementRevision + confirmedRequirementDiffHash | 58 |
| post.travel-records.id.version-restores | POST | /api/travel-records/{id}/version-restores | owner | RestoreRequest: restoreVersion, expectedCurrentVersion, expectedRequirementRevision, requirementStrategy, targetRequirementHash, targetWorkspaceHash, acknowledgedWarningCodes | RestoreReceipt with RestoreCommand and PlannerRun | NOT_FOUND, IDEMPOTENCY_KEY_REUSED, VERSION_CONFLICT, PROVIDER_UNAVAILABLE, VALIDATION_ERROR, FEATURE_DISABLED, REQUIREMENT_CONFIRMATION_REQUIRED | HEADER_OWNER_OPERATION | expectedCurrentVersion + expectedRequirementRevision + target snapshot hashes | 59 |
| publications.create | POST | /api/travel-plan-versions/{planVersionId}/publications | USER | PublicationCreateRequest | PublicationReceipt | NOT_FOUND, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED, VERSION_CONFLICT, AUTH_REQUIRED, FEATURE_DISABLED | HEADER_OWNER_OPERATION | expectedVersion -> TravelRecord.version | 106 |
| publications.list | GET | /api/publications | USER | query cursor | PublicationPage | NOT_FOUND | NONE | NONE | 106 |
| publications.read | GET | /api/public/plans/{slug} | PUBLIC | path slug | PlanViewModel access=public | NOT_FOUND, RATE_LIMITED | NONE | NONE | 106 |
| publications.revoke | DELETE | /api/publications/{publicationId} | USER | expectedVersion | PublicationReceipt | NOT_FOUND, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED, VERSION_CONFLICT | HEADER_OWNER_OPERATION | expectedVersion -> PlanPublication.revision | 106 |
| put.admin.model-deployments.id.rollout | PUT | /api/admin/model-deployments/{id}/rollout | ADMIN | `RolloutRequest` | rollout | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, VERSION_CONFLICT | HEADER_OWNER_OPERATION | rollout revision | 91 |
| put.admin.prompts.promptKey.rollout | PUT | /api/admin/prompts/{promptKey}/rollout | ADMIN | `RolloutRequest` | `PromptActivation` | AUTH_REQUIRED, FORBIDDEN, VALIDATION_ERROR, VERSION_CONFLICT | HEADER_OWNER_OPERATION | rollout revision | 90 |
| put.me.favorites.planVersionId | PUT | /api/me/favorites/{planVersionId} | USER | `FavoritePutRequest` | `FavoriteReceipt` | AUTH_REQUIRED, NOT_FOUND, IDEMPOTENCY_KEY_REUSED | HEADER_OWNER_OPERATION | NONE | 86 |
| records.archive | POST | /api/travel-records/{id}/archivals | USER | ArchivalRequest | TravelRecordReceipt | NOT_FOUND, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED, VERSION_CONFLICT | HEADER_OWNER_OPERATION | expectedVersion | 85 |
| shares.reissue | POST | /api/shares/{shareId}/reissues | USER | ShareReissueRequest: expectedVersion | ShareGrantReceipt: same version/expiry, tokenAvailable=false on replay | NOT_FOUND, VALIDATION_ERROR, IDEMPOTENCY_KEY_REUSED, VERSION_CONFLICT, AUTH_REQUIRED, FEATURE_DISABLED | HEADER_OWNER_OPERATION | expectedVersion -> ShareGrant.revision | 88 |
<!-- api-registry:end -->

## 精确 DTO 定义

下面 `api-contract` JSON 是本文字段集合的唯一机器定义。`fields` 对象封闭，键尾 `?` 表示允许 absent，其余键必填；`nullable:T` 表示允许显式 null；`T[]` 为有序数组；`enum:` 后是逐字值。`oneOf` 是互斥封闭分支，拒绝额外字段。`page:T` exact 为 `{items:T[],nextCursor:string|null}`，`widget:T` 是 ok/data 与 error/error 的封闭分支，`sse:T` 声明每帧沿 T 传输。包装符先于内部数组解释，`widget:AuditSummary[]` 的 data 是数组。标量及 Content/Password/Cursor/Locale/Reason/Name/PageLimit/DiversitySeed/BasisPoints/FingerprintDisplay/RequirementHash/Sha256Hex/PrefixedSha256 的具体界限见文后。类型引用保持所属文档的唯一权威，不能把业务体放宽为任意 JSON。`references` 指向尚未到实现阶段的冻结类型时只声明消费边界，不创建未来 Schema、表或测试产物；文档检查器遇到需要实例校验的外部类型会要求其 owner validator，绝不当作任意对象放行。

`operations` 仅为100个 operationId 指定 request/query/response 类型和HTTP成功状态，不保存 method/path/producerPhase，不能构成第二路由表。未指定 query 则不接受 query；request=NoBody 表示不能有 JSON body，Empty 表示 exact `{}`。GET registry 的 path说明不是JSON输入；同名 CancelRequest 根据命令或 run 的实际聚合投影区分。

<!-- api-contract:start -->
```json
{
  "version": "Phase002-api-v1",
  "errors": {"VALIDATION_ERROR":400,"AUTH_REQUIRED":401,"FORBIDDEN":403,"NOT_FOUND":404,"IDEMPOTENCY_KEY_REUSED":409,"VERSION_CONFLICT":409,"PLANNING_IN_PROGRESS":409,"USE_PLAN_MUTATION":409,"REQUIREMENT_CONFIRMATION_REQUIRED":409,"RESYNC_REQUIRED":410,"FEATURE_DISABLED":503,"CONFIG_ERROR":503,"RATE_LIMITED":429,"COST_LIMIT":429,"PROVIDER_UNAVAILABLE":503,"PROVIDER_TIMEOUT":503,"CANCELLED":409,"INTERNAL_ERROR":500,"OPERATION_NOT_AVAILABLE":409,"CONFIRMATION_EXPIRED":410,"REVALIDATION_REQUIRED":409},
  "forbiddenRoutes": [{"path":"/api/nlu/parse","expectedHttpStatus":404,"producerCount":0},{"path":"/api/nlu/extract","expectedHttpStatus":404,"producerCount":0},{"path":"/api/plan/generate","expectedHttpStatus":404,"producerCount":0}],
  "references": {
    "TravelRequirement":"docs/travel-plan-schema.md: TravelRequirement, Phase002/017",
    "TravelPlanSummaryDraft":"docs/travel-plan-schema.md: TravelPlanSummaryDraft v1, Phase002/022",
    "RequirementState":"roadmapRoot/Phase021.md: readiness and MissingFieldSpec; Phase023 receipt",
    "TravelPlanV2":"roadmapRoot/Phase024.md: canonical exact schema v2; first runtime producer 024",
    "ReadinessResult":"roadmapRoot/Phase021.md: evaluateRequirementReadiness result",
    "TargetRef":"roadmapRoot/Phase024.md: six-branch TargetRefSchema; canonical 3.10",
    "EntityRef":"roadmapRoot/Phase024.md: namespaced entity identity",
    "MutationInput":"roadmapRoot/Phase053.md: nine-operation exact operation table; canonical 3.10",
    "RequirementChange":"roadmapRoot/Phase053.md: six RequirementPath complete-subobject union, BudgetChange branch",
    "PlanDiff":"roadmapRoot/Phase053.md: exact semantic difference; Phase059 requirement/lock projection",
    "PlanViewModel":"roadmapRoot/Phase065.md: unique schema access=owner/share/public; canonical 3.4",
    "TravelReadinessReport":"roadmapRoot/Phase060.md: exact checks, three hashes, versions, refs and expiry",
    "PromptVariables":"docs/prompt-design.md: selected promptKey exact variable schema",
    "PromptVariableSchema":"docs/prompt-design.md: selected promptKey variable specifications, required/nullable/bounds and input schema; distinct from runtime variable values",
    "PromptResponse":"docs/prompt-design.md: selected promptKey validated response schema",
    "ModelCapabilities":"roadmapRoot/Phase015.md: immutable ModelDeployment.capabilitiesJson and Phase091 capability-bound model parameter contract",
    "ProviderCapabilities":"roadmapRoot/Phase015.md: provider identity-bound capability schema; Phase028 travel registry and Phase092 governed extensions",
    "PolicyContent":"roadmapRoot/Phase093.md: unitized Freshness/Planning/QualityGate policy; database design governance",
    "ConfigValue":"roadmapRoot/Phase014.md: selected key closed config-registry schema",
    "PlanMetrics":"roadmapRoot/Phase099.md: versioned typed trace metrics whitelist",
    "QualitySummary":"roadmapRoot/Phase065.md: current access safe quality projection",
    "FreshnessSummary":"roadmapRoot/Phase065.md: generated/current same-snapshot checkedAt/policy projection",
    "SourceCoverage":"roadmapRoot/Phase060.md: validated numerator/denominator/source coverage",
    "TraceTimeline":"roadmapRoot/Phase099.md: paged typed trace events; canonical envelope",
    "AnnouncementScope":"roadmapRoot/Phase094.md: region/capability/feature scope registry",
    "ModelParameters":"roadmapRoot/Phase091.md: providerModelName capability-bound parameter schema",
    "ProviderPolicy":"roadmapRoot/Phase092.md: timeout/retry/quota/regions/locales/fallback schema",
    "ProfileValue":"roadmapRoot/Phase084.md: named profile field canonical value and consent schema"
  },
  "types": {
    "Empty":{"fields":{}},
    "PageQuery":{"fields":{"cursor?":"Cursor","limit?":"PageLimit"}},
    "AdminUserQuery":{"fields":{"cursor?":"Cursor","limit?":"PageLimit","role?":"enum:USER|ADMIN","status?":"enum:ACTIVE|DISABLED"}},
    "AdminUser":{"fields":{"id":"id","email":"text","name":"nullable:Name","avatarUrl":"nullable:text","role":"enum:USER|ADMIN","status":"enum:ACTIVE|DISABLED","lastLoginAt":"nullable:Instant","createdAt":"Instant","revision":"integer"}},
    "AdminUserPatch":{"fields":{"role":"enum:USER|ADMIN","status":"enum:ACTIVE|DISABLED","expectedVersion":"integer","reason":"Reason"}},
    "ApiKeyQuery":{"fields":{"cursor?":"Cursor","limit?":"PageLimit","provider?":"id","status?":"enum:ACTIVE|DISABLED|REVOKED"}},
    "MaskedKey":{"fields":{"id":"id","name":"Name","provider":"id","keyFingerprintDisplay":"FingerprintDisplay","status":"enum:ACTIVE|DISABLED|REVOKED","revision":"integer","lastUsedAt":"nullable:Instant","revokedAt":"nullable:Instant","createdAt":"Instant","updatedAt":"Instant"}},
    "ApiKeyCreate":{"fields":{"name":"Name","provider":"id","plainKey":"Secret"}},
    "ApiKeyPatch":{"fields":{"name?":"Name","status?":"enum:ACTIVE|DISABLED|REVOKED","expectedVersion":"integer"}},
    "ApiKeyRotateRequest":{"fields":{"name":"Name","provider":"id","plainKey":"Secret","expectedVersion":"integer"}},
    "KeyRotationReceipt":{"fields":{"key":"MaskedKey","stage":"enum:PREPARING|TESTING|READY|ACTIVATED|ABORTED","affectedConfigCount":"integer","errorCode":"nullable:text","replayed":"boolean"}},
    "AuditQuery":{"fields":{"cursor?":"Cursor","limit?":"PageLimit","actorId?":"id","action?":"text","targetType?":"text","targetId?":"id","from?":"Instant","to?":"Instant"}},
    "AuditSummary":{"fields":{"id":"id","actorType":"enum:USER|ADMIN|SYSTEM","actorId":"nullable:id","targetType":"text","targetId":"nullable:id","action":"text","requestId":"nullable:id","traceId":"nullable:id","createdAt":"Instant","safeSummary":"text"}},
    "WidgetError":{"fields":{"status":"enum:error","error":"SafeWidgetError"}},
    "SafeWidgetError":{"fields":{"code":"text","requestId":"id"}},
    "UserStats":{"fields":{"total":"integer","active":"integer"}},
    "RecordStats":{"fields":{"total":"integer","byStatus":"RecordStatusCounts"}},
    "RecordStatusCounts":{"fields":{"DRAFT":"integer","NEEDS_INFO":"integer","PLANNED":"integer","MODIFIED":"integer","FINALIZED":"integer","NEEDS_REVALIDATION":"integer","ARCHIVED":"integer"}},
    "ConfigStats":{"fields":{"total":"integer","public":"integer"}},
    "DashboardStats":{"fields":{"widgets":"DashboardWidgets"}},
    "DashboardWidgets":{"fields":{"users":"widget:UserStats","travelRecords":"widget:RecordStats","configs":"widget:ConfigStats","recentAudits":"widget:AuditSummary[]"}},
    "AdminSetting":{"fields":{"key":"text","valueJson":"ConfigValue","description":"text","group":"enum:AI|UI|EXPORT|SECURITY|GENERAL","isPublic":"boolean","revision":"integer","updatedAt":"Instant"}},
    "AdminSettings":{"fields":{"items":"AdminSetting[]"}},
    "PublicConfig":{"fields":{"items":"PublicConfigItem[]"}},
    "PublicConfigItem":{"fields":{"key":"text","value":"ConfigValue"}},
    "SettingPatch":{"fields":{"valueJson":"ConfigValue","expectedVersion":"integer"}},
    "AiDebugRequest":{"fields":{"promptKey":"text","variables":"PromptVariables","failureProfile":"text"}},
    "AiDebugReceipt":{"fields":{"debugRunId":"id","status":"enum:PENDING|RUNNING|SUCCEEDED|FAILED|CANCELLED","replayed":"boolean"}},
    "AiDebugStatus":{"fields":{"debugRunId":"id","status":"enum:PENDING|RUNNING|SUCCEEDED|FAILED|CANCELLED","attemptIds":"id[]","finalSummary":"nullable:AiDebugSummary","errorCode":"nullable:text"}},
    "AiDebugSummary":{"fields":{"promptVersionId":"id","promptHash":"Sha256Hex","deploymentId":"id","deploymentConfigVersion":"positiveInteger","providerId":"id","providerConfigVersion":"positiveInteger","rawOutput":"nullable:text","parsedData":"nullable:PromptResponse","schemaValidation":"SchemaValidation","aiOutputRecordId":"id"}},
    "SchemaValidation":{"fields":{"valid":"boolean","diagnosticCategory":"nullable:enum:INVALID_JSON|SCHEMA_MISMATCH","issuePaths":"text[]"}},
    "PlanDraftRequest":{"fields":{"content":"Content","planningMode":"enum:quick|precise","clientRequestId":"UUID","locale":"Locale","timezone":"zone"}},
    "AnonymousSessionReceipt":{"fields":{"anonymousSessionReady":"enum:true"}},
    "PlanDraftReceipt":{"oneOf":[{"fields":{"travelRecordId":"id","commandId":"id","commandStatus":"enum:PENDING|RUNNING|COMPLETED|FAILED|CANCELLED","handoffStage":"enum:REQUIREMENT_SUMMARY","summary":"nullable:TravelPlanSummaryDraft","plannerRunId":"null","acceptedPlanningMode":"enum:quick|precise","travelRecordStatus":"enum:DRAFT|NEEDS_INFO","workspaceAvailable":"enum:false","requirementState":"RequirementState","readiness":"ReadinessResult","replayed":"boolean"}},{"fields":{"travelRecordId":"id","commandId":"id","commandStatus":"enum:PENDING|RUNNING|COMPLETED|FAILED|CANCELLED","handoffStage":"enum:PLANNER_RUN","summary":"TravelPlanSummaryDraft","plannerRunId":"id","acceptedPlanningMode":"enum:quick|precise","travelRecordStatus":"enum:DRAFT|NEEDS_INFO|PLANNED","workspaceAvailable":"boolean","requirementState":"RequirementState","readiness":"ReadinessResult","replayed":"boolean"}}]},
    "EventQuery":{"fields":{"afterSequence?":"integer"}},
    "EventEnvelope":{"fields":{"eventId":"id","sequence":"positiveInteger","aggregateId":"id","traceId":"id","type":"text","status":"text","occurredAt":"Instant","payloadVersion":"positiveInteger","payload":"EventPayload"}},
    "EventPayload":{"oneOf":[{"fields":{"commandId":"id","travelRecordId":"id","message":"Message","conversationCursor":"Cursor"}},{"fields":{"commandId":"id","deltaIndex":"integer","text":"text"}},{"fields":{"commandId":"id","message":"Message","conversationCursor":"Cursor"}},{"fields":{"commandId":"id","error":"SafeCommandError","conversationCursor":"Cursor"}},{"fields":{"plannerRunId":"id","stageCode":"text","safeMessage?":"text","progressUnits?":"integer","error?":"SafeCommandError","travelRecordId?":"id"}},{"fields":{"plannerRunId":"id","stageCode":"text","safeMessage?":"text","progressUnits?":"integer","travelRecordId":"id","planVersionId":"id","planVersion":"positiveInteger"}},{"fields":{"debugRunId":"id","receipt":"AiDebugReceipt"}},{"fields":{"debugRunId":"id","deltaIndex":"integer","text":"text"}},{"fields":{"debugRunId":"id","result":"AiDebugStatus"}}]},
    "SafeCommandError":{"fields":{"code":"text","message":"text","retryable":"boolean"}},
    "Message":{"fields":{"messageId":"id","travelRecordId":"id","sequence":"positiveInteger","role":"enum:USER|ASSISTANT|SYSTEM","kind":"enum:TEXT|STRUCTURED","content":"text","createdAt":"Instant","replyToMessageId":"nullable:id"}},
    "ChatCancelRequest":{"fields":{"expectedCommandState":"enum:PENDING|RUNNING"}},
    "PlannerCancelRequest":{"fields":{"expectedRunState":"enum:PENDING|RUNNING"}},
    "ChatCommandCreate":{"oneOf":[{"fields":{"clientMessageId":"UUID","content":"Content","expectedConversationCursor?":"Cursor","expectedVersion?":"integer","causationId?":"id","expectedRequirementRevision?":"integer"}},{"fields":{"clientMessageId":"UUID","content":"Content","expectedConversationCursor?":"Cursor","expectedVersion":"positiveInteger","expectedRequirementRevision":"integer","causationId?":"id","mutation":"MutationInput"}},{"fields":{"clientMessageId":"UUID","content":"Content","expectedConversationCursor?":"Cursor","expectedVersion":"positiveInteger","expectedRequirementRevision":"integer","confirmation":"MutationConfirmation"}}]},
    "MutationConfirmation":{"fields":{"sourceCommandId":"id","clarificationId":"id","confirmationToken":"Secret","decision":"ConfirmationDecision"}},
    "ConfirmationDecision":{"oneOf":[{"fields":{"kind":"enum:SELECT","choiceId":"id"}},{"fields":{"kind":"enum:CANCEL"}}]},
    "ChatCommandReceipt":{"fields":{"commandId":"id","travelRecordId":"id","status":"enum:PENDING|RUNNING|COMPLETED|FAILED|CANCELLED","message":"nullable:Message","result":"nullable:MutationResult","error":"nullable:SafeCommandError","conversationCursor":"Cursor","replayed":"boolean"}},
    "MutationResult":{"oneOf":[{"fields":{"status":"enum:APPLIED","planVersionId":"id","planVersion":"positiveInteger","diff":"PlanDiff"}},{"fields":{"status":"enum:NEEDS_CLARIFICATION","clarification":"ClarificationView"}},{"fields":{"status":"enum:INFEASIBLE","reasonCode":"text","warnings":"text[]"}}]},
    "ClarificationView":{"fields":{"clarificationId":"id","sourceCommandId":"id","question":"text","choices":"ClarificationChoice[]","confirmationToken":"Secret","expiresAt":"Instant"}},
    "ClarificationChoice":{"fields":{"choiceId":"id","label":"text","safeSummary":"text","allowedImpactScope":"ImpactScope","unlockRefs":"TargetRef[]","unlockRequirementPaths":"enum:origin|destinations|dateRange|travelers|budget|preferences[]"}},
    "ImpactScope":{"fields":{"dayIds":"id[]","modules":"enum:planningContext|requirementSnapshot|dailyItinerary|routePlan|transportPlan|accommodationRecommendations|attractionRecommendations|foodRecommendations|photoGuide|placeRegistry|sourceCatalog|budgetAnalysis|weatherAnalysis|packingList|riskAlerts|pitfallGuide|alternatives|scores|specialReminders|emergencyAdvice|returnAdvice|finalSummary|dataNotes|qualityReport|readiness[]"}},
    "ConversationQuery":{"fields":{"cursor?":"Cursor","afterSequence?":"integer","limit?":"PageLimit"}},
    "ConversationPage":{"fields":{"messages":"Message[]","nextCursor":"nullable:Cursor","latestSequence":"integer","planVersion":"integer","status":"enum:DRAFT|NEEDS_INFO|PLANNED|MODIFIED|FINALIZED|NEEDS_REVALIDATION|ARCHIVED","requirementRevision":"integer","commands":"ChatCommandReceipt[]","clarifications":"ClarificationView[]"}},
    "PlannerRunReceipt":{"oneOf":[{"fields":{"plannerRunId":"id","status":"enum:SUCCEEDED","stage":"text","planVersionId":"id","planVersion":"positiveInteger","error":"null","eventsUrl":"text","cancelUrl":"text","replayed":"boolean"}},{"fields":{"plannerRunId":"id","status":"enum:PENDING|RUNNING|BLOCKED|FAILED|CANCELLED","stage":"text","planVersionId":"null","planVersion":"null","error":"nullable:SafeCommandError","eventsUrl":"text","cancelUrl":"text","replayed":"boolean"}}]},
    "ReplanRequest":{"oneOf":[{"fields":{"expectedVersion":"integer","expectedRequirementRevision":"integer","mode":"enum:FULL","changedRequirements":"RequirementChange[]","preservedRequirementPaths":"enum:origin|destinations|dateRange|travelers|budget|preferences[]","diversitySeed":"DiversitySeed","avoidPreviousChoices":"EntityRef[]","confirmedRequirementDiffHash":"nullable:Sha256Hex","causationId?":"id"}},{"fields":{"expectedVersion":"integer","expectedRequirementRevision":"integer","mode":"enum:FROM_DAY","changedRequirements":"RequirementChange[]","preservedRequirementPaths":"enum:origin|destinations|dateRange|travelers|budget|preferences[]","diversitySeed":"DiversitySeed","avoidPreviousChoices":"EntityRef[]","confirmedRequirementDiffHash":"nullable:Sha256Hex","fromDayId":"id","causationId?":"id"}},{"fields":{"expectedVersion":"integer","expectedRequirementRevision":"integer","mode":"enum:ALTERNATIVE","changedRequirements":"RequirementChange[]","preservedRequirementPaths":"enum:origin|destinations|dateRange|travelers|budget|preferences[]","diversitySeed":"DiversitySeed","avoidPreviousChoices":"EntityRef[]","confirmedRequirementDiffHash":"nullable:Sha256Hex","variantGoal":"enum:lower_intensity|lower_budget|different_choices","causationId?":"id"}}]},
    "ReplanReceipt":{"fields":{"commandId":"id","run":"PlannerRunReceipt","diff":"nullable:PlanDiff","replayed":"boolean"}},
    "VersionDiffQuery":{"fields":{"fromVersion":"positiveInteger","toVersion":"positiveInteger"}},
    "VersionSummary":{"fields":{"version":"positiveInteger","trigger":"enum:GENERATE|MUTATION|REPLAN|RESTORE|CLONE|REVALIDATE","createdAt":"Instant","summary":"TravelPlanSummaryDraft","qualityStatus":"enum:pass|needs_review|revalidation_required","sourceFreshness":"FreshnessSummary","isCurrent":"boolean","isFinalized":"boolean","finalizedAt":"nullable:Instant"}},
    "VersionDetailReceipt":{"fields":{"planVersionId":"id","version":"positiveInteger","summary":"TravelPlanSummaryDraft","planJson":"TravelPlanV2","requirementHash":"RequirementHash","workspaceSnapshotId":"id","workspaceSnapshotHash":"Sha256Hex","requirementRevision":"integer"}},
    "RestoreRequest":{"fields":{"restoreVersion":"positiveInteger","expectedCurrentVersion":"integer","expectedRequirementRevision":"integer","requirementStrategy":"enum:REQUIRE_MATCH|RESTORE_TARGET","targetRequirementHash":"RequirementHash","targetWorkspaceHash":"Sha256Hex","acknowledgedWarningCodes":"text[]"}},
    "RestoreReceipt":{"fields":{"commandId":"id","run":"PlannerRunReceipt","replayed":"boolean"}},
    "FinalizeRequest":{"fields":{"expectedVersion":"integer","readinessReportId":"id","acknowledgedWarningCodes":"text[]"}},
    "FinalizeReceipt":{"fields":{"finalizationId":"id","planVersionId":"id","planVersion":"positiveInteger","finalizedAt":"Instant","replayed":"boolean"}},
    "ReadinessCheckRequest":{"fields":{"expectedVersion":"integer"}},
    "RequirementPatchCommand":{"fields":{"clientRequestId":"UUID","expectedRequirementRevision":"integer","intent":"enum:apply|continue","operations":"RequirementOperation[]"}},
    "RequirementOperation":{"oneOf":[{"fields":{"operation":"enum:answer_question","questionId":"id","choiceId":"id"}},{"fields":{"operation":"enum:answer_question","questionId":"id","value":"text"}},{"fields":{"operation":"enum:accept_assumption","assumptionId":"id"}},{"fields":{"operation":"enum:replace_assumption","assumptionId":"id","choiceId":"id"}},{"fields":{"operation":"enum:replace_assumption","assumptionId":"id","value":"text"}}]},
    "RequirementReceipt":{"fields":{"requirementState":"RequirementState","requirementRevision":"integer","travelRecordStatus":"enum:DRAFT|NEEDS_INFO","plannerRunId":"nullable:id","replayed":"boolean"}},
    "PlanViewQuery":{"fields":{"planVersionId?":"id"}},
    "RegisterRequest":{"fields":{"email":"text","password":"Password","passwordConfirmation":"Password"}},
    "UserReceipt":{"fields":{"accepted":"enum:true","nextAction":"enum:LOGIN"}},
    "DataRequestCreate":{"oneOf":[{"fields":{"type":"enum:EXPORT","expectedVersion":"integer","causationId?":"id"}},{"fields":{"type":"enum:ERASE","expectedVersion":"integer","causationId?":"id","reauthentication":"ErasureReauthentication"}}]},
    "ErasureReauthentication":{"fields":{"password":"Password","confirmErasure":"enum:true"}},
    "MinimalDataRequestStatus":{"oneOf":[{"fields":{"id":"id","type":"enum:EXPORT","status":"enum:PENDING|RUNNING|COMPLETED|FAILED","completedAt":"nullable:Instant","errorCategory":"nullable:text"}},{"fields":{"id":"id","type":"enum:ERASE","status":"enum:PENDING|RUNNING|COMPLETED","completedAt":"nullable:Instant","errorCategory":"nullable:text"}}]},
    "DataRequestStatus":{"oneOf":[{"fields":{"id":"id","type":"enum:EXPORT","status":"enum:PENDING|RUNNING|COMPLETED|FAILED","revision":"integer","createdAt":"Instant","startedAt":"nullable:Instant","completedAt":"nullable:Instant","errorCategory":"nullable:text","downloadAvailable":"boolean","expiresAt":"nullable:Instant"}},{"fields":{"id":"id","type":"enum:ERASE","status":"enum:PENDING|RUNNING|COMPLETED","revision":"integer","createdAt":"Instant","startedAt":"nullable:Instant","completedAt":"nullable:Instant","errorCategory":"nullable:text","downloadAvailable":"enum:false","expiresAt":"null"}}]},
    "DataRequestReceipt":{"fields":{"request":"MinimalDataRequestStatus","replayed":"boolean"}},
    "TravelProfile":{"fields":{"profileVersion":"integer","name":"nullable:Name","pace":"nullable:ProfileValue","budgetPreference":"nullable:ProfileValue","transportPreferences":"ProfileValue[]","lodgingPreferences":"ProfileValue[]","interests":"ProfileValue[]","dietaryRestrictions":"ProfileValue[]","allergies":"ProfileValue[]","accessibilityNeeds":"ProfileValue[]","mobilityLimitations":"ProfileValue[]","usualCompanions":"ProfileValue[]","ageBands":"ProfileValue[]","dailyWalkingLimit":"nullable:ProfileValue","wakeSleepPreference":"nullable:ProfileValue"}},
    "TravelProfilePatch":{"fields":{"expectedProfileVersion":"integer","name?":"nullable:Name","pace?":"nullable:ProfileValue","budgetPreference?":"nullable:ProfileValue","transportPreferences?":"ProfileValue[]","lodgingPreferences?":"ProfileValue[]","interests?":"ProfileValue[]","dietaryRestrictions?":"ProfileValue[]","allergies?":"ProfileValue[]","accessibilityNeeds?":"ProfileValue[]","mobilityLimitations?":"ProfileValue[]","usualCompanions?":"ProfileValue[]","ageBands?":"ProfileValue[]","dailyWalkingLimit?":"nullable:ProfileValue","wakeSleepPreference?":"nullable:ProfileValue"}},
    "TravelRecordQuery":{"fields":{"cursor?":"Cursor","limit?":"PageLimit","status?":"enum:DRAFT|NEEDS_INFO|PLANNED|MODIFIED|FINALIZED|NEEDS_REVALIDATION|ARCHIVED","destination?":"text","from?":"ISODate","to?":"ISODate"}},
    "TravelRecordSummary":{"fields":{"recordId":"id","title":"text","destinationSummary":"text","status":"enum:DRAFT|NEEDS_INFO|PLANNED|MODIFIED|FINALIZED|NEEDS_REVALIDATION|ARCHIVED","versionCount":"integer","finalPlanVersionId":"nullable:id","updatedAt":"Instant","revalidationEligibility":"boolean","ineligibleReasons":"text[]"}},
    "PendingOverrides":{"fields":{"changes":"RequirementChange[]"}},
    "RevalidationRequest":{"fields":{"expectedVersion":"integer","expectedRequirementRevision":"integer","pendingOverrides?":"PendingOverrides","causationId?":"id"}},
    "RevalidationReceipt":{"fields":{"commandId":"id","run":"PlannerRunReceipt","replayed":"boolean"}},
    "ArchivalRequest":{"fields":{"expectedVersion":"integer"}},
    "TravelRecordReceipt":{"fields":{"recordId":"id","expectedVersion":"integer","archivedAt":"Instant","cancelledRunCount":"integer","revokedGrantCount":"integer","auditId":"id","replayed":"boolean"}},
    "FavoritePutRequest":{"fields":{"note?":"nullable:text"}},
    "FavoriteReceipt":{"fields":{"planVersionId":"id","isFavorite":"boolean","note":"nullable:text","createdAt":"nullable:Instant","replayed":"boolean"}},
    "FavoriteSummary":{"fields":{"planVersionId":"id","note":"nullable:text","createdAt":"Instant","summary":"VersionSummary","freshnessStatus":"FreshnessSummary"}},
    "ClonePlanCommand":{"fields":{"pendingOverrides?":"PendingOverrides"}},
    "CloneReceipt":{"fields":{"travelRecordId":"id","planVersionId":"id","version":"enum:1","status":"enum:NEEDS_REVALIDATION","qualityStatus":"enum:revalidation_required","cloneProvenance":"CloneProvenance","revalidationReasons":"text[]","replayed":"boolean"}},
    "CloneProvenance":{"fields":{"sourceRecordId":"id","sourcePlanVersionId":"id","clonedAt":"Instant"}},
    "ShareCreateRequest":{"fields":{"expectedVersion":"integer","expiresAt?":"nullable:Instant"}},
    "ShareReissueRequest":{"fields":{"expectedVersion":"integer"}},
    "ShareRevokeRequest":{"fields":{"expectedVersion":"integer"}},
    "ShareGrantReceipt":{"oneOf":[{"fields":{"shareId":"id","planVersionId":"id","status":"enum:ACTIVE","revision":"integer","expiresAt":"nullable:Instant","tokenAvailable":"enum:true","token":"Secret","replayed":"enum:false"}},{"fields":{"shareId":"id","planVersionId":"id","status":"enum:ACTIVE|REVOKED|EXPIRED","revision":"integer","expiresAt":"nullable:Instant","tokenAvailable":"enum:false","replayed":"boolean"}}]},
    "ShareGrantSummary":{"fields":{"shareId":"id","planVersionId":"id","status":"enum:ACTIVE|REVOKED|EXPIRED","revision":"integer","createdAt":"Instant","expiresAt":"nullable:Instant","revokedAt":"nullable:Instant"}},
    "PromptQuery":{"fields":{"cursor?":"Cursor","limit?":"PageLimit","promptKey?":"text"}},
    "PromptCandidateCreate":{"fields":{"promptKey":"text","content":"text","contentHash":"Sha256Hex","variables":"PromptVariableSchema","responseSchemaVersion":"text","purpose":"text","expectedVersion":"integer"}},
    "PromptVersion":{"fields":{"promptKey":"text","version":"positiveInteger","contentHash":"Sha256Hex","createdBy":"nullable:id","createdAt":"Instant","content":"text","variables":"PromptVariableSchema","responseSchemaVersion":"text"}},
    "PromptEvaluationRequest":{"fields":{"evaluationDatasetVersion":"id","candidateModelDeploymentId":"id","candidateModelDeploymentConfigVersion":"positiveInteger","providerId":"id","providerConfigVersion":"positiveInteger","gatePolicyVersionId":"id"}},
    "EvaluationRun":{"fields":{"id":"id","status":"enum:PENDING|RUNNING|SUCCEEDED|FAILED|CANCELLED","result":"nullable:enum:PASS|FAIL|INCONCLUSIVE","datasetVersion":"id","tuple":"ActivationTuple","gatePolicyVersionId":"id","metrics":"nullable:PlanMetrics","replayed":"boolean"}},
    "ActivationTuple":{"fields":{"definitionId":"id","promptVersionId":"id","deploymentId":"id","deploymentConfigVersion":"positiveInteger","providerId":"id","providerConfigVersion":"positiveInteger"}},
    "PromptActivation":{"fields":{"tuple":"ActivationTuple","activationRevision":"integer","status":"enum:ACTIVE|DISABLED"}},
    "ActivationRequest":{"fields":{"expectedVersion":"integer","evaluationRunId":"id","reason":"Reason"}},
    "PromptActivationRequest":{"fields":{"expectedVersion":"integer","evaluationRunId":"id","deploymentId":"id","deploymentConfigVersion":"positiveInteger","providerId":"id","providerConfigVersion":"positiveInteger","reason":"Reason"}},
    "RollbackRequest":{"fields":{"expectedVersion":"integer","targetVersion":"positiveInteger","evaluationRunId":"id","reason":"Reason"}},
    "RolloutRequest":{"fields":{"expectedVersion":"integer","champion":"ActivationTuple","challenger":"ActivationTuple","evaluationRunId":"id","trafficBasisPoints":"BasisPoints","reason":"Reason"}},
    "DisableRequest":{"fields":{"expectedVersion":"integer","reason":"Reason"}},
    "ModelQuery":{"fields":{"cursor?":"Cursor","limit?":"PageLimit","providerId?":"id","promptKey?":"text"}},
    "ModelDeploymentCreate":{"fields":{"providerId":"id","providerConfigVersion":"positiveInteger","providerModelName":"text","capabilities":"ModelCapabilities","paramsJson":"ModelParameters","contextWindowTokens":"positiveInteger","expectedVersion":"integer"}},
    "ModelDeploymentVersion":{"fields":{"id":"id","configVersion":"positiveInteger","providerId":"id","providerModelName":"text","capabilities":"ModelCapabilities","paramsJson":"ModelParameters","contextWindowTokens":"positiveInteger","contentHash":"Sha256Hex","createdAt":"Instant"}},
    "ModelEvaluationRequest":{"fields":{"promptKey":"text","promptVersion":"positiveInteger","providerId":"id","providerConfigVersion":"positiveInteger","evaluationDatasetVersion":"id","gatePolicyVersionId":"id"}},
    "ProviderQuery":{"fields":{"cursor?":"Cursor","limit?":"PageLimit","providerId?":"id","capability?":"text"}},
    "ProviderConfigCreate":{"oneOf":[{"fields":{"providerId":"id","providerType":"text","mode":"enum:MOCK|LIVE","baseUrl":"text","capabilities":"ProviderCapabilities","credentialRequirement":"enum:NONE","secretRef":"null","policy":"ProviderPolicy","expectedVersion":"integer"}},{"fields":{"providerId":"id","providerType":"text","mode":"enum:MOCK|LIVE","baseUrl":"text","capabilities":"ProviderCapabilities","credentialRequirement":"enum:REQUIRED","secretRef":"id","policy":"ProviderPolicy","expectedVersion":"integer"}}]},
    "ProviderConfigVersion":{"fields":{"providerId":"id","configVersion":"positiveInteger","mode":"enum:MOCK|LIVE","capabilities":"ProviderCapabilities","credentialRequirement":"enum:NONE|REQUIRED","credentialConfigured":"boolean","policy":"ProviderPolicy","contentHash":"Sha256Hex","createdAt":"Instant"}},
    "ConnectionTestRequest":{"fields":{"capability":"text"}},
    "ProviderHealth":{"oneOf":[{"fields":{"hasResult":"enum:false"}},{"fields":{"hasResult":"enum:true","availability":"enum:available|degraded|unavailable","checkedAt":"Instant","durationMs":"integer","capability":"text","errorCategory":"nullable:text"}}]},
    "ProviderActivation":{"fields":{"providerId":"id","activeConfigVersion":"positiveInteger","resolutionPolicyVersionId":"id","status":"enum:ACTIVE|DISABLED","revision":"integer","updatedAt":"Instant"}},
    "PolicyQuery":{"fields":{"cursor?":"Cursor","limit?":"PageLimit","policyKey?":"text"}},
    "PlanningPolicyCreate":{"fields":{"content":"PolicyContent","expectedVersion":"integer","reason":"Reason"}},
    "PlanningPolicyVersion":{"fields":{"id":"id","version":"positiveInteger","content":"PolicyContent","contentHash":"Sha256Hex","createdById":"nullable:id","createdAt":"Instant"}},
    "PolicyDryRunRequest":{"fields":{"datasetVersion":"id"}},
    "DryRunReport":{"fields":{"plannerRunId":"id","status":"enum:PENDING|RUNNING|SUCCEEDED|BLOCKED|FAILED|CANCELLED","workspaceSnapshotId":"nullable:id","metrics":"nullable:PlanMetrics","replayed":"boolean"}},
    "PolicyActivation":{"fields":{"policyKey":"text","activePolicyVersionId":"id","revision":"integer","updatedAt":"Instant"}},
    "AnnouncementQuery":{"fields":{"cursor?":"Cursor","limit?":"PageLimit","status?":"enum:DRAFT|SCHEDULED|PUBLISHED|WITHDRAWN|EXPIRED","regionCode?":"text","featureKey?":"text","providerCapability?":"text"}},
    "AnnouncementCreate":{"fields":{"title":"text","body":"text","severity":"enum:low|medium|high|critical","scope":"AnnouncementScope","startsAt":"Instant","endsAt":"nullable:Instant","timezone":"zone","actionUrl":"nullable:text","providerCapability?":"text","regionCode?":"text","featureKey?":"text","expectedVersion":"integer"}},
    "AnnouncementPatch":{"oneOf":[{"fields":{"operation":"enum:UPDATE_CONTENT","expectedVersion":"integer","content":"AnnouncementCreate"}},{"fields":{"operation":"enum:SCHEDULE|PUBLISH|WITHDRAW","expectedVersion":"integer"}}]},
    "AnnouncementVersion":{"fields":{"id":"id","version":"positiveInteger","revision":"integer","status":"enum:DRAFT|SCHEDULED|PUBLISHED|WITHDRAWN|EXPIRED","content":"SanitizedAnnouncement","contentHash":"Sha256Hex","createdAt":"Instant"}},
    "SanitizedAnnouncement":{"fields":{"id":"id","title":"text","body":"text","severity":"enum:low|medium|high|critical","startsAt":"Instant","endsAt":"nullable:Instant","actionUrl":"nullable:text"}},
    "FeedbackCreateRequest":{"fields":{"category":"enum:ROUTE_DETOUR|UNREALISTIC_TIME|PLACE_CLOSED|TRANSIT_MISMATCH|BUDGET_ERROR|FOOD_MISMATCH|LODGING_MISMATCH|ACCESSIBILITY|SOURCE_ERROR|UI_ISSUE|OTHER","severityHint":"enum:low|medium|high|critical","description":"text","expectedOutcome":"text","targetRef?":"TargetRef","contactConsent?":"boolean","evaluationConsent?":"boolean"}},
    "FeedbackConsentsPatch":{"fields":{"expectedVersion":"integer","contactConsent":"boolean","evaluationConsent":"boolean"}},
    "FeedbackConsents":{"fields":{"contactConsent":"boolean","evaluationConsent":"boolean"}},
    "FeedbackReceiptStatus":{"fields":{"id":"id","status":"enum:OPEN|TRIAGED|IN_PROGRESS|RESOLVED|REJECTED|DUPLICATE","revision":"integer","consents":"FeedbackConsents","safeReply":"nullable:text"}},
    "FeedbackQuery":{"fields":{"cursor?":"Cursor","limit?":"PageLimit","status?":"enum:OPEN|TRIAGED|IN_PROGRESS|RESOLVED|REJECTED|DUPLICATE","category?":"enum:ROUTE_DETOUR|UNREALISTIC_TIME|PLACE_CLOSED|TRANSIT_MISMATCH|BUDGET_ERROR|FOOD_MISMATCH|LODGING_MISMATCH|ACCESSIBILITY|SOURCE_ERROR|UI_ISSUE|OTHER","severityHint?":"enum:low|medium|high|critical","assigneeId?":"id"}},
    "FeedbackDetail":{"fields":{"id":"id","planVersionId":"id","targetRef":"nullable:TargetRef","category":"enum:ROUTE_DETOUR|UNREALISTIC_TIME|PLACE_CLOSED|TRANSIT_MISMATCH|BUDGET_ERROR|FOOD_MISMATCH|LODGING_MISMATCH|ACCESSIBILITY|SOURCE_ERROR|UI_ISSUE|OTHER","severityHint":"enum:low|medium|high|critical","description":"text","expectedOutcome":"text","status":"enum:OPEN|TRIAGED|IN_PROGRESS|RESOLVED|REJECTED|DUPLICATE","revision":"integer","consents":"FeedbackConsents","safeReply":"nullable:text","assigneeId":"nullable:id","duplicateOfId":"nullable:id","triageDecision":"nullable:enum:confirmed|cannotReproduce|duplicate|notAProblem|fixed","createdAt":"Instant"}},
    "FeedbackTriagePatch":{"fields":{"expectedVersion":"integer","decision":"enum:confirmed|cannotReproduce|duplicate|notAProblem|fixed","status":"enum:OPEN|TRIAGED|IN_PROGRESS|RESOLVED|REJECTED|DUPLICATE","assigneeId":"nullable:id","duplicateOfId":"nullable:id","safeReply":"nullable:text","reason":"Reason"}},
    "RegressionCandidateCreate":{"fields":{"expectedVersion":"integer","sourceEvidenceRefs":"id[]","independentReviewRef":"id","contentHash":"Sha256Hex"}},
    "RegressionCandidate":{"fields":{"id":"id","feedbackId":"id","consentRevision":"integer","watermark":"integer","contentHash":"Sha256Hex","replayed":"boolean"}},
    "AssetQuery":{"fields":{"cursor?":"Cursor","limit?":"PageLimit","purpose?":"enum:PLACE_MEDIA|ATTACHMENT|DATA_EXPORT","status?":"enum:QUARANTINED|ACTIVE|DISABLED"}},
    "AssetCreate":{"fields":{"file":"Bytes","mimeType":"text","purpose":"enum:PLACE_MEDIA|ATTACHMENT|DATA_EXPORT","altText":"text","media?":"PlaceMediaInput","expectedVersion":"integer"}},
    "PlaceMediaInput":{"fields":{"binding":"PlaceMediaBinding","licenseType":"text","creator":"text","sourceUrl":"nullable:text","internalProofRef":"nullable:id","attributionText":"text","usageScopes":"text[]","acquiredAt":"Instant","expiresAt":"nullable:Instant","altText":"text"}},
    "PlaceMediaBinding":{"oneOf":[{"fields":{"kind":"enum:PUBLIC_POI","providerId":"id","providerPlaceId":"id"}},{"fields":{"kind":"enum:VERSION_PLACE","ownerUserId":"id","planVersionId":"id","placeRef":"id"}}]},
    "AssetPatch":{"fields":{"expectedVersion":"integer","status?":"enum:QUARANTINED|ACTIVE|DISABLED","visibility?":"enum:PRIVATE|SIGNED","altText?":"text","reason":"Reason"}},
    "FileAsset":{"fields":{"id":"id","purpose":"enum:PLACE_MEDIA|ATTACHMENT|DATA_EXPORT","mimeType":"text","detectedMime":"text","sizeBytes":"decimalString","width":"nullable:positiveInteger","height":"nullable:positiveInteger","contentHash":"Sha256Hex","status":"enum:QUARANTINED|ACTIVE|DISABLED","scanStatus":"enum:PENDING|PASSED|FAILED|UNAVAILABLE","visibility":"enum:PRIVATE|SIGNED","stateVersion":"integer","createdAt":"Instant"}},
    "AssetUsageQuery":{"fields":{"usageId":"id","purpose":"enum:PLACE_MEDIA|ATTACHMENT|DATA_EXPORT","access":"enum:owner|share|public|admin","expiry":"Instant","signature":"Secret"}},
    "TracePageQuery":{"fields":{"cursor?":"Cursor","pageSize?":"PageLimit"}},
    "TraceQuery":{"fields":{"cursor?":"Cursor","pageSize?":"PageLimit","traceId?":"id","travelRecordId?":"id","planVersionId?":"id","attemptId?":"id","stage?":"text","providerId?":"id","deploymentId?":"id","errorCategory?":"text","status?":"enum:RUNNING|SAVED|EVALUATED|REJECTED|FAILED|CANCELLED","minimumQuality?":"integer","maximumQuality?":"integer","from?":"Instant","to?":"Instant"}},
    "PlanTraceSummary":{"fields":{"traceId":"id","attemptId":"id","plannerRunId":"id","travelRecordId":"nullable:id","planVersionId":"nullable:id","status":"enum:RUNNING|SAVED|EVALUATED|REJECTED|FAILED|CANCELLED","startedAt":"Instant","completedAt":"nullable:Instant","errorCategory":"nullable:text","versions":"ActivationTuple","metrics":"PlanMetrics","timeline":"TraceTimeline"}},
    "ExportOptions":{"fields":{"paperSize?":"enum:A4|LETTER","includeSecondaryDetails?":"boolean"}},
    "PublicationCreateRequest":{"fields":{"expectedVersion":"integer","expiresAt?":"nullable:Instant"}},
    "PublicationRevokeRequest":{"fields":{"expectedVersion":"integer"}},
    "PublicationReceipt":{"fields":{"publicationId":"id","planVersionId":"id","slug":"text","status":"enum:ACTIVE|REVOKED|EXPIRED","revision":"integer","publishedAt":"Instant","expiresAt":"nullable:Instant","revokedAt":"nullable:Instant","replayed":"boolean"}},
    "HealthResponse":{"fields":{"status":"enum:ok","releaseId":"text"}},
    "ReadinessResponse":{"fields":{"ready":"boolean","releaseId":"text","checks":"ReadinessProbe[]"}},
    "ReadinessProbe":{"fields":{"name":"enum:database|migrations|storage|privacy_watermark","ready":"boolean"}}
  },
  "operations": {
    "get.admin.users":{"request":"NoBody","query":"AdminUserQuery","response":"page:AdminUser","http":200},
    "patch.admin.users.id":{"request":"AdminUserPatch","response":"AdminUser","http":200},
    "get.admin.api-keys":{"request":"NoBody","query":"ApiKeyQuery","response":"page:MaskedKey","http":200},
    "get.admin.logs":{"request":"NoBody","query":"AuditQuery","response":"page:AuditSummary","http":200},
    "patch.admin.api-keys.id":{"request":"ApiKeyPatch","response":"MaskedKey","http":200},
    "post.admin.api-keys":{"request":"ApiKeyCreate","response":"MaskedKey","http":201},
    "post.admin.api-keys.id.rotate":{"request":"ApiKeyRotateRequest","response":"KeyRotationReceipt","http":202},
    "get.admin.dashboard.stats":{"request":"NoBody","response":"DashboardStats","http":200},
    "get.admin.settings":{"request":"NoBody","response":"AdminSettings","http":200},
    "get.config.public":{"request":"NoBody","response":"PublicConfig","http":200},
    "patch.admin.settings.key":{"request":"SettingPatch","response":"AdminSetting","http":200},
    "get.admin.ai-debug.runs.id":{"request":"NoBody","response":"AiDebugStatus","http":200},
    "post.admin.ai-debug.stream":{"request":"AiDebugRequest","response":"sse:EventEnvelope","http":200},
    "post.admin.ai-debug.test":{"request":"AiDebugRequest","response":"AiDebugReceipt","http":202},
    "post.plan.draft":{"request":"PlanDraftRequest","response":"PlanDraftReceipt","http":200},
    "post.session.anonymous":{"request":"Empty","response":"AnonymousSessionReceipt","http":200},
    "get.planner-runs.id.events":{"request":"NoBody","query":"EventQuery","response":"sse:EventEnvelope","http":200},
    "get.chat-commands.id.events":{"request":"NoBody","query":"EventQuery","response":"sse:EventEnvelope","http":200},
    "post.chat-commands.id.cancel":{"request":"ChatCancelRequest","response":"ChatCommandReceipt","http":200},
    "post.travel-records.id.commands":{"request":"ChatCommandCreate","response":"ChatCommandReceipt","http":202},
    "get.travel-records.id.conversation":{"request":"NoBody","query":"ConversationQuery","response":"ConversationPage","http":200},
    "post.planner-runs.id.cancel":{"request":"PlannerCancelRequest","response":"PlannerRunReceipt","http":200},
    "post.travel-records.id.replans":{"request":"ReplanRequest","response":"ReplanReceipt","http":202},
    "get.travel-records.id.version-diff":{"request":"NoBody","query":"VersionDiffQuery","response":"PlanDiff","http":200},
    "get.travel-records.id.versions":{"request":"NoBody","query":"PageQuery","response":"page:VersionSummary","http":200},
    "get.travel-records.id.versions.version":{"request":"NoBody","response":"VersionDetailReceipt","http":200},
    "post.travel-records.id.version-restores":{"request":"RestoreRequest","response":"RestoreReceipt","http":202},
    "post.travel-records.id.finalizations":{"request":"FinalizeRequest","response":"FinalizeReceipt","http":200},
    "post.travel-records.id.readiness-checks":{"request":"ReadinessCheckRequest","response":"TravelReadinessReport","http":200},
    "patch.travel-records.id.requirements":{"request":"RequirementPatchCommand","response":"RequirementReceipt","http":200},
    "get.travel-records.id":{"request":"NoBody","query":"PlanViewQuery","response":"PlanViewModel","http":200},
    "post.auth.register":{"request":"RegisterRequest","response":"UserReceipt","http":202},
    "dataRequests.create":{"request":"DataRequestCreate","response":"DataRequestReceipt","http":202},
    "dataRequests.download":{"request":"NoBody","response":"Bytes","http":200},
    "dataRequests.get":{"request":"NoBody","response":"DataRequestStatus","http":200},
    "dataRequests.receipt":{"request":"NoBody","response":"MinimalDataRequestStatus","http":200},
    "get.me.travel-profile":{"request":"NoBody","response":"TravelProfile","http":200},
    "patch.me.travel-profile":{"request":"TravelProfilePatch","response":"TravelProfile","http":200},
    "get.me.travel-records":{"request":"NoBody","query":"TravelRecordQuery","response":"page:TravelRecordSummary","http":200},
    "plans.revalidate":{"request":"RevalidationRequest","response":"RevalidationReceipt","http":202},
    "records.archive":{"request":"ArchivalRequest","response":"TravelRecordReceipt","http":200},
    "delete.me.favorites.planVersionId":{"request":"NoBody","response":"FavoriteReceipt","http":200},
    "get.me.favorites":{"request":"NoBody","query":"PageQuery","response":"page:FavoriteSummary","http":200},
    "put.me.favorites.planVersionId":{"request":"FavoritePutRequest","response":"FavoriteReceipt","http":200},
    "post.travel-plan-versions.planVersionId.clones":{"request":"ClonePlanCommand","response":"CloneReceipt","http":201},
    "delete.shares.shareId":{"request":"ShareRevokeRequest","response":"ShareGrantReceipt","http":200},
    "get.public.shares.token":{"request":"NoBody","response":"PlanViewModel","http":200},
    "get.shares":{"request":"NoBody","query":"PageQuery","response":"page:ShareGrantSummary","http":200},
    "post.travel-plan-versions.planVersionId.shares":{"request":"ShareCreateRequest","response":"ShareGrantReceipt","http":201},
    "shares.reissue":{"request":"ShareReissueRequest","response":"ShareGrantReceipt","http":201},
    "get.admin.prompts":{"request":"NoBody","query":"PromptQuery","response":"page:PromptVersion","http":200},
    "post.admin.prompts":{"request":"PromptCandidateCreate","response":"PromptVersion","http":201},
    "post.admin.prompts.promptKey.rollback":{"request":"RollbackRequest","response":"PromptActivation","http":200},
    "post.admin.prompts.promptKey.versions.version.activate":{"request":"PromptActivationRequest","response":"PromptActivation","http":200},
    "post.admin.prompts.promptKey.versions.version.evaluations":{"request":"PromptEvaluationRequest","response":"EvaluationRun","http":202},
    "put.admin.prompts.promptKey.rollout":{"request":"RolloutRequest","response":"PromptActivation","http":200},
    "get.admin.model-deployments":{"request":"NoBody","query":"ModelQuery","response":"page:ModelDeploymentVersion","http":200},
    "post.admin.model-deployments":{"request":"ModelDeploymentCreate","response":"ModelDeploymentVersion","http":201},
    "post.admin.model-deployments.id.rollback":{"request":"RollbackRequest","response":"PromptActivation","http":200},
    "post.admin.model-deployments.id.versions.configVersion.activate":{"request":"ActivationRequest","response":"PromptActivation","http":200},
    "post.admin.model-deployments.id.versions.configVersion.disable":{"request":"DisableRequest","response":"PromptActivation","http":200},
    "post.admin.model-deployments.id.versions.configVersion.evaluations":{"request":"ModelEvaluationRequest","response":"EvaluationRun","http":202},
    "put.admin.model-deployments.id.rollout":{"request":"RolloutRequest","response":"PromptActivation","http":200},
    "get.admin.provider-configs":{"request":"NoBody","query":"ProviderQuery","response":"page:ProviderConfigVersion","http":200},
    "get.admin.provider-configs.providerId.versions.configVersion.health":{"request":"NoBody","response":"ProviderHealth","http":200},
    "post.admin.provider-configs":{"request":"ProviderConfigCreate","response":"ProviderConfigVersion","http":201},
    "post.admin.provider-configs.providerId.versions.configVersion.activate":{"request":"ActivationRequest","response":"ProviderActivation","http":200},
    "post.admin.provider-configs.providerId.versions.configVersion.connection-tests":{"request":"ConnectionTestRequest","response":"ProviderHealth","http":200},
    "post.admin.provider-configs.providerId.versions.configVersion.disable":{"request":"DisableRequest","response":"ProviderActivation","http":200},
    "get.admin.planning-policies":{"request":"NoBody","query":"PolicyQuery","response":"page:PlanningPolicyVersion","http":200},
    "post.admin.planning-policies":{"request":"PlanningPolicyCreate","response":"PlanningPolicyVersion","http":201},
    "post.admin.planning-policies.id.activate":{"request":"ActivationRequest","response":"PolicyActivation","http":200},
    "post.admin.planning-policies.id.dry-runs":{"request":"PolicyDryRunRequest","response":"DryRunReport","http":202},
    "post.admin.planning-policies.id.rollback":{"request":"RollbackRequest","response":"PolicyActivation","http":200},
    "get.admin.announcements":{"request":"NoBody","query":"AnnouncementQuery","response":"page:AnnouncementVersion","http":200},
    "get.announcements":{"request":"NoBody","query":"PageQuery","response":"page:SanitizedAnnouncement","http":200},
    "patch.admin.announcements.id":{"request":"AnnouncementPatch","response":"AnnouncementVersion","http":200},
    "post.admin.announcements":{"request":"AnnouncementCreate","response":"AnnouncementVersion","http":201},
    "feedback.consents":{"request":"FeedbackConsentsPatch","response":"FeedbackReceiptStatus","http":200},
    "feedback.get":{"request":"NoBody","response":"FeedbackReceiptStatus","http":200},
    "feedback.receipt":{"request":"NoBody","response":"FeedbackReceiptStatus","http":200},
    "get.admin.feedback":{"request":"NoBody","query":"FeedbackQuery","response":"page:FeedbackDetail","http":200},
    "get.admin.feedback.id":{"request":"NoBody","response":"FeedbackDetail","http":200},
    "patch.admin.feedback.id":{"request":"FeedbackTriagePatch","response":"FeedbackDetail","http":200},
    "post.admin.feedback.id.regression-candidates":{"request":"RegressionCandidateCreate","response":"RegressionCandidate","http":201},
    "post.travel-plan-versions.planVersionId.feedback":{"request":"FeedbackCreateRequest","response":"FeedbackReceiptStatus","http":201},
    "assets.derivative":{"request":"NoBody","query":"AssetUsageQuery","response":"Bytes","http":200},
    "get.admin.assets":{"request":"NoBody","query":"AssetQuery","response":"page:FileAsset","http":200},
    "patch.admin.assets.id":{"request":"AssetPatch","response":"FileAsset","http":200},
    "post.admin.assets":{"request":"AssetCreate","response":"FileAsset","http":201},
    "get.admin.logs.planning":{"request":"NoBody","query":"TraceQuery","response":"page:PlanTraceSummary","http":200},
    "get.admin.logs.planning.traceId":{"request":"NoBody","query":"TracePageQuery","response":"PlanTraceSummary","http":200},
    "post.travel-plan-versions.planVersionId.exports.pdf":{"request":"ExportOptions","response":"Bytes","http":200},
    "post.travel-plan-versions.planVersionId.exports.markdown":{"request":"ExportOptions","response":"Bytes","http":200},
    "publications.create":{"request":"PublicationCreateRequest","response":"PublicationReceipt","http":201},
    "publications.list":{"request":"NoBody","query":"PageQuery","response":"page:PublicationReceipt","http":200},
    "publications.read":{"request":"NoBody","response":"PlanViewModel","http":200},
    "publications.revoke":{"request":"PublicationRevokeRequest","response":"PublicationReceipt","http":200},
    "get.health":{"request":"NoBody","response":"HealthResponse","http":200},
    "get.readiness":{"request":"NoBody","response":"ReadinessResponse","http":200}
  }
}
```
<!-- api-contract:end -->

`RequirementHash` 与 `Sha256Hex` 都严格为无前缀、恰好 64 字符的小写十六进制，pattern=`^[0-9a-f]{64}$`；前者专指同一完整不可变需求快照的摘要。`PrefixedSha256` 恰好 71 字符，pattern=`^sha256:[0-9a-f]{64}$`。三者拒绝大写、空白、换行和错误长度；不存在同时接受两种编码的通用 `hash` 类型。计算输入与字段用途不可互换，API 不自动添加或剥离前缀。

| 字段与用途 | API 编码 | 编码来源与传输边界 |
|---|---|---|
| VersionDetailReceipt.requirementHash、RestoreRequest.targetRequirementHash；摘要 requirementHash 与 Diff 的 fromRequirementHash/toRequirementHash | RequirementHash | [旅行 Schema](travel-plan-schema.md) 的 travel-summary-v1.properties.requirementHash 唯一规定裸 hex；直接传递同一值，REQUIRE_MATCH 对目标与当前完整字符串作相等比较 |
| AiDebugSummary.promptHash；PromptCandidateCreate/PromptVersion、ModelDeploymentVersion、ProviderConfigVersion、PlanningPolicyVersion 的 contentHash | Sha256Hex | 冻结 Phase015 的 canonical bytes 64 位 SHA-256 约定；promptHash 等于所引用 PromptVersion.contentHash，后续治理 API 不添加前缀 |
| AnnouncementVersion.contentHash、FileAsset.contentHash | Sha256Hex | [数据库规范](database.md) 的 AnnouncementVersion 与 FileAsset 均为 Char(64)；API 与持久值完全一致；文件按内容字节计算，不能将 hash 相同当作归属或许可相同 |
| VersionDetailReceipt.workspaceSnapshotHash、RestoreRequest.targetWorkspaceHash | Sha256Hex | 同为 Phase025 目标 PlanWorkspaceSnapshot.contentHash；Phase059 冻结其快照绑定语义但未指定文本前缀，本文补齐为裸 hex，所有读取、预览与恢复消费者使用相同编码 |
| ReplanRequest.confirmedRequirementDiffHash；RegressionCandidateCreate/RegressionCandidate.contentHash | nullable:Sha256Hex；Sha256Hex | Phase058/095 冻结差异确认与回归候选语义，未指定文本前缀，本文补齐为裸 hex。差异按 Phase058 exact JCS 输入计算；候选摘要绑定去标识候选内容，不能用需求或计划摘要代替 |
| TravelPlanV2/TravelReadinessReport 内 planContentHash、qualityReportHash、planHash；备选 executionBaseHash | PrefixedSha256 | 冻结 Phase025/043 明确 sha256: 前缀；三段摘要保持正文→报告→完整计划顺序。结构与实例校验仍归对应外部 Schema owner，本文不提前生产它们 |

工作区、差异与候选的编码是 Phase002 对尚未指定传输格式的明确补充，不声称冻结输入已包含该前缀规则。内部的 token/receipt/idempotency/keyFingerprint hash 不进入普通 DTO；短指纹仅按 FingerprintDisplay 投影。SourceReference.contentHash 与许可证证据摘要由[Provider 契约](travel-data-provider-strategy.md)拥有，沿其带前缀协议校验；它们和数据库 FactSnapshot.contentHash 是不同内容的摘要，不能仅凭同名字段套用另一编码。所有 hash 仍须由各 producer 重算并验证目标/权限/版本绑定；格式通过不代表快照匹配或授权通过。

整数均为安全整数且非负，positiveInteger>=1；版本0仅未产生正式版本，数组引用须唯一且同目标版本。text 默认1-4000 Unicode字符，Reason为trim后1-500，Name为非空白1-200；Content先trim再按1-4000字符验证，UUID采用RFC4122合法格式。decimalString为非负十进制字符串，不接受浮点或科学记数，未知为null、明确免费才为"0"。Instant为含偏移RFC3339且日期/时分秒真实有效，ISODate为真实公历local date，zone为IANA时区；不能用Date.parse的自动溢出修正接受2月30日。Cursor长度1-2048且无换行/NUL，Locale为有效BCP47，PageLimit为1-100，DiversitySeed为0-2147483647，BasisPoints为0-10000。Idempotency-Key为`[A-Za-z0-9._:-]{8,128}`。所有数组至多100，分页结果至多请求limit；生成的正式计划内部数组按其canonical Schema专有界限。Password按原始UTF-8限制12-72 bytes，确认密码按原字节相等；Secret中的API key为1-16384 bytes，receipt/token由对应密码学生产者验证32 bytes随机熵，确认签名由其签名协议验证；文档中的占位秘密仅用于字段测试，不能证明熵或真实鉴权。秘密绝不通用trim/大小写变换。FingerprintDisplay固定为完整fingerprint前12位小写十六进制加`…`，不返回完整摘要。

API receipt 内 result 只允许对应阶段已生产的分支。Phase023 的首稿 summary 在未完成或 NEEDS_INFORMATION 为 null；满足准入且 COMPLETED 才有 v1。Phase026 才允许PLANNER_RUN分支。Phase051 commands 尚无 mutation/confirmation/expectedRequirementRevision；Phase053才接受这三个登记扩展字段，正式版本修改必须同时携带两个 expected值，mutation与confirmation互斥，confirmation禁止额外causationId。Message的持久kind仍为TEXT/STRUCTURED；QUESTION是STRUCTURED澄清结果的展示kind，不新增数据库枚举。RequirementOperation 的value是用户给出的答案文本，经当前问题的choice/字段Schema解析，不能直接写入任意需求路径。Phase062 apply不能为空，continue空操作不增revision，有答案原子恰加1，version>0或活动run按准入矩阵拒绝。

`MutationInput`/TargetRef/RequirementChange 的封闭联合沿输入清单内 Phase024/053 原定义消费；不复制第二操作表。RequirementPath恰为origin/destinations/dateRange/travelers/budget/preferences完整子对象；任意JSONPath拒绝。PlanMutationResult只有APPLIED/NEEDS_CLARIFICATION/INFEASIBLE，无变化为INFEASIBLE/NO_CHANGE。SELECT确认以新的command/key消费已持久化选项；签名绑定owner、两个revision、optionsHash、scopeHash和expiresAt，CANCEL零计划写入；版本变化或到期必须新预览。PlannerRun取消以数据库expectedRunState CAS与成功提交竞争，终态胜者唯一。

ReplanRequest changedRequirements.path去重且与preservedRequirementPaths互斥；diversitySeed<=2147483647，无需求变化confirmedRequirementDiffHash必须null，有变化必须匹配服务端JCS差异。RestoreRequest两目标hash始终必填；REQUIRE_MATCH只允许当前需求hash等于目标，RESTORE_TARGET代表已经展示差异后的明确选择。Finalize按不可变PlanFinalization确认凭证授权历史目标，不把当前final指针当唯一证明。Readiness固定目标版本和三hash/策略/事实/TTL，任一变化重新检查。

治理操作名称中的 generic ActivationRequest/RollbackRequest 按URL固定目标消费：目标prompt/model/provider/policy身份从path取得；expectedVersion比较对应可变activation revision，evaluationRunId绑定已通过的精确元组/策略评测。body中目标版本字段只用于URL未承载的回滚目标，不重复path版本。rollout trafficBasisPoints为0-10000，champion/challenger必须完整已评测元组；PromptActivation及PromptModelActivation同事务同revision。ProviderHealth.durationMs是安全latency投影，hasResult=false表示尚无检测收据，不增加第四种availability；GET健康读取零外呼。Model.capabilities是capabilitiesJson的受控投影，paramsJson保持唯一命名；模型能力不套用旅行事实capability枚举。Prompt候选/版本的variables表示变量Schema，调试请求的variables才是运行时变量值。Model/Provider配置参数按冻结版本注册表的闭合Schema验证，不能接任意JSON、业务调用者传来的endpoint或默认模型别名；已授权ADMIN仅可提交受SSRF规则校验的候选baseUrl。

ApiKeyPatch至少含name/status之一，不接受plainKey/provider替换，REVOKED不可恢复；rotate创建新key，provider必须与URL旧key及受控配置兼容。分享/发布创建expiresAt缺省规范化null，否则必须未来时刻，期限不能靠重放延长。Favorite note省略保留、null清空、不同key采用数据库提交顺序last-write-wins，无revision CAS。文件上传使用multipart，其file为有界二进制；资产用途和PlaceMedia binding/版权的封闭校验不因MIME声明而跳过；rightsEvidenceCheckedAt由服务端写。生命周期与正文不可变分开，ADMIN响应不含storedPath/secretRef/envelope。

## 回执、隐私与公开投影

DataRequestCreate先校验receipt与登录，再对ERASE重新认证，密码剥离后才计算业务requestHash。ERASE先向独立PrivacyRevocationLedger append不可撤销intentId/scopeHash/watermark，然后投影应用库并撤session；跨库失败按同一intent reconcile。ERASE不能FAILED，临时错误保持RUNNING+checkpoint/nextAttemptAt，由新continuation task续接，既有意图不要求被擦除主体重新登录。receipt固定返回id/type/status/completedAt/errorCategory，无revision、水位、结果地址或下载权；所有回执/导出no-store。EXPORT下载仅活动owner、COMPLETED、未过期且归属一致。

X-Data-Request-Receipt、X-Feedback-Receipt都由客户端创建前生成256-bit秘密，仅敏感header交付，服务端唯一hash并与idempotency绑定；同键异receipt必409，丢响应可查询原receipt。FeedbackCreateRequest两个consent缺省false，PATCH两者必须明确boolean；guest contactConsent=true为VALIDATION_ERROR，联系方式只取明确授权的登录提交者自身canonical邮箱，不从description或分享owner提取。receipt可在share撤销后继续撤回自身同意，不授ADMIN分诊。

反馈category×targetRef严格沿Phase095矩阵：路线/班次需route_leg或transport event，时间需day/event/route_leg，关闭需含地点event/entity/stay，餐饮需meal event或food entity，住宿需stay/night/accommodation entity，无障碍需可定位day/event/route_leg/stay/entity，费用需可追溯费用owner，来源需存在sourceRefs；UI_ISSUE/OTHER才允许无target。所有目标解析到URL版本，不能通过描述猜测对象。评测撤回先独立CONSENT_WITHDRAWAL水位，再清候选及可识别副本；采样/回放重验feedbackId/consentRevision/watermark。

ShareGrantReceipt是独立协议：首次创建/换发tokenAvailable=true且token只返回一次，任何同键重放返回原shareId、tokenAvailable=false并省略token；显式reissue用新key，原grant被撤销，新grant固定同版本/同expiresAt，仅ACTIVE未过期可换发。列表/撤销永不返回token。share明文路径在日志前裁剪，后续反馈/导出只用X-Share-Token且绑定URL版本。

PlanViewModel唯一Schema由access=owner/share/public判别；非owner必禁requirementSnapshot/profileSnapshot/planningContext.planLocks、ownerCapabilities、userId/email/phone、聊天、私人坐标、trace/配置/审计/内部locator/hash。允许的业务白名单为planVersion最小元字段、summary、已脱敏assumptions、行程/路线/交通/推荐、预算/天气/清单/风险/备选展示摘要/提醒/应急/返程/finalSummary/dataNotes、qualitySummary/freshnessSummary/sourceCatalog/mapView，完整递归路径由[隐私](privacy-and-user-data.md)列明。SourceSummary exact为id/provider/sourceType/title/url/organization/license/fetchedAt/confidence/validFrom/validUntil；url可null，不保留sourceLocator/contentHash/内部endpoint或秘密query。

非owner文案从允许公开的结构化值和模板重建，不能复制用户或AI原文。PlaceView.disclosure=redacted保留placeRef但label/address/coordinate=null，相关geometry降sequence_only；禁止间接暴露私人端点或凭粗化坐标猜测位置。alternatives只保留安全摘要，不含planPatch/requestedChange/confirmationToken/owner操作。publication不比share更宽；当前资格/撤回/kill失败统一404。PDF/Markdown发送前完成完整有界buffer和authorizeExportSend跨实例fence复核，失败首字节为0，已发送内容不能宣称可召回。

## 事件与重放

EventEnvelope exact9键为eventId/sequence/aggregateId/traceId/type/status/occurredAt/payloadVersion/payload。领域字段只在payload；commandId/plannerRunId映射aggregateId。SSE `id:`恒等于eventId。持久事件先提交所属聚合事件账与Outbox，再推送，(aggregateId,sequence)唯一且重放按sequence递增。message.accepted与assistant.completed/command.failed/command.cancelled的唯一终态持久，planner.progress持久；终态成功消息恰一条，EOF不是stream.completed领域事件。用户PLAN运行的SUCCEEDED payload必须同时含travelRecordId/planVersionId/planVersion；其他状态不携带结果版本。FACT_EVALUATION成功绑定自己的快照/报告，不能借PLAN收据生成正式版本；其受保护评测结果按生产卡返回。

同一 aggregate 的重放窗口在出现终态事件后结束：chat 按 assistant.completed/command.failed/command.cancelled 三种 type 判断，互斥且不可重复；message.accepted.status 是 ChatCommand 当前状态，即使已为 COMPLETED/FAILED/CANCELLED，它仍是接受回执，允许随后重放对应终态事件。planner.progress 按 SUCCEEDED/BLOCKED/FAILED/CANCELLED 四种 status 判断唯一终态。即使 eventId 不同，第二个终态事件、终态事件后的 message.accepted 或 RUNNING 进度也必须拒绝。合法窗口可以从任意已验证 checkpoint 的下一持久事件开始，不要求从 sequence=1 开始；仅含合法终态的一帧窗口仍可重放。

assistant.delta的payload固定commandId/deltaIndex/text；只当前连接、以eventId+deltaIndex去重，不入事件账/聊天历史、不重放。瞬时sequence不推进持久序号或checkpoint；客户端checkpoint只记录最近持久事件，不得用delta更新Last-Event-ID。断线丢弃未完成缓冲并从最终持久消息对账；断线不是取消。Last-Event-ID和afterSequence若同时给出必须指向同一checkpoint，否则400；超过窗口为410 RESYNC_REQUIRED。新连接不新建command/run/版本；取消与成功条件更新选择唯一终态，重放胜者。

调试流沿同信封传输接受收据、delta与final，aggregateId为debugRunId，受保护的安全payload只由Phase018注册；不向普通owner暴露mock rawOutput。内部trace taxonomy沿Phase097首次SDK登记，不为当前卡伪造已实现追踪。

## 禁止路由与验收

机器块中的三条 forbiddenRoutes 是唯一禁止清单：HTTP期望均404，registry producerCount=0；不能添加转发、别名或deprecation handler。`node docs/phase-plans/verify-phase002.mjs --case forbidden-routes` 检查声明、registry与生产目录，临时副本插入旧路由必须非零。本卡无HTTP应用，因此当前证据是静态契约与文件扫描，不声称已发请求得到404；Phase023以后使用真实HTTP存在性反向测试。

API检查逐项验证100/100 operation映射、完整生成区、字段闭合/类型引用、path身份不重复body/query、3.9/3.10关键拒绝fixture、事件/权限/错误/幂等规则与支持文档。hash检查逐项审计全部17处声明（含Replan的3分支），直接读取旅行摘要的requirementHash pattern、数据库Char(64)及固定Phase015/025/043编码来源，拒绝需求/内容摘要与计划前缀格式混用。生成器核对manifest及producer/evolvesAt卡的固定hash，拒绝重复路径（含相同动态路径形状）、错误producer和未登记App Router端点。插入第二张端点表、更改producer或删除DTO必失败；恢复输入后重新运行。公开事件的语义与持久重放序列分别由validateEventEnvelope/validateReplayEvents验证，覆盖合法中段窗口、互斥/重复终态与终态后的消息/进度；debug只在独立ADMIN上下文消费其已注册payload。当前与未来生产者的Schema/集成测试分别承担其实际HTTP、事务、外呼和撤权验收，文档检查不替代后续行为Gate。
