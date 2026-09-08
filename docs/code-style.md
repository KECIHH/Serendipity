# Serendipity · 际遇 代码风格

本规范由 Phase001 定义，后续创建源码和工具时执行；本卡不初始化 npm、不配置 ESLint/TypeScript、不实现业务代码。目录以项目根 `docs/directory-structure.md` 为准，API/字段身份以 manifest 和冻结 canonical 为准。

## TypeScript 类型规则

- 禁止使用 `any`。调用无类型第三方库的唯一例外必须局限在适配器内部，写明库名及缺少类型的原因，立即转为 `unknown` 并运行 Schema 校验；不把 any 传到服务签名、DTO 或组件 props。
- 对象结构优先使用 `interface`；联合类型、判别联合与映射类型优先使用 `type`。JSON DTO 从唯一 Schema 推导，不能另写不一致的字段和枚举。
- 导出的函数必须显式声明返回类型，异步函数为 `Promise<T>`。组件显式返回 `React.JSX.Element`，确有空渲染分支时返回 `React.JSX.Element | null`。
- 外部输入、JSON.parse、异常 catch 和第三方响应视为 `unknown`，经边界校验后使用；不以 `as`、非空断言或关闭类型检查绕过失败分支。
- 开启后续工具卡规定的 strict 检查，空值使用明确的 `null`/可选属性语义。封闭联合使用穷尽检查；日期、金额、ID 与 JSON 状态不得用宽泛 string 替代已冻结契约。

## 函数命名规则

函数以动词开头：`get` 读取已有值、`fetch` 执行外部读取、`create` 新建、`update` 更新、`delete` 删除、`validate` 校验、`format` 展示格式化、`parse` 转换外部表示。返回布尔值用 `is`、`has`、`can` 开头，例如 `isPlanFinalized`、`hasActiveSession`、`canExportPlan`。

命名描述业务行为与返回值，避免含糊的 handleData/processStuff。已有 canonical 导出如 `normalizeEmailV1`、`activatePromptModelTuple`、`evaluateRequirementReadiness` 保持原名，不为了动词表重命名既定接口。异步名不能暗示其为纯函数。

## 组件命名规则

组件导出使用 PascalCase 与描述性名词：`TravelPlanCard`、`AdminPromptEditor`、`ChatMessageList`。hook 使用 `use` 前缀并遵守 React hook 规则，领域组件不与 shadcn 基础组件重名。

默认沿用 App Router 服务端组件；只有需要浏览器交互、状态和 effect 的最小边界声明 `use client`。props 只传授权后的可序列化视图，不传 Prisma 实例、环境对象、治理配置或秘密。

## 文件命名规则

| 文件类别 | 固定形式 | 示例 |
|---|---|---|
| 组件文件 | kebab-case.tsx，导出 PascalCase | `src/components/travel-plan-card.tsx` 导出 `TravelPlanCard` |
| 基础组件 | shadcn 生成的精确路径 | `src/components/ui/button.tsx` |
| 纯工具 | kebab-case.ts | `src/lib/format-date.ts` |
| 业务服务 | kebab-case-service.ts | `src/server/services/planner-service.ts` |
| 测试 | 与对象同名 `.test.ts`/`.test.tsx` | `src/lib/format-date.test.ts` |
| 路由/框架约定 | Next.js 固定文件名 | `src/app/api/**/route.ts`、`page.tsx`、`layout.tsx`、`loading.tsx`、`error.tsx` |

后续任务明确要求的路径优先保持精确一致，例如 `src/lib/ai/provider.ts`、`src/lib/ai/schemas.ts`、`src/lib/env.ts`。不另建 PascalCase 文件别名、`src/services`、`src/pages` 或第二套 API 目录。

## API 层职责

API 层位于 `src/app/api/` 的 Route Handlers，负责 HTTP 请求解析、请求大小及 Content-Type 检查、认证和资源权限准入、Schema 校验、提取头部幂等键/requestId、调用服务层以及统一响应映射。请求上下文在这里转换为明确的 owner/actor DTO，不能把浏览器提交的 userId 当作已认证身份。服务提交事务还须复核可变化的 owner/状态/CAS，防止准入后发生竞态。

API 层不负责数据库查询实现、AI Provider 调用、金额计算、规划算法、状态机决策或跨事务工作编排；不得直接调用 Prisma。它不复制 service 业务规则，也不把 Request、Response、Cookie 容器传入 service。返回 success/data 或 success/error 的唯一结构，浏览器与 worker 不各自实现不同错误语义。

