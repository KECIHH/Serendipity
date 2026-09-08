# Serendipity · 际遇 Agent 执行契约

本项目运行模式固定为 `NEW_BUILD` + `AGENT_ONLY_AUTOMATED_NEW_BUILD`。本文件由 Phase000 从冻结的 manifest、PRD、canonical contract、术语表、状态机、测试策略、Gate policy 和正式 Agent-only 契约派生，不能覆盖这些输入。执行时以用户明确的任务范围为边界；本次授权仅为任务000，完成 Phase000 验收、封口和推送后结束本次执行，不因文档记载完整路线而自动执行 Phase001。

## 单 Phase 执行规则

- 用户授权完整路线时，同一任务自动串行推进 Phase000 -> Phase137，每次只执行当前 Phase，不等待逐卡人工提示。用户指定阶段范围时，只推进至该范围的最后一张卡；下一阶段准入状态不等于下一阶段已执行。
- 每卡完整读取当前任务卡及明确要求的冻结输入；其余资料按直接依赖读取。允许只读未来消费契约以校对接口，禁止提前执行未来任务、使用尚未生产的产物和批量创建占位目录。
- Phase N 开始前核对 `currentPhase=N`、`completedThrough=N-1`、上一卡 PASS、artifact -> metadata 直接父子关系、evidenceHash、双 shell seal、整个 repositoryRoot 工作树干净及 origin/main 已包含上一卡 metadata。Phase000 使用初始 `currentPhase=0,completedThrough=-1`，验证启动条件而不检查不存在的上一卡。
- 实现前冻结 `docs/phase-plans/PhaseNNN.json` 的 phase、attemptId、requiredCaseIds、cases、生产者、消费者与修改范围。每个 case 包含 testCaseId、command、denominator、inputPath、outputPath 和预期结果，之后运行全部原定断言。
- 本次 Phase000 只创建项目规范、启动收据、文档验证与检查点证据，不初始化 npm、不安装项目依赖、不创建业务代码、Prisma Schema、迁移或应用配置。

## 自动化交付范围

完整路线交付本地可运行的软件、真实适配器、权限界面、持久任务、部署脚本和恢复能力，在隔离 release 环境实际运行应用、PostgreSQL、浏览器、容器和导出。必经 Gate 的外部服务边界使用固定 mock、record-replay 和隔离 HTTP 合同服务；不能用 mock 返回值替代产品业务逻辑。

测试身份、凭据和数据由 Agent 在隔离命名空间生成。公共工具、运行时、字体、浏览器和基础镜像可在首次需要时安装并锁定版本/hash；准备制品网络与隔离测试网络分别记账，测试公网请求和生产流量均为零。禁止真实公网发布、真人研究、联系真实用户、发送外部消息和向真实第三方写入。路线最终结论只使用 `LOCAL_RELEASE_READY`。

## 失败重试规则

- 任一断言失败、fixture 缺失、hash 漂移、版本不符和环境不可用均在当前卡记录 `FAIL/BLOCKED`，保留不可变失败 attempt；未封口时 completedThrough 保持上一卡。
- 在当前卡新 attempt 自动复现、修复和重验。计划扩充保存旧计划 hash，不得删减原 requiredCaseIds、分母和阈值；最终结果集合与当前冻结计划精确相等。
- 当前发现的上游实现缺陷允许在当前卡修复，并把受影响依赖闭包的回归纳入当前证据；不得回退 Phase 编号、先进入失败卡之后再修、伪造通过或覆盖历史 Gate。
- 环境缺失先诊断、重试和安装允许的公共工具；仍不可用记录 `blockedCategory=ENV` 和恢复命令。冻结契约互相矛盾记录 `BLOCKED_CONTRACT` 及最小修订建议，不静默刷新 pinned hash。

## V1 范围边界

功能范围只由冻结 PRD 和 `docs/project-constitution.md` 描述，不能引入订单、支付、社交、第三方登录、实时导航和 PRD 其他明确不做事项。运行中不新增未登记的领域状态、端点与产品范围；确需改变时形成新 PRD、manifest、影响矩阵及新 run。当前派生规范的细化必须处于已登记的演进范围内。

