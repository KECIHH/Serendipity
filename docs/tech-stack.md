# Serendipity · 际遇 技术栈

本文件由 Phase000 冻结项目技术方向，具体启动版本以 `roadmapRoot/docs/roadmap-execution-manifest.json.runtimePolicy` 为机器权威。以下命令是后续生产阶段须建立的接口约定；本阶段未初始化 npm 项目，不表示这些脚本、依赖、数据库和部署已经存在。

## 前端框架

- 前端框架：Next.js 15.5.24 App Router + TypeScript + Tailwind CSS 4。
- 页面路由：`src/app/**/page.tsx`，React 组件使用 TypeScript；有浏览器交互需求的边界使用客户端组件，其余沿用 App Router 服务端能力。
- 脚手架：create-next-app 15.5.24，eslint-config-next 15.5.24，与 Next.js 版本同步。

## 后端框架

- 后端框架：Next.js App Router Route Handlers + TypeScript。
- API 路由：`src/app/api/**/route.ts`，端点身份与首次生产阶段来自 manifest.apiRegistry。
- 业务服务：`src/server/services/`，负责业务编排与确定性规则，Route Handler 负责 HTTP 边界、校验和响应映射。

## 数据库

- 数据库：PostgreSQL 17，固定主版本；Phase119 固定容器镜像完整版本与 immutable digest。
- 任务与缓存协调：PostgreSQL 持久 DurableTask、Outbox、租约、fencing 和幂等账本；不引入额外队列与缓存协调服务。
- 隐私水位：Phase084 创建独立 PostgreSQL 数据库、卷和备份集的 PrivacyRevocationLedger，不能与应用库共用同一数据库或恢复集合。

## ORM

- ORM：Prisma。
- Schema 与迁移：`prisma/schema.prisma` 和 `prisma/migrations/` 在相应生产阶段创建，迁移与数据库约束须保持一致，应用数据库访问统一经 Prisma 和服务端数据边界。

## UI 组件库

- UI 组件库：shadcn/ui + lucide-react。
- CLI 版本：shadcn 3.2.1。
- 组件目录：`src/components/ui` 保存基础 UI，领域组件置于 `src/components/` 的对应业务边界；图标使用 lucide-react。

## AI Provider

- AI Provider：DeepSeek，使用 OpenAI 兼容接口，经 `src/lib/ai/provider.ts` 统一抽象。
- 环境变量：`AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL`、`AI_MOCK`；超时和预算护栏为 `AI_TIMEOUT_MS`、`AI_DAILY_COST_LIMIT`。
- 配置演进：Phase004 的前三项为 bootstrap 输入，Phase015 起退役为历史 test fixture；Web/worker 只读取已激活的不可变 PromptVersion、ModelDeployment、ProviderConfigVersion 及 secretRef，`AI_MOCK` 保留环境护栏。
- 验收服务：真实 adapter 连接隔离 HTTP 合同服务和冻结 record-replay，测试数据与密钥均为合成；不在必经 Gate 使用真实公网调用。

## 测试框架

- 测试框架：Vitest，Phase004 安装，作为唯一单元/集成测试 runner。
- 测试发现：同时包含 `src/**/*.test.{ts,tsx}` 和 `tests/**/*.test.{ts,tsx}`。
- 浏览器测试：Playwright，使用项目锁定版本，在 `tests/` 保存脚本、fixture 和快照，执行真实浏览器 DOM、布局、交互、截图和无障碍断言。
- 数据库与反向验证：真实隔离 PostgreSQL；破坏性 fixture 与故障注入在临时副本执行，记录预期非零退出码及恢复结果。Phase000 本身采用文档、Git 和 schema/hash 断言。

## 鉴权方案

- 鉴权方案：Auth.js Credentials 模式 + httpOnly Cookie + 数据库 AuthSession。
- 会话校验：每次请求核对 ACTIVE、过期、User.status、role 和 sessionVersion；logout 先撤销数据库行再清 Cookie。
- 凭据规则：统一 normalizeEmailV1，密码采用 bcrypt cost 12 并拒绝超出12至72 UTF-8字节的输入；服务端 ADMIN 与资源 owner 检查独立执行。

## 包管理器

- 包管理器：npm
- npm 版本：精确 11.7.0。
- 锁文件：package-lock.json 纳入版本管理，后续干净安装使用 `npm ci`。

## Node 版本

- Node 版本：精确 24.19.0。
- 版本安装：Agent 自动安装 Node 后须显式安装 npm@11.7.0，再分别复核 `node --version` 和 `npm --version`；Node 发行包自带 npm 不能视为目标版本。
- 版本边界：不使用范围和浮动 patch。升级必须形成新的 runtime baseline，按冻结契约规则建立新版本并重跑兼容、安全、镜像、原生依赖、性能与相关发布验证，不能在当前 run 静默修改 pinned 输入。

