# Serendipity · 际遇

中文旅行规划工具的开发仓库。开发执行包位于 [Serendipity · 际遇/README.md](Serendipity%20%C2%B7%20%E9%99%85%E9%81%87/README.md)，正式开发从 Phase000 开始；当前尚未创建产品源码。

## 目录与 Git

- 本目录是唯一 `repositoryRoot`，保留既有提交并使用 `origin/main`。
- `Serendipity · 际遇/` 是 `roadmapRoot`，保存 138 张阶段卡与公共契约。
- `Serendipity · 际遇/project/` 是待创建的 `projectRoot`，保存源码和阶段证据，使用外层 Git 仓库。
- 克隆或迁移时保留整个仓库结构。禁止在执行包或源码目录新建 `.git`，也不覆盖远端历史。

## 启动基线

Next.js App Router + TypeScript + Tailwind CSS 4；数据库 PostgreSQL 17、ORM Prisma、鉴权 Auth.js、测试 Vitest/Playwright。Node 固定 `24.19.0`、npm `11.7.0`、create-next-app/Next.js/eslint-config-next `15.5.24`、shadcn CLI `3.2.1`，以执行包 manifest.runtimePolicy 为机器权威。

在执行包目录运行两套 PowerShell 的 `validate-roadmap-v2.ps1 -CompletedThrough -1 -Strict -Json`。完整命令、环境准备、阶段提交与同步步骤见执行包 README。校验器修改还须在两套 shell 运行 `docs/test-validate-roadmap-v2.ps1`。

## 开发协作

- 开始任务前阅读根目录的 `AGENTS.md`。
- 每完成一个任务或可独立验证的阶段，检查变更、执行适当验证，然后提交并推送到 GitHub。
- 文档修订使用常规提交；正式阶段使用 artifact/metadata 双提交，在既有历史之上推进，校验通过并推送后才进入下一卡。

仓库：https://github.com/KECIHH/Serendipity