## 配置规则

- 不得硬编码 API Key、模型名、Prompt 正文和系统配置。`SystemConfig` 只存非密钥运行配置；Prompt、模型、Provider、规划策略分别以不可变治理版本及激活指针为权威。
- 运行时环境变量通过 Phase004 首产的统一 registry/parser 读取。`AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL` 仅为早期 bootstrap 输入，Phase015 起退役为历史 test fixture，Web/worker 调用读取治理版本及 secretRef；`AI_MOCK` 保留环境护栏。后续配置必须同步 registry、文档和测试。
- `ApiKeyConfig` 保存版本化 AES-256-GCM envelope、`keyFingerprint` 和生命周期；秘密通过 `secretRef` 引用，不明文读回。无凭据 Provider 的 `credentialRequirement=NONE` 要求 `secretRef=null` 且不发送凭据；`REQUIRED` 必须引用 ACTIVE key。
- 配置写入服务端授权并校验 expectedVersion，版本内容不可变，激活使用 CAS。Prompt 与模型组合通过 `activatePromptModelTuple` 同事务切换，单次调用冻结一致性快照。任何配置变更均不绕过审计。

## 数据规则

- 旅行需求和旅行方案使用结构化 JSON，页面只展示校验后的结构化数据。Schema、稳定引用、单位、null/unknown 语义和状态值以冻结 canonical、术语表、状态机及已生产的项目契约为准。
- `TravelPlanVersion.planJson` 是正式计划正文唯一存储；`TravelRecord` 只持有版本指针和版本号，不复制 planJson。不可变 RequirementSnapshot、FactSnapshot、PlanWorkspaceSnapshot、质量报告和 trace 与正式版本同保留期，普通缓存清理不能删除它们。
- 唯一 hash 顺序为：不含 qualityReport 的正文 -> planContentHash；绑定该 hash 的 qualityReport -> qualityReportHash；装入报告的完整正文 -> planHash。全部派生计算须先完成，之后不得修改已计算 hash 的正文；报告不能自引最终 planHash。
- 已知金额采用明确币种、精度、舍入与账本去重；未知金额为 null，不按零计算。来源、fetchedAt、生成时 freshness 和当前 freshness 各自保存；当前缓存不能替换历史快照。
- 写入按服务端 owner、幂等键、requestHash、expectedVersion、expectedRequirementRevision、当前状态和租约/fencing 校验。数据库副作用使用事务，跨存储副作用使用 outbox、持久收据与幂等对账。

## AI 规则

- AI 调用必须通过 `src/lib/ai/provider.ts` 的 Provider 抽象、已激活的不可变 `PromptVersion` 和冻结的 ModelDeployment/ProviderConfigVersion/PlanningPolicyVersion；NEW_BUILD 不创建 PromptConfig/AiModelConfig 过渡表。
- AI 负责理解、候选和表达；确定性服务负责事实、ID、时间、金额、引用、权限、状态与质量闸门。输入、输出、修复结果全部经过 Schema 校验，AI 自评不能冒充事实核验。
- 每次可能计费外呼先预留可证明费用上界，执行 timeout、有限重试、取消和成本护栏；未知计费保持占额并对账，不能因 TTL 到期释放并重复花费。
- 调用失败必须记录安全错误分类、trace/request 标识、精确版本与调用结果；不向前台泄露系统 Prompt、密钥、堆栈、私人原文和未校验输出。失败不创建正常正式版本，不能用 AI 补造 Provider 缺失的事实。

## 权限规则