## service 层职责

service 层位于 `src/server/services/`，作为服务端业务权威，负责数据库操作与事务、业务规则、当前 owner 校验、CAS/幂等、状态转换、版本保存和 AI 调用编排。它接受经过类型化校验的参数与显式 actor、时钟、取消/预算上下文；同一能力由页面、Route Handler、worker 和集成测试共用。网络调用在持锁提交事务外完成，最终写入事务重新核对权限和版本。

service 层不依赖 HTTP 请求对象、路由、状态码、Cookie、React、DOM 或 UI Toast，不负责请求解析与页面展示；不得从可伪造的前端值推导权限。AI Provider I/O 与 repair 编排固定在 `src/server/ai`，service 调用该服务端边界，避免复制 Provider 网络和解析实现。service 失败抛出有稳定错误码的自定义错误，由 API 层映射响应。

## lib 层职责

lib 层位于 `src/lib`，负责共享纯函数、序列化契约、Schema、parser 和无副作用的计算。输入决定输出，不读取数据库、Cookie 或系统秘密，不发起网络请求，也不根据 UI 状态决定业务资格。`src/lib/ai/schemas.ts` 和纯 parser 可供客户端与服务端共用；`src/lib/ai/provider.ts` 保留规定的 Provider 接口和无副作用类型契约，实际适配器与 repair 只在 `src/server/ai` 实现。

唯一环境入口例外为 `src/lib/env.ts`：必须 `import 'server-only'`，由统一 registry/parser 校验环境变量，只允许服务端导入；不能通过共享 barrel 间接导出到客户端。lib 不负责 HTTP 响应映射、业务事务、Provider I/O 或授权数据读取。Prisma、secretRef 解密、Auth.js 与治理快照保留在 `src/server` 边界；客户端不得直接或间接导入这些服务端依赖。用 `import type` 导入类型不会授权同文件的运行时副作用。

## 错误处理方式

API 层捕获异常并返回统一错误对象，形状固定为以下结构（示例为合成 ID）：

```json
{
  "success": false,
  "error": { "code": "VERSION_CONFLICT", "message": "计划已更新，请重新读取后提交" },
  "requestId": "synthetic-request-001"
}
```

成功响应为 `{ "success": true, "data": {}, "requestId": "synthetic-request-001" }`。错误 code、HTTP 映射及可公开 details 后续由 Phase002 API 契约唯一登记，不在组件添加兼容别名。预期领域失败由 service 抛出自定义错误类，至少有 `code`、安全 `message`，内部 cause 只用于脱敏诊断；未知异常返回安全通用错误并保留 requestId。

不得向客户端泄露堆栈、密钥、系统 Prompt、数据库语句、内部路径、私人原文和未校验 AI 输出。日志同样递归脱敏；权限边界按 canonical 对不存在与无权枚举统一 `404 NOT_FOUND`。取消和失败不能返回 success=true，不静默吞异常、不以空列表掩盖服务错误，不把未知金额补成0。

## 注释规则

仅在复杂规则、不可直观发现的并发约束和第三方无类型边界处写必要注释，说明原因、约束或来源。函数名已经表达意图时不重复叙述；例如 getUser 上方不写“获取用户”。公共类型的 null 语义和不可变字段可用简短文档注释说明，但不得将密钥、Prompt 正文或私人数据放进注释。

## 不做无关重构

当前 Phase 只修改已冻结范围内的文件，不重命名无关函数、不调整无关目录结构、不顺手升级依赖或修改未授权配置。发现上游缺陷时明确记录与本卡的因果关系、影响闭包和回归；已有用户与其他 agent 的修改保持原样。格式化只作用于本次修改范围，禁止用全仓库格式化造成无关 churn。

## 后续自动检查接口

Phase003/004 建立工具后，lint/typecheck 验证显式返回类型、命名、server-only 及客户端导入边界；Vitest 覆盖纯逻辑与 service 规则，HTTP 集成测试覆盖路由映射与授权竞态。测试发现同时包括 `src/**/*.test.{ts,tsx}` 和 `tests/**/*.test.{ts,tsx}`。本卡只通过 Markdown/字段断言验收这些规范，不声称工具或产品行为已存在。
