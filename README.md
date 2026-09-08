# Serendipity · 际遇

中文旅行规划工具的开发仓库。本目录就是项目根目录，任务000的项目规范已放在根 `docs/`；应用脚手架和业务源码尚未创建。

## 目录与 Git

- `repositoryRoot = projectRoot`，保留现有 Git 历史和 `origin/main`。
- `src/`、`prisma/`、`tests/`、`public/`、`package.json` 和 `package-lock.json` 按对应阶段直接创建在根目录。
- `docs/` 保存项目规范、执行计划与证据，纳入 Git。
- 内层 `Serendipity · 际遇/` 是仅保存在本地的开发文档目录 `roadmapRoot`，包含阶段卡与公共契约。整个目录已停止 Git 跟踪并加入 `.gitignore`，本地文档保留。
- 不在开发文档目录中创建项目，不新建 `project/` 包装层或第二个 Git 仓库。源码克隆不含本地开发文档，需要执行路线时单独提供该目录。

目录定义见 [目录规范](docs/directory-structure.md) 和 [目录配置](docs/project-layout.json)。此前已提交的开发文档仍存在于历史提交中，本次调整不重写历史。

## 启动基线

Next.js App Router + TypeScript + Tailwind CSS 4；数据库 PostgreSQL 17、ORM Prisma、鉴权 Auth.js、测试 Vitest/Playwright。Node 固定 `24.19.0`、npm `11.7.0`、create-next-app/Next.js/eslint-config-next `15.5.24`、shadcn CLI `3.2.1`，以执行包 manifest.runtimePolicy 为机器权威。

在项目根目录运行目录与迁移完整性检查：

```powershell
node scripts/check-project-layout.mjs
```

该命令检查项目根、文档目录的 Git 排除规则、当前迁移状态，以及任务000历史文件与原提交的字节一致性；本地开发文档存在时还检查其中没有项目产物。它不代表应用测试或 Phase seal。下一阶段接入新布局校验器时同步扩展进度检查。

旧 `validate-roadmap-v2.ps1` 绑定迁移前目录与提交协议，仅用于历史复核。下一次正式 Phase 执行的预检须按 [执行契约](docs/agent-execution-contract.md) 衔接新布局，不能沿用旧 seal 宣称新目录已经通过阶段验收。

## 开发协作

- 开始任务前阅读根目录的 `AGENTS.md`。
- 每完成一个任务或可独立验证的阶段，检查变更、执行适当验证，然后提交并推送到 GitHub。
- 目录和文档修订使用常规提交；正式阶段按用户授权范围执行 artifact/metadata 双提交及验收。
- 当前进度见 [执行状态](docs/roadmap-run.json)。任务000原始记录和脚本保存在 [历史快照](docs/history/Phase000/README.md)，不覆盖旧证据，也不因整理目录执行任务001。

仓库：https://github.com/KECIHH/Serendipity