- 用户只能访问自己的旅行记录，归属必须服务端校验；匿名 Cookie 只授权其临时记录。登录会话每次同时复核 AuthSession、用户状态、角色、过期和 sessionVersion，退出先撤销数据库会话再清 Cookie。
- 后台页面统一 `/admin`，后台 API 必须服务端校验 ADMIN。前台隐藏按钮不能替代授权，管理员也不能隐式突破用户私有数据和分享边界。
- 公开分享只读且默认关闭，`ShareGrant` 固定绑定一个已确认 planVersionId，token 只存 hash；分享不自动成为可搜索发布。创建与换发仅首次交付 token，同键重放同 grant 且 `tokenAvailable=false`。
- owner/share/public 使用唯一 `PlanViewModel` 的 access 判别与递归白名单投影；私人节点保留合法引用并 redacted，不泄露聊天、Prompt、trace、私人坐标和可执行修改数据。公开无效、越权、撤销、过期和停用统一 `404 NOT_FOUND`。
- 产品确认、同意和重新认证仍须完整实现并由合成主体经真实 API/UI 验证；开发 Agent 的自动推进不代表产品用户同意，也不授予生产管理权限。

## 审计规则

后台配置、Prompt、模型、API Key、系统配置、用户状态、文件和分享变更必须写入 append-only `AuditLog`，记录操作者类型、目标、动作、request/trace 标识、时间、结果、原因和安全的版本差异。关键领域写入与审计在同一事务成功，审计失败不能留下未记录的成功写入。

日志不含密码、密钥、token、完整 Prompt、私人原文和内部堆栈的公共输出。AI 调用、计划保存、导出与恢复保留对应安全 trace 和审计。审计是追溯记录，登录限流以 `AuthLoginAttempt` 为计数权威。

## 完成定义

每卡完成须同时满足：当前要求的产物齐全、所有自动 requiredCaseIds 通过、反向断言能变红、独立 Agent 复核通过、证据 schema/hash 完整、artifact/metadata 关系正确、双 shell seal 通过、整个仓库干净且远端包含 metadata。任何缺项均不得宣称完成。

`docs/phase-completion-log.md` 必须持久记录 Phase 编号、完成摘要、修改文件、验证命令及结果、未验证项与结论，并随本卡 metadata 提交。最终反馈给出改动、验证结果、真实未验证项、提交短哈希、分支和推送状态；文档阶段不声称尚未创建的产品命令已通过。

## 检查点规则

- 唯一 Git 顶层为 manifest.repositoryRoot，复用既有 main 与 origin，禁止在 roadmapRoot/projectRoot 初始化第二仓库。Phase000 创建目录前将已同步完整 HEAD 固定为 baselineCommit，启动收据绑定 manifestHash、规范化路径、baselineCommit、启动 ID 和允许初始化文件。基线无 projectRoot 产物；未知非空目录为 BLOCKED。
- 每卡固定 `ARTIFACT_THEN_METADATA`。先按 `.gitattributes` 规范化 LF、验收并提交 `phase(NNN): artifact`；当前 Gate evidence、run state 和本卡完成日志记录不得进入 artifact。随后取得实际 artifactCommit，生成唯一 Gate、run state 与完成日志，提交直接子 `phase(NNN): metadata`。
- Gate 和 run state 只绑定 artifactCommit，不写入包含自身的 metadata id。Gate 绑定实际 testedTree、计划、输入/输出和独立复核报告 hash；run state 单列 manifestHash，contractHashes 覆盖全部八份 runStatePinnedInputs，checkpoint 至少包含 phase、artifactCommit、evidencePath、evidenceHash。
- metadata 的唯一父提交必须精确等于 lastArtifactCommit，允许文件仅为 `docs/roadmap-run.json`、`docs/phase-completion-log.md` 与 `docs/evidence/` 前缀。上述路径相对 projectRoot，Git 暂存、blob 和差异查询须加 projectRoot 相对 repositoryRoot 的前缀。
- 阶段历史检查只遍历 baselineCommit 之后的提交。候选 run state 写 `completedThrough=N,currentPhase=N+1`，但仅当双 shell validator 对 `-CompletedThrough N` 都 PASS、整个 repositoryRoot clean、常规推送 origin/main 并核对远端包含 metadata 后，才取得下一卡准入资格。
- Windows PowerShell 5.1 与 PowerShell 7 分别执行 roadmapRoot 的 `docs/validate-roadmap-v2.ps1 -Manifest docs/roadmap-execution-manifest.json -CompletedThrough N -Strict -Json`。静态校验器不验证网络推送，必须另核对 `git push origin main` 与 `git ls-remote --heads origin main`。
- 中断恢复只根据真实收据、Git 对象和受测 hash 继续。未封口尝试可保存同阶段 recovery 历史，最终 Gate 的 recoveryCommits 按顺序精确列出全部中间提交；已封口历史不覆盖、不 amend。推送失败保留已封口提交，先重验 seal 再重试同步，不新造 Gate、不回写推送回执；run 内远端分叉保存现状并报告，不强推、不 merge/rebase 改写检查点。

