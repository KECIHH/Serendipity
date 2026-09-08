# Phase000 迁移前快照

本目录的 `docs/` 完整保存原 `Serendipity · 际遇/project/docs/` 下的 44 个已提交文件，包含五份规范、启动收据、计划、三次 attempt、独立复核、Gate 和 run state。所有原文件保持字节不变；原始相对路径以本目录作为当时的 projectRoot 解读。

- 原基线：`af3169f81cce66981d4e67a3c42a8fc6c405f77e`。
- 原 artifact：`ab7f2b957b0cd4ba142c46d64643945ceabc8684`。
- 原 metadata：`919b82cfbd9f70622a11b60d119f070f50248c93`。
- 原 Git 路径前缀：`Serendipity · 际遇/project/`。

历史记录中的绝对目录、hash、测试命令和提交均描述迁移前的真实执行，不代表当前根目录布局通过了旧 seal。这里的脚本只供审计；重放时在隔离检出的原提交中运行，不在此快照上运行写入证据的命令。随目录保留的 `.scaffold/` 是本地测试缓存，仍由 Git 忽略。

当前规范在根 `docs/`，当前进度入口为根 `docs/roadmap-run.json`。从项目根运行 `node scripts/check-project-layout.mjs` 可逐文件比对这 44 个文件与原 metadata 提交的 Git blob。
