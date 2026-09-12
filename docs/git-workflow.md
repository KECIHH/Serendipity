# Serendipity · 际遇 Git 工作流

本规范由 Phase001 生产。repositoryRoot 与 projectRoot 均为仓库根，Git 路径前缀为空。内层 `Serendipity · 际遇/` 是被忽略的本地 roadmapRoot；路线输入只登记路径与 SHA-256，不提交正文。用户最新指令、根 `AGENTS.md`、`docs/project-layout.json` 及根执行契约决定范围和路径。

## 提交信息格式

正式 run 从 `docs/phase-plans/Phase001-inputs.json` 固定的 executionBaselineCommit 开始；`baselineCommit` 与它相等。基线及此前的初始化、Phase000、目录迁移提交保留原格式，历史 Phase000 通过 historicalCheckpoint 导入，不把迁移提交伪装成阶段 checkpoint。

| 类型 | 唯一格式 | 内容 |
|---|---|---|
| 阶段产物 | `phase(NNN): artifact` | 本阶段规范、实现、测试、原始验证报告与独立复核；NNN 为三位阶段号 |
| 阶段元数据 | `phase(NNN): metadata` | 紧随 artifact 的唯一直接子提交，仅修改允许元数据路径 |
| 未封口恢复 | `phase(NNN): recovery` | 只属于当前阶段的可证明恢复修改，逐提交登记 recoveryCommits |

例如任务001使用 `phase(001): artifact` 与 `phase(001): metadata`。baselineCommit 之后，运行中的修复也纳入当前阶段，不能使用通用 feat/fix/docs 提交绕过阶段归属。未封口的 artifact/metadata 尝试保留在历史中，最终 Gate 的 `details.recoveryCommits` 按历史顺序精确列出本阶段的全部中间提交。已封口的 Gate、提交和 hash 不覆盖、不 amend。

2026-09-12 用户授权的两次文档维护使用下列固定登记，不纳入产品 Phase：

| 位置 | 提交说明 | 维护收据 |
|---|---|---|
| Phase012 metadata 之后 | `docs: optimize subsequent phase verification workflow` | `docs/checkpoint-migrations/testing-policy-20260912.json` |
| Phase013 metadata 之后 | `docs: bound reviews and streamline subsequent phase closeout` | `docs/checkpoint-migrations/execution-policy-20260912.json` |

校验器验证每次维护的直接父提交、精确变更路径和摘要后，将其从下一卡的 recovery 计算中分离；不接受任意额外 docs/chore 提交。维护不生成新 checkpoint，也不推进 run state。维护收据不能自引用本提交 ID，提交身份由实际 Git 父链确定；旧收据、政策、本地导航和已封口证据不改写。

## 分支命名规则

正式路线执行分支固定为 manifest.gitPolicy.initialBranch 的 `main`，Phase 内不切换分支。开工前检查当前分支、Git 顶层、origin 的 fetch/push URL 和整个仓库状态；远端固定为 `https://github.com/KECIHH/Serendipity.git`。先执行 `git fetch origin main`，核对本地与远端同步，再将当前 HEAD 固定为本卡 `phaseStartCommit`。现有 run 的 baselineCommit/executionBaselineCommit 保持不变；首次根布局基线的建立属于已完成的历史衔接。

只有用户明确暂停 run 并授权独立实验时，才使用 `codex/feature-<slug>`、`codex/fix-<slug>`、`codex/refactor-<slug>`。实验提交不属于 Phase checkpoint，不能推进 run state。detached HEAD 不满足正式 run 准入，先识别检查点归属并恢复规定分支；不得移动其他工作树使用的分支。

用户授权某一张卡时，只完成该卡。候选 run state 的 currentPhase 指向下一编号表示进度入口，不代表执行下一卡获得授权。文档维护不授权下一阶段，也不推进 `nextPhaseExecutionAuthorized`。

## 变更保护规则

