# Serendipity · 际遇

中文旅行规划工具的开发仓库。本目录就是项目根目录。当前提供 Next.js App Router 基础首页、数据库基础、管理员认证、受保护的用户与密钥管理，以及脱敏审计查询，后续阶段接入旅行规划功能。

## 本地启动

先安装 Node.js **24.19.0**。以下命令显式使用 npm **11.7.0**，不依赖系统自带的 npm 版本：

```powershell
node --version
npx --yes npm@11.7.0 ci
npx --yes npm@11.7.0 run dev
```

打开 http://localhost:3000/。首页标题为“Serendipity · 际遇”，“开始规划”按钮目前用于基础组件验证。

## 环境变量

复制示例配置后启动本地开发环境：

```powershell
Copy-Item .env.example .env.local
```

| 变量                       | 用途                                                                |
| -------------------------- | ------------------------------------------------------------------- |
| `DATABASE_URL`             | PostgreSQL 数据库连接地址                                           |
| `AUTH_SECRET`              | Auth.js 会话签名密钥                                                |
| `AUTH_URL`                 | 固定认证 origin；本地为 `http://localhost:3000`，其他主机必须 HTTPS |
| `AUTH_TRUSTED_PROXY_CIDRS` | 可信代理 CIDR 逗号列表；默认空，不接受客户端伪造的转发地址          |
| `ENCRYPTION_KEY`           | 服务端 AES-256-GCM 加密主密钥（32 字节 Base64）                     |
| `AI_API_KEY`               | AI Provider 凭据；模拟模式可留空                                    |
| `AI_BASE_URL`              | AI Provider HTTPS 地址                                              |
| `AI_MODEL`                 | AI Provider 模型标识                                                |
| `AI_MOCK`                  | 是否启用受控 AI 模拟；设为 `true` 时不消耗真实额度                  |
| `AI_TIMEOUT_MS`            | AI 请求超时（毫秒）                                                 |
| `AI_DAILY_COST_LIMIT`      | 每日 AI 费用上限                                                    |

服务端启动会一次性校验全部必需变量，缺失或格式错误时直接终止。

## 质量命令

```powershell
npm run lint
npm run format
npm run format:check
npm run test
npm run typecheck
npm run build
```

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

## 目录约定

| 目录                     | 职责                                              |
| ------------------------ | ------------------------------------------------- |
| `src/components/layout/` | 前台站点页头与后台布局外壳                        |
| `src/components/common/` | 可复用的加载、空态、错误态与页头组件              |
| `src/components/travel/` | 后续旅行展示组件                                  |
| `src/components/chat/`   | 后续对话界面组件                                  |
| `src/components/admin/`  | 后台用户、密钥、审计界面与唯一导航配置            |
| `src/lib/ai/`            | 后续 AI 纯接口与共享 Schema；实际网络调用归服务端 |
| `src/server/services/`   | 后续服务端业务规则与编排                          |
| `src/types/`             | 后续从共享 Schema 推导的公共类型；当前只保留目录  |
| `prisma/`                | 数据库 Schema、版本迁移与基础 seed                |

三个公共工具模块分别为 `src/lib/format.ts`、`src/lib/json.ts` 与 `src/lib/api-response.ts`。`src/lib/utils.ts` 只保留 shadcn 的 `cn`；API 响应类型只在 `api-response.ts` 定义。

日期接受真实的 `YYYY-MM-DD` 本地日期，输出中文日期区间；分钟数须为非负安全整数。金额接受无损十进制字符串，固定 CNY/USD、两位小数、四舍六入五成双，不经过 JavaScript 浮点转换。费用展示保留未知、免费、估算、已核验估算和过期的区别，未知金额不显示为零。`truncate` 按 Unicode 码点计数，长度上限包含末尾省略号。

## 公共组件

| 组件           | 必填 props | 可选 props 与行为                                                |
| -------------- | ---------- | ---------------------------------------------------------------- |
| `LoadingState` | 无         | `label`、`className`；`role="status"`、礼貌播报、减弱动态时静止  |
| `EmptyState`   | `title`    | `description`、`action`、`className`；省略说明时不生成空段落     |
| `ErrorState`   | `message`  | `onRetry`、`className`；`role="alert"`，仅有回调时显示“重试”按钮 |
| `PageHeader`   | `title`    | `actions`、`className`；标题渲染为一级标题                       |

`ErrorState` 是客户端组件。服务端组件需要只读错误提示时不传 `onRetry`；交互回调在客户端边界内创建。其余三个组件可直接用于服务端组件。

首页位于 `src/app/(site)/page.tsx`，访问地址仍为 `/`。前台布局提供 `SiteHeader`，根后台 layout 为中性容器；后台受保护 route group 复用唯一 `src/components/layout/admin-shell.tsx`。全局 Toast 仅在根布局挂载一次，使用浅色主题、右上角位置和4秒默认时长。

## 后台访问闸门

`/admin/login` 提供不带后台导航的管理员登录，登录后 `/admin` 重定向到 `/admin/users`。用户管理支持角色/状态筛选、游标分页和权限编辑；后台导航提供用户管理、密钥管理、审计日志与退出。`/login` 使用相同凭据服务供 ACTIVE USER/ADMIN 登录；注册留待其生产阶段。未知账户、密码错误、普通用户进入管理入口以及停用账户均显示“邮箱或密码错误”。

`dev`/`start` 使用 Node 入口 `scripts/auth-server.mjs`，从真实连接取得限流地址；请通过 npm 脚本启动。会话最多12小时，每次服务端请求复核数据库中的会话、角色、状态与 sessionVersion。登录失败按账户5次/IP20次的15分钟窗口持久限流，退出先撤销数据库会话。没有预览变量、查询参数或 Cookie 后门。配置与验证细节见 [Phase011说明](docs/phase011.md)。

管理员不能改变自己的角色或状态，提交后必须保留至少一位启用的管理员。修改通过 `revision` 检查并发版本；成功变化在同一事务内撤销目标全部活动会话、保存幂等收据并追加审计。版本冲突显示最新摘要并要求重新选择操作；同一请求重试复用幂等键。接口、账本和七组验收命令见 [Phase012说明](docs/phase012.md)，阶段完成状态以 Gate、双 shell seal 和远端提交为准。

`/admin/api-keys` 提供不可读回的密钥录入、改名、停用/启用、轮换与紧急撤销；页面只显示12位短指纹。密钥以带记录 AAD 的 AES-256-GCM 保存，敏感写与审计、幂等收据一起提交，已撤销密钥不能恢复。`/admin/logs` 提供有界筛选与游标分页，详情经统一脱敏后以文本展示。当前 Provider 引用集合为空；两引用轮换通过隔离数据库和本地 HTTP 验证。安全边界、重试方式和验收入口见 [Phase013说明](docs/phase013.md)。

完整任务005验收由 `node docs/phase-plans/verify-phase005.mjs --all` 执行，覆盖六个测试文件、质量命令、真实 HTTP、浏览器与临时副本中的反向测试。报告按 attempt 保存，已存在报告不覆盖；失败后使用 `node docs/phase-plans/complete-phase005.mjs --retry` 保存旧计划并开始同阶段的新 attempt。最终 Gate 在 artifact 提交后由 `--metadata` 生成。

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
