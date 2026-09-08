# Serendipity · 际遇 目录结构规范

本文件中的实现路径全部相对 `projectRoot`。项目根固定为 `roadmapRoot/project`，本阶段只创建规范与验收产物，下列源码目录和文件在各自生产 Phase 创建；不得为满足目录示意提前生成空目录和占位文件。

## 根目录边界

| 根目录 | 职责 | 约束 |
|---|---|---|
| repositoryRoot | 既有 Git 顶层、根协作文件与完整历史 | 沿用 main、origin 及 baselineCommit，不初始化第二个仓库 |
| roadmapRoot | Phase000 至 Phase137 任务卡、冻结 manifest 与公共契约 | 位于 repositoryRoot 内，冻结输入只读，不直接放业务源码 |
| projectRoot | 应用源码、项目规范、数据库定义、测试与阶段证据 | 固定为 roadmapRoot/project，末级目录名为 project，不包含 `.git` |

证据内路径相对 projectRoot；Git 暂存、差异和 blob 查询使用加上 projectRoot 仓库前缀的路径。当前仓库前缀为 `Serendipity · 际遇/project/`，含中文、空格和中点的完整路径必须作为单个参数传递。文本在验证、hash 与提交前遵守仓库 `.gitattributes` 的 LF 约定。

## 核心目录职责

| 路径 | 职责 | 边界 |
|---|---|---|
| `src/app/` | Next.js App Router 页面、layout、loading/error 边界和 API 路由 | 页面编排与 HTTP 入口，不承载可复用的业务服务实现 |
| `src/components/` | React UI 与领域组件，基础 UI 位于 `src/components/ui/` | 消费已校验的数据；客户端组件不读取数据库、密钥与服务端配置 |
| `src/lib/` | 工具函数、共享纯逻辑、Schema 与明确标记的边界适配器 | 浏览器可用纯逻辑与服务端秘密/网络入口严格分离，不因共享目录而扩大权限 |
| `src/server/` | 服务端服务、授权、持久化与业务编排边界 | 服务端使用，业务服务固定在 `src/server/services/` |
| `src/types/` | TypeScript 公共类型与领域类型导出 | 复用 Schema 推导，避免另建与 Schema 冲突的 DTO/枚举，不包含运行副作用 |
| `prisma/` | `schema.prisma`、数据库迁移和相应数据库资产 | 仅由规定生产 Phase 创建，约束与项目数据库契约一致 |
| `docs/` | 项目规范、运行状态、阶段计划、验证报告和不可变 evidence | 与 roadmapRoot/docs 的冻结输入区分；不得以文档声明代替真实实现与测试 |

## AI 相关文件放置规则

| 完整路径 | 职责 | 使用规则 |
|---|---|---|
| `src/lib/ai/provider.ts` | AI Provider 抽象与统一调用边界 | 实际网络调用只在服务端，经激活配置、秘密引用、预算、timeout 和 trace；不得被客户端导入以获取密钥 |
| `src/lib/ai/schemas.ts` | AI 输入输出 Schema、结构化需求和计划的引用类型 | 纯校验逻辑；统一 producer/consumer 共享的 Schema，不在页面再定义一套 JSON 格式 |
| `src/server/services/planner-service.ts` | 旅行规划服务与确定性流程编排 | 组合已授权需求、版本化配置、Provider 事实、质量校验和事务保存；不包含 HTTP 路由处理 |

Prompt 正文存于数据库不可变 `PromptVersion`，模型与 Provider 配置保存精确治理版本；AI 源码只放调用、校验和编排，不硬编码正文、模型名与 API Key。对应文件在各自生产阶段建立，Phase000 不创建这些业务文件。

## 后台页面

后台页面统一在 `src/app/admin/`，URL 统一以 `/admin` 开头，遵循 `src/app/admin/**/page.tsx` 规则。后台页面消费受保护 API/服务；所有后台 API 在服务端验证 ADMIN，不能依赖 layout 或隐藏 UI 作为唯一授权。

## 前台页面

前台根路由及用户页面统一位于 `src/app/`。后续计划工作台使用 `src/app/trips/[id]/page.tsx`，分享访客页使用 `src/app/share/[token]/page.tsx`，显式公开页使用 `src/app/public/plans/[slug]/page.tsx`；这些路径仅在各自生产阶段创建。页面只读取授权后、经过 Schema 校验的结构化视图，稳定 dayId 参与选择与导航，不以数组下标充当身份。

## API 路由

API 入口统一位于 `src/app/api/`，文件形式为 `src/app/api/**/route.ts`，使用 Next.js App Router Route Handlers。路由处理请求解析、认证/授权、Schema、幂等与响应映射，并调用服务层；公开端点身份、方法和首次生产者由 manifest.apiRegistry 管理，不能自行创建兼容别名和第二条业务入口。

## 业务服务

业务服务统一位于 `src/server/services/`，存放纯业务规则与受控服务编排，不含 Request/Response 路由处理。数据读取、事务、owner/CAS、AI 调用和确定性质量闸门在服务端形成明确边界；外部网络不能放在需要维持数据库锁的版本提交事务内部。

服务结果供页面、Route Handler、共享 worker 与测试复用；同一能力保持一个实现，不因后台、前台、导出或任务入口不同而复制业务规则。客户端不得直接调用 Prisma 或读取服务端环境变量。

## 测试与证据

- 单元/集成测试允许贴近源码放在 `src/**/*.test.{ts,tsx}`，跨模块测试、fixture 与浏览器脚本放在 `tests/`；Vitest 必须同时发现两类测试路径。
- Playwright 脚本、截图和视觉基线按生产契约放在 `tests/`。受控 Provider/数据库 fixture 与证据不得依赖个人机器状态或其他项目资料。
- `docs/phase-plans/` 保存冻结计划、启动收据和文档验证工具；`docs/evidence/attempts/PhaseNNN/<attemptId>/` 保存不可覆盖的失败与验证报告；唯一最终 Gate 位于 `docs/evidence/PhaseNNN-gate.json`。
- `docs/roadmap-run.json`、`docs/phase-completion-log.md` 和本卡 evidence 在 artifact 后的直接子 metadata 提交；原始受测输入、输出与复核报告按执行契约归档并绑定 hash。

## 源码前缀与依赖方向

源码目录统一带 `src/` 前缀，包括 `src/components/ui`、`src/lib` 和 `src/server/services`。页面/路由调用服务，服务调用数据和 Provider 边界，组件消费校验后的视图，Schema/类型提供统一定义；不建立 `src/pages`、`src/services` 和自定义 `src/server/api` 的第二实现。

共享目录不代表可以跨越运行边界。秘密配置、Prisma、治理版本和鉴权实现保持服务端可见；可复用纯 parser/schema 不依赖 Next.js、数据库连接和环境变量副作用。新增文件只服务当前 Phase 的明确产物，未来路径说明不授予提前实现权限。
