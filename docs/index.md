# Serendipity · 际遇 项目契约索引

Owner: 项目文档与需求追踪；producerPhase: 2；消费者: 全部后续 Phase。本索引只登记权威、生产者、消费者、来源与测试映射，不重新定义端点、字段或状态。

## 权威与阅读顺序

用户最新要求与根 [AGENTS.md](../AGENTS.md)、[目录机器定义](project-layout.json) 优先决定任务范围和文件布局。repositoryRoot=projectRoot，内层同名目录只存本地输入且被 Git 忽略；旧路线正文的 project 包装层、路线包必须提交和自动推进要求不覆盖当前协作约定。

产品语义按“路线包 manifest/PRD → canonical/术语/状态机 → 已生产的项目契约 → 当前任务卡 → 历史资料”读取；冲突必须显式处理，不能增加别名容纳两套规则。初次阅读依次为：下面的路线包冻结输入、项目宪法/执行契约/技术栈/目录、产品需求/数据库/UI、API/Prompt/Schema/Provider/隐私及四份支持规范、当前计划、Gate 与完成日志。未来模型、页面和测试只登记生产责任，不作为当前存在性前置。

## 路线包冻结输入

以下为本地路线包输入的规范化绝对来源和实际 SHA-256，不随 shell 当前目录解释。完整 149 个输入（包括只读未来 producer/consumer 卡）由 [Phase002 输入收据](phase-plans/Phase002-inputs.json) 的 pinnedInputs 与 sourceLocations 按 id 关联。克隆源码不会包含这些本地文件，恢复执行必须逐字节提供；不得默默更新 hash。

<!-- input-sources:start -->
| id | 路线包输入绝对来源 | SHA-256 |
|---|---|---|
| manifest | [manifest](<C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/docs/roadmap-execution-manifest.json>) | 497689843e4576c5f8e8a6636d29b04023ac997309a3ffab83cc67d90ea7bf3e |
| product-requirements | [PRD](<C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/docs/product-requirements.md>) | 320583e7baa5c0b3ee15b13ce0bc4f264e8ff1ae531feb94eb71e1102040854b |
| canonical-contract | [canonical](<C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/docs/roadmap-canonical-contract.md>) | 06d0ccdb218482a5688d78a9f69a88a0183cedc9d5eac5d0553e224b8d6e27e5 |
| terminology | [术语冻结表](<C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/docs/术语冻结表.md>) | 403f21a6063aac79a3a93554156b06d9aff9277e6267c8f9ec17109cff4aff9f |
| state-machines | [状态机](<C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/docs/state-machines.md>) | 3dab632bd549b26908312b09b166947b2a26128a0298749ba1c7efc6d3d6717a |
| testing-strategy | [测试策略](<C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/docs/testing-strategy.md>) | 36d90b927e90916a3dcfd0105022884c8f3c64cb04e22996da4cb4299acc93a5 |
| personal-project-waivers | [固定自动阈值](<C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/docs/personal-project-gate-waivers.md>) | d96657b9165dc737a89da1be92e6e15c04b63480ceb6199e3110061d91463644 |
| agent-only-execution | [自动执行契约](<C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/docs/agent-only-execution-contract.md>) | 032bfac53bce2dff89cb7470ae809f0a802ecf1fdf9f2fc266b465a37f838eff |
| phase-gate-schema | [Gate schema](<C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/docs/phase-gate.schema.json>) | e5c42fa3d46e1d6209f471d0bd6b249c2435c3ccf809dc4c73f4ef4b5f962633 |
| phase-card | [Phase002](<C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/Phase002.md>) | 4a7a80ea2cf1ccc4ca02406bc892e4e72c15ec20ca2758718332dd08858f9304 |
<!-- input-sources:end -->

## 项目契约唯一 owner 与首次生产者

producerPhase 是文档首次生产编号，功能实现的首次生产者另见文档和 manifest；不把“已有规范”误判为“已实现功能”。本表与 manifest.projectContracts 的所有已生产文件精确对应。hashRecord 指向真实 hash 的持有者，不在正文内写自引用 hash。

