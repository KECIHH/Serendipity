# AI 输出解析与容错

任务017实现内存中的清洗、解析、固定 Schema 校验、保守语法修复与上下文限长。正式 TravelPlanV2 / TravelPlanVersion 仍由后续任务生产，本卡不保存 planJson 或发送规划成功事件。

`src/lib/ai/schemas.ts` 导出 TravelRequirementSchema、TravelPlanSummaryDraftSchema 和当前八个 Prompt 的专用输出 Schema。`scripts/generate-ai-schemas.mjs` 从 `docs/travel-plan-schema.md`、`docs/prompt-design.md` 的具名 JSON 块生成类型及运行时契约副本；`--check` 比较实际字节并检查 Prompt registry 无漂移。需求另校验日期、人数、预算推导、来源引用和准入派生字段；概要通过服务端 revision/hash/目的地顺序/时长绑定。通过 Schema 只表示结构合法，不授予 readiness、Mutation 或正式版本保存资格。

共享 `cleanAiOutput` 仅去除 BOM、首尾空白与成对外层 code fence。`safeParseAiJson` 限制输入大小，依次清洗、JSON.parse 与 Schema 校验；返回的错误只含已知字段路径和固定摘要。纯 parser/schema 可供客户端导入；含 Node hash、环境、数据库、Provider I/O 及修复编排的模块保留 server-only 边界。

服务端通过 `createNluContext(input, clock)` 注入不可变的11个字段。serverDate 在请求开始时按受控 clock 与 IANA timezone 生成，之后沿用同一对象、signal、deadline 和 token/cost 预算。WeakMap 认证实例并维护共享额度；缺用量保留预留上界，不能按免费处理。`guardedJsonChat` 在持久化原始失败 attempt 后保存私有内存收据，绑定原实例、Prompt/Schema、输入与输出摘要；修复不接受重建 context 或替换原始变量来恢复预算或撤销取消。

`src/server/ai/json-repair.ts` 仅使用 active `planner.repair_json`，通过 guardedJsonChat 最多调用两次，修复调用不嵌套 transport retry。原文只在有界内存和受控 Provider 请求中流转；每次尝试独立追加 canonical AiOutputRecord，使用服务端时长和精确治理版本。修复结果重新通过原目标 Schema、原输入引用和可选确定性语义校验。token 比较保留字符串/数字类别、顺序、已有键值分隔和容器边界；只接受可证明的标点、成对 fence 和引号修正，字符串/数字强转、缺字段补造、事实替换、改变嵌套和未知结构均拒绝。

已有数据库约束对所有 rawOutput 强制 null，本卡完整保留。显式 SYNTHETIC_DEBUG、非生产、合成 MOCK 可以经 `onDebugCapture` 查看最多1024字符的临时裁剪，敏感模式返回 REDACTED；它不写数据库，回调异常不影响追踪记录。生产环境即使声明 capturePolicy 也不会捕获正文。缺 inputTokens/outputTokens 时存 null，reservation 保持 RECONCILING；内部 INVALID_JSON/SCHEMA_MISMATCH 对普通 API 投影为503 PROVIDER_UNAVAILABLE，语义引用失败为400 VALIDATION_ERROR，成本限额与速率限制为429，取消为409（以 docs/api.md 为准）。解析耗尽属于技术失败，未来 PlannerRun 消费者应置 FAILED，不能当作业务 BLOCKED。

`getChatHistory` 在事务锁内复核 owner，按 sequence 返回第一条 system 和最近消息。`buildContext` 转成 typed Message；`truncateContext` 保留必需 system 与最近连续后缀，不修改传入数组，按 Unicode 字符统计。system 本身无法满足 maxMessages/maxChars 时返回 CONFIG_ERROR。通过完整需求 Schema 的 requirementJson 可按既有存储契约保存，仍不创建方案版本。

正式验证以 `docs/phase-plans/Phase017.json` 为准，六个业务分母分别映射原始 Vitest 断言，五项临时副本故障注入必须触发指定业务 witness，恢复后重跑六组。共享 DTO、guarded client、隐私边界与验收设施变化触发全仓库回归，跨 attempt 结果复用关闭。真实 PostgreSQL 17、受限应用角色、十份原有迁移、受控 HTTP/合成 Mock 用于必经验证；实际生产流量与真实私有凭据不在本卡验证范围内。原始报告、来源摘要、调用字段审计和独立 reviewer 记录见本卡 attempts 目录。