## 测试规则

- 纯逻辑、API、数据库、AI 与页面都由 Agent 运行自动断言。单元/集成使用 Vitest，发现路径同时包含 `src/**/*.test.{ts,tsx}` 与 `tests/**/*.test.{ts,tsx}`；浏览器使用锁定版本的 Playwright，保存脚本断言、截图 hash、DOM/布局和必要的键盘、焦点、axe 证据。
- 数据库使用真实 PostgreSQL 隔离库并按测试清理；Provider 只经受控 HTTP、mock 和 record-replay 边界。不得用业务服务 mock、人工观察和未执行命令代替 Gate。
- 反向测试与故障注入只在临时副本执行，明确破坏点、预期变红原因及恢复动作；负例观察成功的 wrapper 退出0，底层被测失败必须有实际非零结果。不得污染正常产品树。
- 结果记录 command、exitCode、numerator、denominator、inputHash、outputHash 与路径。当前 testCaseId 精确覆盖冻结计划且无重复，分子等于正分母；全部通过后由 runner 生成 Gate，不能手写 PASS。最终证据 `simulation=true`、隔离合成环境、`productionTraffic=false`，原阈值与自动阈值相等，`waived=false`。
- 确定性 evaluator 完成后，由独立 Agent 复核实现、断言和视觉证据，持久保存 reviewerRunId、contextId、planHash、结论与意见处置。不同随机种子不能代替独立 reviewer。
- 外部审批使用固定机器 rubric 对隔离配置自动准入，标记 `AUTOMATED_TEST_ADMISSION`，不声称真人批准或生产批准。自动无障碍验收标记 `AUTOMATED_BROWSER_A11Y`，真人读屏体验为 `NOT_EVALUATED`。
- Phase000 使用文件结构、文档内容、Git、schema/hash 和隔离反向验证，无产品单元/集成测试。后续执行已生产的 lint、typecheck、test、build 和本卡专用命令；未生产命令记录不适用，不能假填成功。

## 里程碑闸门规则

每个 Milestone 最后一个 Phase 完成时，必须先完成该 Milestone 的全部验收并封口同步，才进入下一 Milestone。闸门固定为 M0/001、M1/005、M2/010、M3/014、M4/018、M5/021、M6/050、M7/060、M8/073、M9/081、M10/088、M11/100、M12/137；范围由 manifest.milestones 读取，不能临时拆并或跳过。

测试清单、requiredCaseIds、业务场景使用各自分母。固定要求包括 M6 至少30条唯一黄金 case、发布集恰好100条、合同回放20条、视觉45场景及非预期差异不超过0.5%；业务复核固定子集与独立 reviewer 次数依各生产卡执行。Phase136 的注入时钟168小时与至少60分钟真实进程观察分别验收。成本记账区分实现、设施、执行、独立复核与证据整理，未测量记 null/UNMEASURED，不能以成本理由降低门槛。

## 14 项技术决策清单