<!-- project-contract-index:start -->
| id | file | owner | producerPhase | consumers | hashRecord |
|---|---|---|---|---|---|
| project-constitution | [项目宪法](project-constitution.md) | 产品范围 | 0 | 001–137 | 对应 artifact blob 与 Gate inputs |
| agent-execution-contract | [执行契约](agent-execution-contract.md) | 阶段事务与证据 | 0 | 001–137 | 对应 artifact blob 与 Gate inputs |
| phase-completion-log | [完成日志](phase-completion-log.md) | 阶段完成记录 | 0 | 001–137 | 每卡 metadata Git blob |
| roadmap-run-state | [进度状态](roadmap-run.json) | checkpoint 索引 | 0 | 001–137 | 每卡 metadata Git blob；checkpoint.evidenceHash |
| tech-stack | [技术栈](tech-stack.md) | 技术决策 | 0 | 003–137 | 对应 artifact blob 与 Gate inputs |
| directory-structure | [目录职责](directory-structure.md) | 源码目录 | 0 | 001–137 | 对应 artifact blob 与 Gate inputs |
| git-workflow | [Git 工作流](git-workflow.md) | Git 提交与同步 | 1 | 002–137 | Phase001 Gate inputs |
| code-style | [代码规范](code-style.md) | 代码边界与质量 | 1 | 003–137 | Phase001 Gate inputs |
| ui-design-system | [UI 设计系统](ui-design-system.md) | 组件与状态设计 | 1 | 003–137 | Phase001 Gate inputs |
| database | [数据库规范](database.md) | 模型、字段与约束 | 1 | 006–137 | Phase001 Gate inputs |
| api | [API 与事件](api.md) | API/DTO/事件信封 | 2 | 005、011–016、023、049、051–052、061–137 | Phase002 Gate details.contractHashes |
| prompt-design | [Prompt](prompt-design.md) | Prompt 变量与输出 | 2 | 015、017–023、090 | Phase002 Gate details.contractHashes |
| travel-plan-schema | [旅行 Schema](travel-plan-schema.md) | TravelRequirement/摘要 v1 | 2 | 017、019–024 | Phase002 Gate details.contractHashes |
| provider-strategy | [Provider](travel-data-provider-strategy.md) | 事实、来源与降级 | 2 | 028–043、092–093、107–110 | Phase002 Gate details.contractHashes |
| privacy | [隐私与用户数据](privacy-and-user-data.md) | 分类、公开、保留与删除 | 2 | 008–013、082–106、123、126–137 | Phase002 Gate details.contractHashes |
| document-index | [文档索引](index.md) | 文档权威与需求追踪 | 2 | 003–137 | Phase002 Gate details.contractHashes |
| auth | [认证支持规范](auth.md) | 凭据、session、限流、重新认证 | 2 | 011–012、082–084 | Phase002 Gate details.contractHashes |
| hosting | [运行支持规范](hosting.md) | Web/worker/数据库/恢复 | 2 | 016、084、119–126 | Phase002 Gate details.contractHashes |
| admin | [管理支持规范](admin.md) | 管理权限、revision、审计 | 2 | 012–015、089–100 | Phase002 Gate details.contractHashes |
| crypto | [加密支持规范](crypto.md) | envelope、key lifecycle、轮换 | 2 | 010、013、015、092、126 | Phase002 Gate details.contractHashes |
<!-- project-contract-index:end -->

API 的方法、路径、授权、幂等、CAS 与首次可运行 Phase 只从 manifest.apiRegistry 生成，[生成器](../scripts/generate-api-contract.mjs) 使用 operationId 对齐；下面的矩阵只引用 operationId。支持文档不维护第二套端点表，未来消费者也不能另建 api-spec/api-contract 权威。

## F-01–F-12 需求追踪矩阵

页面、领域 Schema、数据库模型和产品测试在指定阶段生产，下表为责任映射，路径用代码表示，当前不创建占位实现。完整 J-01–J-10 用户旅程以 PRD 为准：J-01→F-01，J-02→F-02/03，J-03→F-04，J-04/05→F-05，J-06→F-06，J-07→F-07，J-08→F-08，J-09→F-09/10，J-10→F-11/12。

