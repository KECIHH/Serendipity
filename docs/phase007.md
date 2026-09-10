# Phase007 SystemConfig 与用户投影

本阶段实现非密钥运行配置模型及账户字段白名单。输入固定在 `docs/phase-plans/Phase007-inputs.json`，验收计划固定为8项；本地任务卡正文继续保留在被忽略的开发文档目录。

## 配置模型

`SystemConfig` 包含唯一 `key`、必填 `valueJson` 和 `description`，默认 `isPublic=false`、`revision=0`。应用 `parseSystemConfigGroup` 与数据库 CHECK 同时约束 `AI/UI/EXPORT/SECURITY/GENERAL`；数据库另拒绝负 revision。`updatedByUser` 引用 User，删除更新人将 `updatedBy` 置空，更新用户 ID 级联更新引用。索引覆盖唯一 key、group/key 管理列表及更新人查询。

新增迁移为 `20260910172735_system_config`，保留 Prisma migrate dev 生成的时间戳，在首次应用前加入 CHECK。既有 User 迁移字节保持不变。重放使用任务专用 PostgreSQL 17 库；禁止向不明或共享数据库执行迁移。

## 账户投影

`src/server/projections/public-user.ts` 的 `PUBLIC_USER_FIELDS` 精确包含 `id/email/name/avatarUrl/role/status/lastLoginAt/createdAt`。`admin-user.ts` 的 `ADMIN_USER_FIELDS` 由公共常量加 `revision` 构成。两者类型从常量推导，查询使用相应 select，均不读取密码、电话及会话代数。

这里的 public 表示可交付的账户资料，不表示匿名公开：邮箱只用于已授权的本人或管理上下文。管理投影限后续 requireAdmin 成功后的调用；本阶段没有 API 消费者。旅行分享和公开计划不包含这些账户资料。

## 验证与复现

执行 `node docs/phase-plans/setup-phase007.mjs --database` 准备带 run 标签和数据库注释的独立容器。合成连接信息只写入忽略目录 `.scaffold/phase007/`；报告仅记录脱敏目标与 hash。测试 runner 显式注入 `PHASE007_DATABASE_URL`，测试还验证实际数据库名、版本及 run 注释。未提供该变量时，日常单元测试会明确跳过数据库组；正式阶段验收必须注入并完整执行。

`node docs/phase-plans/verify-phase007.mjs --case <case>` 按冻结计划逐项执行，`--quality` 运行全量测试、构建、相关上游回归、网络与源码约束检查。固定分组为 migration、schema、default-private、key-uniqueness、group-validation、user-fk、projection、mutation。每个测试记录自己的创建 ID，清理只涉及这些 ID；并行测试另外证明其他测试记录及预置 fixture 保留。

变异仅作用于临时源文件和独立数据库：默认公开、移除 group CHECK、扩大账户白名单均须令原断言失败，随后原始迁移及源码重放通过。失败记录保留在当前 attempt，重试创建新 attempt，不覆盖历史证据。

配置键值业务校验、写服务、CAS、审计和公开 API 由 Phase014 承接；真实管理 GET/PATCH 由 Phase012 承接。本阶段不创建 seed、真实配置、页面、Prompt、模型或 Provider 表。用户授权止于007。
