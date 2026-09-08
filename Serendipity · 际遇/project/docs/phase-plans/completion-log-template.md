# Phase 完成日志

本文件记录每个 Phase 的自动执行和验收结果，供后续 Agent 校验与用户查阅。执行范围以用户当前指定的任务为准；状态中的下一编号表示下一卡准入位置。

## 记录格式模板

| Phase 编号 | 完成摘要 | 修改文件 | 验证命令及结果 | 未验证项 | 结论 |
| --- | --- | --- | --- | --- | --- |
| PhaseNNN | 实际完成的行为与产物 | projectRoot 相对路径及证据索引 | 实际命令、退出码、分子/分母和报告路径 | 未执行项与具体原因，无则写无 | 可进入下一 Phase / 需修复 |

## 使用规则

- 后续 Agent 每完成一个 Phase 都必须自动更新本日志并提交到 metadata commit，不得用回复中待粘贴的记录替代持久文件。
- artifact commit 不修改本文件；Phase000 在 artifact 内保留此受测模板，随后由 runner 在 metadata 创建正式日志。
- 每条记录同时给出 artifactCommit、attemptId、计划与 Gate 路径，Gate 哈希由 run state checkpoint 绑定。不得写入包含本日志的 metadata commit ID。
- 记录只能报告已经执行的验证。metadata 后的双 shell seal、clean 与 push 由真实收尾命令校验，不预填成功、不回写已封口文件。
- 候选 Gate 全部通过才写可封口候选；双 shell seal 及 GitHub 同步后才具备下一卡准入资格。失败留在当前卡，以新 attempt 保存原因、修复与重验。

## 完成记录

| Phase 编号 | 完成摘要 | 修改文件 | 验证命令及结果 | 未验证项 | 结论 |
| --- | --- | --- | --- | --- | --- |
