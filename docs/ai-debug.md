# 管理员 AI 调试（Phase018）

任务018 在唯一 Mock Provider 上提供管理员调试工作台与故障注入矩阵，证明 Provider、Prompt、流式传输与解析护栏闭环。本卡不生产正式 `TravelPlanVersion`，调试结果也不改变任何用户的旅行记录。

## 端点

| operationId | method | path | 成功状态 | 说明 |
|---|---|---|---|---|
| `post.admin.ai-debug.test` | POST | `/api/admin/ai-debug/test` | 202 | 持久接受一次调试调用，返回 `AiDebugReceipt` |
| `post.admin.ai-debug.stream` | POST | `/api/admin/ai-debug/stream` | 200 | 同一持久接受服务，SSE 推送 receipt、瞬时 delta 与最终 `EventEnvelope`；EventEnvelope 帧的 SSE `id` 等于 `eventId` |
| `get.admin.ai-debug.runs.id` | GET | `/api/admin/ai-debug/runs/{id}` | 200 | 安全聚合状态、attemptId 集合与终态摘要；零 Provider 调用 |

三个端点全部经过 `withAdminRoute`（`requireAdmin` + Origin/CSRF 双提交），错误使用公共 errorPolicy 映射并携带 `requestId`。

## 请求与响应 DTO

`AiDebugRequest` 只接受 `promptKey`、`variables`、`failureProfile` 三个字段。任何 deployment、Provider URL、secretRef、密文或任意 System Prompt 字段都会被拒绝为 `VALIDATION_ERROR`；`variables` 还会拒绝秘密形状的键值。

`failureProfile` 取值：`success`、`timeout`、`rate_limit`、`server_error`、`invalid_json`、`schema_mismatch`、`network_error`、`cancel`，以及调试专用的 `cost`（共享预算耗尽边界）与 `repair`（语法修复边界）。前八个与 Mock 的 `failureMode` 一一对应且完全确定：没有随机延迟、没有随机内容。

响应只包含安全投影：`promptVersionId`、`promptHash`、`deploymentId`/`deploymentConfigVersion`、`providerId`/`providerConfigVersion`、经裁剪与脱敏的 `rawOutput`（≤1024 字符）、`parsedData`、`schemaValidation` 与 `aiOutputRecordId`。不返回 Prompt 正文、`secretRef`、`baseUrl`、`encryptedKey` 或堆栈。

`INVALID_JSON` 与 `SCHEMA_MISMATCH` 只出现在经 ADMIN 授权的诊断字段 `schemaValidation.diagnosticCategory` 与 attempt 分类中；普通 API 错误始终映射为 `503 PROVIDER_UNAVAILABLE`。

## 持久调试合同

`AiDebugRun(id, adminUserId, idempotencyReceiptId unique, taskId unique, payloadRef, payloadHash, status, traceId unique, attemptIdsJson, finalSummaryJson?, errorCode?, createdAt, completedAt?)`：

- 接受事务同写运行、受控 `TaskPayload` 输入引用与 `AI_DEBUG` `DurableTask`；幂等键复用返回同一 run，不同 payload 为 409 `IDEMPOTENCY_KEY_REUSED`。
- 身份（adminUserId、receipt、task、payloadRef、payloadHash、traceId、createdAt）不可变；终态不可重开；状态只能 `PENDING → RUNNING → SUCCEEDED|FAILED|CANCELLED`。
- 调试服务只关联 attempt：`AiOutputRecord` 的唯一写入者是 Phase015 guarded client，`travelRecordId` 与 `commandId` 均为空，`rawOutput` 维持数据库强制 null。
- 传输中断（客户端断开）不产生领域结果：run 保持可恢复，任务回到可领取状态，下一次 worker 以新的 attemptNo 继续。

## 隔离与确定性

- Mock 故障配置只在 `NODE_ENV=test`，或调用方声明 `mockProfileVerified` 且注册表重新读取数据库身份确认是 `phaseNNN_disposable_*` 合成库时生效；生产数据库无法使用调试故障注入。
- `locale`、`timezone`、`serverDate` 始终由服务端注入，调用方提供的同名变量会被覆盖。
- delta 只经 SSE 瞬时推送，不进入 `ChatCommandEvent` 或 `Outbox`，也不重放。

## 验证

- 单元：`tests/phase018/mock-provider.test.ts`（各 failureMode 的固定输出、chunk 边界、fake clock、trace、取消）。
- API：`tests/phase018/ai-debug-api.test.ts`（DTO 边界、权限/CSRF/幂等、activation 缺失、脱敏、错误码与 requestId）。
- 集成：`tests/integration/ai-e2e.test.ts`（八组 fixture 与正式写入计数）。
- 专项命令：`npm run test -- mock-provider ai-debug-api ai-e2e`。
- 反向验证：`node docs/phase-plans/verify-phase018.mjs --negative-controls`。

正式证据以 `docs/phase-plans/Phase018.json` 与 `docs/evidence/Phase018-gate.json` 为准。
