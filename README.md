# Serendipity · 际遇

中文旅行规划工具的开发仓库。本目录就是项目根目录。当前提供可构建的 Next.js App Router 基础首页、统一样式令牌和 shadcn Button，后续阶段接入旅行规划功能。

## 本地启动

先安装 Node.js **24.19.0**。以下命令显式使用 npm **11.7.0**，不依赖系统自带的 npm 版本：

```powershell
node --version
npx --yes npm@11.7.0 ci
npx --yes npm@11.7.0 run dev
```

打开 http://localhost:3000/。首页标题为“Serendipity · 际遇”，“开始规划”按钮目前用于基础组件验证。此阶段启动不需要环境文件、数据库或 AI 凭据。

```powershell
npx --yes npm@11.7.0 run lint
npx --yes npm@11.7.0 run build
npx --yes npm@11.7.0 run typecheck
npx --yes npm@11.7.0 run start
```

`start` 使用已有生产构建；开发服务器与生产服务器都默认占用3000端口，运行另一个前先停止当前进程。样式令牌位于 `src/app/globals.css`，基础 UI 组件位于 `src/components/ui`。

## 阶段验证

`npm run verify:phase003` 在生产构建后运行9条可重复断言。完整17项验收还包括隔离反向测试、真实浏览器、干净安装与 Git 排除回归，由 `node scripts/complete-phase003.mjs --run-all` 在新的冻结 attempt 中执行。已有证据不会被覆盖。

路线校验需要单独提供被忽略的本地开发文档，以及 `docs/runtime-baseline.json` 指定的隔离 npm/CLI/Playwright 工具。完整阶段验收还需匹配摘要的 `.scaffold/checkpoint-import/original-history.bundle`；普通应用安装、构建和启动不依赖这些历史输入。具体来源、精确版本、integrity、安装和审计输出见 runtime baseline 与 `docs/evidence/attempts/Phase003/setup/`。

Next.js 与 eslint-config-next 固定为 **15.5.24**，shadcn CLI 固定为 **3.2.1**。`package.json` 仅对 Next.js 的 PostCSS 依赖固定 **8.5.28**，修复旧传递依赖的路径读取漏洞；该组合需同时通过真实审计、构建和反向验证，不能用忽略审计项替代修复。

## 目录与 Git

- `repositoryRoot = projectRoot`，保留现有 Git 历史和 `origin/main`。
- `src/`、`prisma/`、`tests/`、`public/`、`package.json` 和 `package-lock.json` 按对应阶段直接创建在根目录。
- `docs/` 保存项目规范、执行计划与证据，纳入 Git。
- 内层 `Serendipity · 际遇/` 是仅保存在本地的开发文档目录 `roadmapRoot`，包含阶段卡与公共契约。整个目录已停止 Git 跟踪并加入 `.gitignore`，本地文档保留。
- 不在开发文档目录中创建项目，不新建 `project/` 包装层或第二个 Git 仓库。源码克隆不含本地开发文档，需要执行路线时单独提供该目录。

目录定义见 [目录规范](docs/directory-structure.md) 和 [目录配置](docs/project-layout.json)。历史检查点通过独立迁移收据与本地历史备份核验，开发文档不重新进入当前仓库历史。

## 启动基线

Next.js App Router + TypeScript + Tailwind CSS 4；数据库 PostgreSQL 17、ORM Prisma、鉴权 Auth.js、测试 Vitest/Playwright。Node 固定 `24.19.0`、npm `11.7.0`、create-next-app/Next.js/eslint-config-next `15.5.24`、shadcn CLI `3.2.1`，以执行包 manifest.runtimePolicy 为机器权威。

在项目根目录运行目录与迁移完整性检查：

```powershell
node scripts/check-project-layout.mjs
```

该命令检查项目根、文档目录的 Git 排除规则、当前迁移状态，以及任务000历史文件与原提交的字节一致性；本地开发文档存在时还检查其中没有项目产物。它不代表应用测试或 Phase seal。

旧 `validate-roadmap-v2.ps1` 绑定迁移前目录与提交协议，仅用于历史复核。下一次正式 Phase 执行的预检须按 [执行契约](docs/agent-execution-contract.md) 衔接新布局，不能沿用旧 seal 宣称新目录已经通过阶段验收。

## 开发协作

- 开始任务前阅读根目录的 `AGENTS.md`。
- 每完成一个任务或可独立验证的阶段，检查变更、执行适当验证，然后提交并推送到 GitHub。
- 目录和文档修订使用常规提交；正式阶段按用户授权范围执行 artifact/metadata 双提交及验收。
- 当前进度见 [执行状态](docs/roadmap-run.json)。任务000原始记录和脚本保存在 [历史快照](docs/history/Phase000/README.md)，不覆盖旧证据，也不因整理目录执行任务001。

仓库：https://github.com/KECIHH/Serendipity