1. 包管理器：npm，启动精确版本为 11.7.0，提交 package-lock.json；可复现安装使用 npm ci。
2. 技术栈：Next.js 15.5.24 App Router + TypeScript + Tailwind CSS 4；后端使用 Next.js Route Handlers；数据库 PostgreSQL 17，ORM 使用 Prisma；Node 精确版本为 24.19.0。
3. UI 组件库：shadcn/ui + lucide-react，shadcn CLI 固定 3.2.1；组件源码统一进入 src/components/ui，图标使用 lucide-react。
4. 测试框架：Vitest 为唯一单元/集成 runner，于 Phase004 安装；浏览器自动化使用 Playwright，脚本、fixture、截图基线进入 tests，数据库采用隔离真实 PostgreSQL。
5. AI Provider：DeepSeek 的 OpenAI 兼容接口，统一 Provider 抽象和不可变治理配置；AI_API_KEY、AI_BASE_URL、AI_MODEL 仅 bootstrap 阶段使用并于 Phase015 退役为 test fixture，AI_MOCK 保留护栏；Gate 连接隔离合同服务和冻结回放。
6. 鉴权方案：Auth.js Credentials 模式 + httpOnly Cookie + 数据库 AuthSession；每请求复核用户状态、角色及 sessionVersion，密码使用 bcrypt cost 12，身份规范化统一 normalizeEmailV1；登录/退出复用 Auth.js handler。
7. 匿名用户策略：服务端先通过 POST /api/session/anonymous 建立签名 httpOnly anon_token Cookie，原文为256-bit随机值，数据库只存 SHA-256 anonTokenHash；TravelRecord 的 userId 与 anonTokenHash 恰好一个非空，登录显式合并并原子消费匿名凭据，旧匿名身份不再可写。
8. 方案版本机制：TravelPlanVersion 追加不可变，正文只存 planJson；TravelRecord 用 currentPlanVersionId/version 指向当前版本，finalPlanVersionId 与不可变 PlanFinalization 保存确认关系；有效修改、重规划、恢复和重新核验追加版本，CAS/幂等/事务保障无重复写入。
9. 收藏与分享：收藏由登录用户绑定明确 planVersionId；只读 ShareGrant 默认关闭、固定一个 FINALIZED 版本且 token 只存 hash，支持到期、撤销和显式换发，同键重放不重发 token；独立 PlanPublication 承载显式可搜索公开发布，不复用分享 token。
10. 地图方案：Leaflet 客户端懒加载增强层，SystemConfig 的 map.provider 配置开关、tile URL 与 attribution，不在源码固定瓦片供应商；先过滤私人坐标再计算视口，只从可信公开 Place 派生 MapPoint，无合规点不发瓦片请求，失败保留文字行程。
11. PDF 导出：使用 @react-pdf/renderer 和项目内置 Noto Sans SC 常规/中粗中文字体，离线渲染固定 planVersionId 的已校验 PlanViewModel；先鉴权、完整有界渲染并在发送前经 authorizeExportSend 复核，禁止导出时调用 AI 或在线字体。
12. TravelRecord.status 状态机：唯一集合为 `DRAFT|NEEDS_INFO|PLANNED|MODIFIED|FINALIZED|NEEDS_REVALIDATION|ARCHIVED`；clone 创建新的 TravelRecord，clone 目标状态固定为 NEEDS_REVALIDATION，clone 不使用 MODIFIED；目标 version 1 为 trigger=CLONE、qualityStatus=revalidation_required、独立空锁及重映射引用，重新核验成功后追加版本并转 MODIFIED；ARCHIVED 只读且不可恢复。
13. 结构化数据引用规则：实体自身字段用 id，跨对象用 dayId、eventId、placeRef、routeLegRef、stayViewId、nightId；非地点 entityRef 固定为 {namespace,id} 对象；placeRegistry 和 routePlan.legs 为各自唯一权威，sourceCatalog/sourceRefs/fetchedAt 表达来源；数组下标、标题与显示名称不能作身份，MapPoint 仅为展示投影。
14. 固定命名：产品为 Serendipity · 际遇，包名及 ASCII 应用标识为 serendipity；保留唯一字段 providerModelName、paramsJson、keyFingerprint、sessionVersion、durationMinutes、unitCost、amount、knownSubtotal、currentPlanVersionId、finalPlanVersionId、qualityReport、PlanViewModel、MapViewModel；User.role 仅 USER/ADMIN，首稿入口固定 POST /api/plan/draft，源码统一 src/ 前缀，后台统一 /admin，所有其余名称沿用冻结术语表和 manifest.apiRegistry。
