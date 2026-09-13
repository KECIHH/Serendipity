# Phase015：最终 AI 治理与调用护栏

本卡建立十个最终治理模型和一条追加迁移；历史八个迁移保持原字节。默认 `ai.calls.enabled=false`、MOCK Provider、八个 PromptModelActivation 为 DISABLED。

调用入口 `callGuardedAi` 按顺序校验 kill switch、精确 Prompt/Model/Provider/PlanningPolicy 版本、owner、类型化输入和隐私、DNS/SSRF、持久 token/Decimal 费用预留，然后调用真实适配器。每次 dispatch 前再次检查开关、ACTIVE 密钥和 reservation CAS。重试最多一次，仅限未收到响应 body 字节的明确 connect/429/5xx，所有尝试共享总 deadline 并各有 reservation。未知费用跨日继续占额，经 Provider 证明或到期上界幂等结算。AiOutputRecord 绑定实际发送消息的 hash、版本、activation revision、policy、时延与用量；全部模式 rawOutput 为 null。

DeepSeek/OpenAI-compatible 适配器使用固定 DNS 结果连接并检查 peer，限制 HTTPS host/port、重定向和响应尺寸，解析真实 JSON/SSE，并中止被取消的阻塞 body。隔离 transport 只能在 test 环境连接数值 loopback。没有默认公网请求，也未验证生产 Provider 效果。

`ProviderConfigKeyReferenceAdapter` 注册到既有 Phase013 ADMIN 协调器。轮换复制不可变 Provider 和绑定的 Model 版本，候选测试经过同一 guarded client，保留全局开关、冻结 Prompt/模型参数、配额、超时、重试与 AiOutputRecord，只允许当前 ADMIN 命令租约解析本次轮换的 DISABLED 候选；每次 dispatch 重验身份、租约和候选集合。最终按全部引用 revision 原子切换，禁用引用不参与。普通 resolver 始终拒绝 DISABLED/REVOKED key。候选拒绝在 Phase013 封闭的轮换响应中映射为 CONFIG_ERROR，Provider 超时或不可用保留原分类。

`npm run ai:enable-mock -- --fixture-config <本地隔离配置路径>` 只接受带当前 run 标记的数据库和固定合成 ADMIN。服务先验证八份真实 MOCK fixture，再激活元组并调用 Phase014 配置审计服务；随后逐 key 通过 guarded client 探测，失败关闭开关并禁用元组。它不创建公开 API。

[PlanningPolicy](planning-policy.json) 的来源缺口在本卡显式补为 SYNTHETIC_ONLY 合成 bootstrap，包含每个数字的单位、上下界、来源与原因。没有把 Phase002 的离线 fixture 或新选数值当成生产批准，当前 policy 不允许 USER 调用。

固定业务分母为8：schema/bootstrap、resolution、isolation-ssrf、timeout/cancel/retry、quota/cost、version/evidence、kill switch、mutation。正式执行先 `node docs/phase-plans/verify-phase015.mjs --precheck`，再 `--all`。预检包含格式、类型、lint、fixture/来源和报告自检、测试收集及双 shell validator 回归；完整验收真实执行原冻结的八条命令、仓库全量、build、PostgreSQL17 迁移状态、六项临时副本变异，以及恢复后的完整卡测试。具体断言集合和数量固定在计划及原始报告中，不以整体 PASS 替代业务映射。

旧 attempt 原字节保留；attempt-10 中断和旧准入缺口明确记录。attempt-5 两份未公开失败日志含合成测试密码，原件留在本地并按精确路径忽略，公开脱敏副本通过 archive-redactions.json 绑定原路径、原 hash、脱敏后 hash 与替换次数；历史计划的原摘要保持不变，失败结果不作为通过依据。恢复时单独检出已同步 Phase014 提交，复制本地固定输入，使用已有四条精确历史空白例外，通过双 shell seal 后再冻结新 attempt；没有重写历史 Gate。验收结果只属于其当前来源，跨 attempt 复用关闭。

完成依据为 [Gate](evidence/Phase015-gate.json)、artifact/metadata 直接父子提交、双 shell seal、干净工作树和远端同步。授权止于 Phase015，未执行 Phase016。