- 不回滚用户未要求回滚的修改，不删除用户未要求删除的文件，不修改与任务无关的配置、目录和函数。
- 不覆盖其他 agent 的工作；主 agent 统一操作共享索引、提交和推送。独立工作树只提交各自任务范围。
- 不强制推送，不重写已封口历史，不删除远端分支；不使用 `git reset --hard`、`git checkout --` 丢弃修改。
- 暂存必须逐项给出明确文件路径，禁止 `git add .`、`git add -A` 把未知文件混入。发现他人已暂存内容先协调，不擅自取消其暂存或顺带提交。
- 检查差异中的密钥、token、真实环境变量、个人数据、依赖目录与构建产物。`package-lock.json` 必须正常版本管理；本地 roadmapRoot 不使用 `git add -f`。

## 提交前检查清单

命令在 projectRoot 执行，先确定对应生产阶段已提供脚本。Phase013 起先按 [测试执行政策](testing-execution-policy.md) 判定调试、正式阶段验收及全量触发条件，再冻结实际执行集合；Phase014 起同时按 [后续开发执行指南](development-execution-policy.md) 安排复核、交接与前置检查。已有计划不追溯缩减。结构化报告记录 command、exitCode、适用环境、分子/分母与输入输出 SHA-256。尚未生产的命令记录 `NOT_CREATED`，不能填 exitCode=0 或计作 PASS。

昂贵验收前先用拟提交路径核对 Windows/Git 长路径、LF、空白规则和秘密扫描的上下文。归档证据不要嵌套复制整段历史目录；以原报告路径及摘要引用已有不可变记录，确需副本时使用当前 attempt 下的短路径。真实秘密不得归档，测试占位与故障反例的误报须核实后精确处理，不能全局关闭扫描或改写已绑定报告。正式暂存后仍核对 Git blob 字节与差异。

| 命令 | 何时必需 | 成功要求 |
|---|---|---|
| `git diff --check` | 每次有文件变更 | 退出码0，无空白错误 |
| `node scripts/check-project-layout.mjs` | 当前及后续阶段 | 退出码0，根目录与历史44文件字节一致 |
| `npm run lint` | 已提供命令，且本次涉及代码或其检查配置；本卡明示时必跑 | 退出码0，不能以跳过脚本代替 |
| `npm run typecheck` | 已提供命令，且涉及 TypeScript/生成类型/依赖配置；本卡明示时必跑 | 退出码0，无类型错误 |
| `npm run test` 或计划中明确的定向参数 | Phase004 后，按政策选择 `full` 或经验证的 `affected`；能力不足回退全量 | 退出码0，实际收集并通过全部规定用例，不能用空选择通过 |
| `npm run build` | 构建输入变化，或本卡/里程碑明确要求；纯文档按相称检查验证 | 退出码0，使用已锁定依赖与运行时 |
| `node docs/phase-plans/verify-phase001.mjs --all` | Phase001 | 退出码0，冻结计划全部结果精确齐全，M0覆盖20/20 |
| `git diff --cached --check` | 暂存完成后 | 退出码0，复核受测工作文件与暂存 blob 字节/hash相同 |

Phase003 前使用结构化 Markdown、字段、schema/hash、Git 与反向文档检查作为当前 Gate；Phase004 前不声称 Vitest 已运行。页面、API 产出后由 Agent 的浏览器或 HTTP 自动断言验证实际加载、权限及错误状态，不用人工阅读签字代替。必经命令失败时保存当前 attempt；定位修复先跑失败项，正式新 attempt 完整满足冻结集合。结果复用未启用时重新执行所有所需项，不改旧报告或把未运行命令记作成功。Phase001–012 的原计划及检查语义保留。

## 双提交 checkpoint