<!-- feature-matrix:start -->
| featureId | page | schema | database | apiOperationIds | producerPhases | tests |
|---|---|---|---|---|---|---|
| F-01 | `/`、`/trips/[id]` | TravelRequirement、TravelPlanSummaryDraft、RequirementState | TravelRecord、ChatCommand、RequirementPatchReceipt | post.plan.draft,patch.travel-records.id.requirements | 016–023、061–064 | Phase021 readiness 全缺失清单；Phase023 重复命令；Phase062 需求 CAS |
| F-02 | `/trips/[id]` 来源与时效 | NormalizedFact、SourceReference、FactFreshness | FactSnapshot、CacheEnvelope | get.travel-records.id | 027–034、093、107–110 | Phase031 合同回放；许可/SSRF/unknown；历史 freshness 双视图 |
| F-03 | `/trips/[id]` 规划进度与结果 | TravelPlanDraftV2/TravelPlanV2（024演进）、qualityReport | PlannerRun、TravelPlanVersion、PlanTrace | post.plan.draft,get.planner-runs.id.events | 017、022–050 | Schema/引用/预算/三段hash；Phase050至少30黄金case；失败零版本 |
| F-04 | `/`、`/trips/[id]` | PlanViewModel、MapViewModel | TravelPlanVersion、PlanWorkspaceSnapshot | get.travel-records.id | 061–081 | 状态/键盘/稳定ID；地图失败文字可读；45场景由115首产 |
| F-05 | `/trips/[id]` 修改/历史 | MutationInput、PlanDiff、TravelReadinessReport | PlanMutation、RestoreCommand、PlanFinalization | post.travel-records.id.commands,post.travel-records.id.version-restores,post.travel-records.id.finalizations | 051–060、065–069、085 | CAS/取消竞态、唯一终态、不可变历史、显式确认与恢复 |
| F-06 | `/login`、`/register`、个人记录 | AnonymousMergeReceipt、DataRequestReceipt、FeedbackReceipt | User、AuthSession、FavoritePlan、ClonePlanCommand、DataRequest | post.auth.register,dataRequests.create,feedback.consents | 082–087、095、126 | owner隔离、匿名一次消费、clone重新核验、ERASE续接、同意撤回 |
| F-07 | `/share/[token]` | PlanViewModel access=share、ShareGrantReceipt | ShareGrant、PlanFinalization | get.public.shares.token,shares.reissue,delete.shares.shareId | 088、105–106 | 固定版本、token单次交付、撤销/过期/停用统一404 |
| F-08 | `/trips/[id]`、`/share/[token]` 导出 | PlanViewModel、SourceSummary | TravelPlanVersion、AssetUsage | post.travel-plan-versions.planVersionId.exports.pdf,post.travel-plan-versions.planVersionId.exports.markdown | 101–104 | 离线中文、事实一致、有界完整产物、发送前撤权fence |
| F-09 | `/admin` 各受保护页面 | 安全管理DTO、治理版本 | User、ApiKeyConfig、PromptVersion、ModelDeployment、ProviderConfigVersion、AuditLog | patch.admin.users.id,post.admin.api-keys.id.rotate,patch.admin.settings.key | 011–015、089–100 | ADMIN每请求校验、最后管理员、审计原子性、激活CAS、密钥不可读回 |
| F-10 | `/admin` 内容管理、`/public/plans/[slug]` | SourceSummary、PlaceMedia.binding、PlanViewModel access=public | Announcement、FileAsset、PlaceMedia、AssetUsage、PlanPublication | post.admin.assets,assets.derivative,publications.read | 094、096、105–106 | 上传隔离/扫描、版权scope、嵌套隐私投影、撤下立即拒绝 |
| F-11 | `/admin` 运行与trace | EventEnvelope、TaskPayload、PlanTrace | DurableTask、Outbox、PlanTrace、TraceEvent | get.admin.logs.planning,get.admin.logs.planning.traceId | 016、025–026、030、049、084、097–100、107–110、119–121、125 | worker重启/lease/fencing、SAVED同事务、脱敏低基数指标 |
| F-12 | 运维CLI、隔离部署环境 | runtime baseline、隐私水位、release manifest | PrivacyRevocationLedger、受控备份 | get.health,get.readiness | 111–137 | 精确镜像/离线、真实恢复、水位不复活、100/20/45固定集、168小时注入与60分钟真实观察 |
<!-- feature-matrix:end -->

## 当前 Phase 与 evidence

当前权威进度读 [roadmap-run.json](roadmap-run.json)，不从任务标题或草稿存在推断完成。Phase002 范围为六份主契约、四份支持规范和确定性文档检查，冻结 [八组计划](phase-plans/Phase002.json)，执行 [总验收器](phase-plans/verify-phase002.mjs)。API/Prompt/Schema/Provider/隐私/index 各一组，再加禁止路由、链接与重复定义，共 8/8；十份输出的 hash 全列入 Gate，内层 fixture 分母单列。

先验证并提交 artifact，再由 [证据生成器](phase-plans/complete-phase002.mjs) 生成唯一 `docs/evidence/Phase002-gate.json`、run state 和完成日志并提交直接子 metadata；当前尚不存在的 Gate 不建立悬空链接。之后执行 Windows PowerShell 5.1 与 PowerShell 7 的 [根布局 seal](../scripts/validate-phase.ps1)，再推送核对远端。失败保留当前 attempt，不降低分母、不覆盖旧报告。

已有前置证据为 [Phase001 Gate](evidence/Phase001-gate.json) 与 [完成日志](phase-completion-log.md)。本卡没有应用路由，因此三个禁止路由只冻结 expected HTTP 404 并验证注册表/源码不存在；真实 HTTP、lint/typecheck/build、Vitest/浏览器/数据库测试由各首次实现阶段生产，本卡不能填写这些命令已通过。合成隐私规则不代表生产政策、真人同意或真人读屏已经验证。

## 历史非权威区

[Phase000 归档说明](history/Phase000/README.md) 与 [原始 Gate](history/Phase000/docs/evidence/Phase000-gate.json) 只用于保留原提交和原字节的审计。旧目录、hash 与 Gate 不修改，不作为当前产品实现的第二套定义。路线包中的 phase-mapping/known-issues 模板通过输入收据保留路径与摘要，不把旧报告当新阶段 PASS。