## 本地开发命令

全部命令在外层项目根 projectRoot=repositoryRoot 执行，仅当其对应生产阶段已创建脚本、依赖和必需环境后运行；未创建时记为不适用，不填写成功结果。`package.json` 和 `package-lock.json` 直接位于此根目录，内层开发文档目录不安装项目依赖。

| 脚本名 | 命令 | 职责 |
|---|---|---|
| dev | `npm run dev` | 启动本地 Next.js 开发服务器 |
| build | `npm run build` | 执行生产构建 |
| start | `npm run start` | 启动已构建的应用 |
| lint | `npm run lint` | 执行代码静态检查 |
| typecheck | `npm run typecheck` | 执行 TypeScript 类型检查 |
| test | `npm run test` | 执行 Vitest 自动测试 |
| format | `npm run format` | 执行项目格式化规则 |
| db:generate | `npm run db:generate` | 由 Prisma Schema 生成 Client |
| db:migrate | `npm run db:migrate` | 在隔离开发数据库应用已登记迁移 |
| db:seed | `npm run db:seed` | 幂等建立规定的测试与 bootstrap 数据 |
| db:studio | `npm run db:studio` | 在开发环境查看 Prisma 数据 |

## 构建命令

- 构建命令：`npm run build`；Phase003 产出基础构建与 typecheck，后续阶段补齐本卡要求的检查。构建前使用精确 Node/npm 和锁文件，禁止把已有机器缓存当作可复现证据。
- 生产启动：`npm run start` 只运行已构建产物，不隐式 migrate、seed 或调用外部 Provider。正式部署迁移通过后续专用流程显式执行。

## 测试命令

- 测试命令：`npm run test`，与已创建的 `npm run lint`、`npm run typecheck`、`npm run build` 及当前 Phase 专用命令共同验收。
- 目录校验：在项目根执行 `node scripts/check-project-layout.mjs`，检查新布局和迁移前证据完整性。
- 路线校验：旧 `validate-roadmap-v2.ps1` 仅适用于历史布局。下一次正式阶段按 `docs/agent-execution-contract.md` 先适配根布局并完成双 shell 回归，再执行阶段 seal；目录校验不代表阶段验收或产品测试已实现。

## 部署方案

- 部署方案：Docker 多阶段非 root 镜像 + Docker Compose，Phase119 建立可复现拓扑，web 与 worker 使用同一应用 image digest，连接应用 PostgreSQL 和独立 privacy-ledger PostgreSQL 存储。
- 发布边界：隔离本地/staging，最终资格为 `LOCAL_RELEASE_READY`；生产流量为零。镜像固定完整 tag 与 digest，记录 SBOM/hash，排除密钥、环境文件、上传、导出、数据库 dump 和开发缓存。
- 恢复边界：应用库、隐私水位库及对象文件按独立责任备份；恢复先重放删除与撤权水位再开放服务，不把备份恢复等同于直接启动旧数据。

## 地图与 PDF

- 地图方案：Leaflet 客户端懒加载；`SystemConfig` 的 `map.provider` 配置 tile URL、attribution 和开关，使用可信公开 POI 计算视口，失败保留文字行程。技术选择依据 Phase074，不在本卡指定新的地图供应商。
- PDF 导出：`@react-pdf/renderer`，内置 Noto Sans SC 常规/中粗中文字体与许可证，离线渲染已校验的固定版本 PlanViewModel；选择依据 Phase101，不使用在线字体和浏览器打印。

## 技术边界

- Prisma 负责服务端数据库访问；Provider 负责模型调用抽象；`src/server/services` 承担业务逻辑，页面和 HTTP 路由只消费服务结果。
- `src/lib/ai/schemas.ts` 定义纯粹输入输出 Schema，`src/lib/ai/provider.ts` 的网络与秘密操作保持服务端边界；客户端不能导入凭据和治理配置。
- 地图、导出、分享和工作台消费同一经过权限投影的结构化版本，不自行生成事实、重算预算或改写质量结论。

## 禁止替换规则

后续 Phase 不得随意替换 Next.js App Router、TypeScript、Tailwind CSS 4、PostgreSQL 17、Prisma、Auth.js、Vitest、Playwright 与上述已冻结核心方案。已登记演进只细化对应生产者契约；改变核心选型须遵循新 runtime/路线版本及影响验证流程，不在某张任务卡中静默引入替代框架。
