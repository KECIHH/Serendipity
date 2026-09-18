# Serendipity · 际遇 M4 里程碑闸门报告

范围：Phase015–018。所有数字来自隔离环境中的确定性执行，`simulation=true`、`productionTraffic=false`、`providerMode=mock`。
本报告不声称任何真实公网发布、真实凭据、真人评审或生产流量；Phase018 的 artifact commit、testedTree 与完整输入 hash 见 `docs/evidence/Phase018-gate.json`。

## 1. 里程碑构成

| Phase | 交付 | artifactCommit | Gate evidenceHash |
|---|---|---|---|
| 015 | Provider/Prompt 治理、guarded client、用量预留 | `77592c56b748682fbcc1e664741aab11fc51a1f4` | `6ffbb7ac1355469e4b9ffdb8359f0044d7f1b0dc753cf43a2ee977bab0865543` |
| 016 | 会话命令、持久事件与 SSE、DurableTask/Outbox | `fe007e2dea79d708c95198e4e58085ed85c43a3e` | `53c280843569e373380ad03ed60a0847f68daaf27160e4dd31a7ab6140887095` |
| 017 | AI 输出解析、保守语法修复、上下文限长 | `879534806f76121c0e77b5252940467f4dc307c3` | `a0b4c64958e75aa8d69636854c8ac2cbd6c690caf0bee595806f4cfb33ecb7be` |
| 018 | Mock Provider 故障矩阵、管理员 AI 调试台、M4 Gate | 见 `docs/evidence/Phase018-gate.json` | 见 `docs/roadmap-run.json` 的 Phase018 checkpoint |

## 2. 冻结契约（Phase015–018 共同输入）

- Prompt/Model/Provider 三指针由 `PromptActivation` 与 `PromptModelActivation` 共同 revision 冻结；调试请求不能选择 deployment、Provider URL、secret 或任意 System Prompt。
- 解析与 Schema 由 Phase017 冻结的八个 Prompt 专用输出 Schema 与 `TravelRequirement`/`TravelPlanSummaryDraft` 承担；`rawOutput` 在数据库层由 CHECK 强制为 null。
- 事件信封与重放由 Phase016 的持久事件承担；调试 delta 属瞬时事件，不进入任何持久表。

## 3. M4 故障注入分母

固定 8 组 fixture，命令 `npm run test -- mock-provider ai-debug-api ai-e2e`；每组恰好一行报告。

| # | fixture | failureProfile | 期望状态 | 期望错误码 | 期望 attempt | 期望 Mock 外呼 |
|---|---|---|---|---|---|---|
| 1 | success | `success` | SUCCEEDED | — | 1 | 1 |
| 2 | timeout | `timeout` | FAILED | `PROVIDER_TIMEOUT` | 1 | 1 |
| 3 | invalid JSON | `invalid_json` | FAILED | `INVALID_JSON`（仅限 ADMIN 诊断分类） | 1 | 1 |
| 4 | schema mismatch | `schema_mismatch` | FAILED | `SCHEMA_MISMATCH` | 1 | 1 |
| 5 | repair | `repair` | SUCCEEDED | — | 2 | 2 |
| 6 | stream interruption | `success` | SUCCEEDED | — | ≥1 | ≥1（GET 期间 0） |
| 7 | cost | `cost` | FAILED | `COST_LIMIT` | 0 | 0 |
| 8 | authorization | `success` | 拒绝 | `AUTH_REQUIRED`/`FORBIDDEN` | 0 | 0 |

阈值：8/8 通过；debug 正式计划写入 0；Mock 网络调用 0（Mock 模式无公网出口）；每个 fixture 有唯一 report 行。
成本组以共享 `NluContext` 的 token/cost 预算耗尽触发 `COST_LIMIT`，证明预算校验先于任何外呼；Mock 计价在治理引导中为 0，因此该组不依赖计价非零。

## 4. 失败样本与反向控制

五项临时副本故障注入，各自必须让指定业务断言变红，恢复后重跑八组：

| 注入 | 目标文件 | 目标 fixture | 业务 witness |
|---|---|---|---|
| 移除管理员守卫 | `src/app/api/admin/ai-debug/test/route.ts` | authorization | `ADMIN_GUARD_REQUIRED` |
| Mock 引入随机内容 | `src/server/ai/mock-provider.ts` | success | `MOCK_DETERMINISM_REQUIRED` |
| 跳过严格 Schema 校验 | `src/lib/ai/json-parser.ts` | schema mismatch | `SCHEMA_MISMATCH_REQUIRED` |
| 调试结果写入正式记录 | `src/server/ai/debug-runner.ts` | success | `FORMAL_PLAN_WRITE_BOUNDARY_REQUIRED` |
| 调试 delta 持久化 | `src/app/api/admin/ai-debug/stream/route.ts` | stream interruption | `TRANSIENT_DELTA_REQUIRED` |

## 5. 未验证项与 waiver

| 项 | 状态 | 说明 |
|---|---|---|
| 真实 Provider adapter（DeepSeek 等） | 未验证，非本里程碑必经 | 由后续隔离 contract-replay 卡负责；M4 只证明 Mock/受控边界 |
| 正式 `TravelPlanV2` / `TravelPlanVersion` | 未验证，非本里程碑必经 | Phase024/025 生产；本里程碑只证明调试不写正式计划 |
| 真实用户、真实凭据、公网生产流量 | 未验证且恒为 0 | agent-only 契约禁止；本报告不声称完成 |
| 独立 Agent 复核 | 已验证 | 见 `docs/evidence/attempts/Phase018/attempt-1/review.json`（`reviewerRunId` 记录于 Gate） |

`waived=false`：本里程碑未减免任何固定分母，未使用低于阈值的替代验收。

## 6. 下一阶段输入

- Phase019–023 可只读消费：`AiProvider` 接口、guarded client、`PromptActivation`/`PromptModelActivation`、`AiOutputRecord` 的 canonical 字段、安全解析与 `AiDebugRun` 的受限诊断投影。
- Phase019 起新增任何 Prompt/模型/事件契约必须沿用同一 activation 与 canonical hash 规则，不得为调试路径新增第二个 Mock 实现或旁路守卫。