1. 冻结 `docs/phase-plans/PhaseNNN.json` 的 cases、requiredCaseIds、分母、生产者、消费者和修改范围；本地输入以 `docs/phase-plans/Phase001-inputs.json` 中的路径和 SHA-256 固定。不得静默刷新输入摘要。
2. 按 `.gitattributes` 将受测文本规范化为 LF，运行全部必需断言、隔离反向测试和独立 Agent 复核；复核报告绑定实际 planHash 与独立 contextId。
3. 检查 `git diff`，按路径暂存 artifact，检查暂存差异与 hash。提交 `phase(NNN): artifact`；本卡 Gate、run state 和完成日志的新增修改不能进入 artifact。
4. 用 `git rev-parse HEAD` 和 `git rev-parse 'HEAD^{tree}'` 取得实际 artifactCommit 与 testedTree。runner 只在全部结果通过后生成唯一 `docs/evidence/PhaseNNN-gate.json`，符合本地 phase-gate.schema.json。Gate 绑定计划、reviewer、所有结果与产物 hash；inputs 指向 artifact 内的文件，本地原文经输入收据间接固定。
5. 生成候选 run state：completedThrough=N、currentPhase=N+1、lastArtifactCommit、manifestHash、八份 runStatePinnedInputs 的 contractHashes；checkpoints 项至少含 phase/artifactCommit/evidencePath/evidenceHash。evidenceHash 对 Gate 原始 LF 字节计算 SHA-256。historicalCheckpoint 保留 Phase000 原引用。任何文件不得通过 currentCommit 或其他字段引用包含自身的 metadata id。
6. 仅暂存下表允许路径，提交 `phase(NNN): metadata`。验证 metadata 的唯一父提交精确等于 artifactCommit，工作树和索引干净；artifact 的整个仓库 tree id 与 Gate.testedTree 一致。
7. 在 PowerShell 7 与 Windows PowerShell 5.1 分别运行根目录校验入口，均须退出0并返回 PASS。校验必须覆盖 schema、hash、计划集合、Git 原始 blob、历史导入、双提交和 clean；空 Git 前缀不得跳过任何检查。
8. 执行 `git push origin main`，要求退出码0；执行 `git ls-remote --heads origin main` 并核对远端包含 metadata。只有双 seal、clean 和同步同时成立才完成本卡。用户授权范围内才继续下一卡。

| metadata 路径规则 | 允许范围 |
|---|---|
| allowedExactPaths | `docs/roadmap-run.json`、`docs/phase-completion-log.md` |
| allowedPathPrefixes | `docs/evidence/` |

路径相对 projectRoot，在当前布局与仓库路径完全相同，不能额外增加 `project/` 或 roadmapRoot 前缀。原始受测报告和独立复核报告可随 artifact 保存于 evidence/attempts；白名单表示 metadata 可以修改的范围，不意味着全部 evidence 都只能在 metadata 首次产生。

任务001的双 shell 命令如下。后续阶段只替换已完成编号，参数的路径作为单个参数传递：

```powershell
pwsh -NoProfile -File ./scripts/validate-phase.ps1 -Manifest './Serendipity · 际遇/docs/roadmap-execution-manifest.json' -CompletedThrough 1 -Strict -Json
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/validate-phase.ps1 -Manifest './Serendipity · 际遇/docs/roadmap-execution-manifest.json' -CompletedThrough 1 -Strict -Json
```

旧 `roadmapRoot/docs/validate-roadmap-v2.ps1` 仅在隔离检出的原 metadata 提交中核验历史 Phase000。根入口按根执行契约适配，不修改本地开发文档或历史 Gate 来获得通过。

## 脏工作区处理规则

新 Phase 开始前运行 `git status --porcelain=v1`，整个 repositoryRoot 应为空，且 HEAD 应为已同步的上一 metadata；Phase013、Phase014 前分别允许上述已核验文档维护 HEAD，上一卡 metadata 仍指向各自原提交。维护 HEAD 必须单独绑定并同步到远端，不只检查远端存在旧 metadata。Phase014 起同时记录新指南规定的补充输入；Phase015 及以后恢复以前一 metadata 开工。迁移后首次 Phase001 的历史导入按根执行契约处理；已建立的 run 不因维护重置固定基线。

非空时读取路径、索引状态、冻结计划、启动收据和 Git 对象，识别是否为当前阶段可恢复中断。能够证明归属的同阶段修改按恢复协议重验；无法证明归属则记 `BLOCKED`，不擅自暂存、提交、丢弃或覆盖。只有 artifact 而无 metadata 时，验证受测树和报告再生成元数据；实现字节变化必须重新验收。

seal 失败保留失败 attempt 和候选历史，在当前卡修复。push 失败保留本地双提交，先复核远端状态、重验 seal，再重试常规推送，不新造 Gate、不把推送回执写回包含它的 metadata。运行中出现远端分叉或分支保护时保存双方历史并报告具体阻碍，遵循保护流程，不能用强推、merge/rebase 或改写 checkpoint 绕过。
