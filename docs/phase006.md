# Phase006 Prisma 与 User 数据层

本卡只建立 User、Role、UserStatus、初始迁移和服务端数据库入口。范围与 13 项固定验收见 [冻结计划](phase-plans/Phase006.json)，恢复与原始输入摘要见 [输入收据](phase-plans/Phase006-inputs.json)。登录、注册、seed、会话和路由错误映射由后续卡实现。

所有业务消费者从 `src/server/db.ts` 导入 `db`。开发与测试通过 `globalThis` 缓存避免模块重载重复实例；生产依赖模块单例且不读取或修改全局缓存。显式生命周期 hook 用于确定性测试。`connectDb()` 与初始化失败仅抛出不携带原始 cause、连接串或驱动日志的 `DatabaseUnavailableError`；后续 Route Handler 负责映射脱敏 503。环境变量复用 Phase004 的唯一 parser。

`src/server/auth.ts` 的 `normalizeEmailV1` 是 seed、注册和登录的唯一邮箱规范化入口。先 trim、校验唯一 @ 与 ASCII dot-atom local-part，再用 tr46 6.0.0 执行严格 UTS #46 non-transitional ToASCII 和 DNS label 校验，最后整体 ASCII lowercase。local-part 为 1–64 bytes，总长不超过 254 bytes。此转换不会像 URL host parser 一样截断路径或把纯数字 DNS 标签改写为 IPv4。

迁移由 Prisma 6.19.0 的 `migrate dev --create-only` 生成，应用前固定目录名并补充 CHECK：邮箱 ASCII/canonical 结构、总长、local-part 长度、DNS label 长度；`revision` 与 `sessionVersion` 非负。数据库的长度/正则 CHECK 负责持久值的 ASCII 形态，Unicode/IDNA 语义由唯一规范化服务验证。`email` 只有唯一索引，不重复建普通索引；另有 status 索引。登录时间或更新时间不改变管理 revision。

在根目录配置本地 `.env` 后，开发命令为 `npm run db:generate`、`npm run db:migrate -- --name <migration_name>`、`npm run db:studio`。不要使用 `prisma db push`；后续 CHECK 调整必须保留为迁移 SQL。依赖精确版本记录在 package-lock.json 与 runtime baseline。

阶段验收使用独立 Docker PostgreSQL 17、专属数据库、仅 loopback 发布的端口及禁用 IP masquerading 的任务网络，合成凭据保存在忽略区 `.scaffold/phase006/database.json`。`node docs/phase-plans/setup-phase006.mjs --database` 创建验收实例；镜像以 immutable digest 固定，首次准备可按 runtime helper 中的 digest 拉取。任何迁移或变异前检查数据库名、容器标签、端口与镜像，禁止复用用户的业务数据库。

宿主机 Prisma CLI 使用其实际支持的 `CHECKPOINT_DISABLE=1` 关闭更新/遥测检查。质量验收另以 Node preload 覆盖真实 CLI 及其 fork 子进程：正常环境不得发出 checkpoint 请求；移除开关的变异必须被探针检出并在公网 I/O 前阻断。浏览器网络拦截与容器网络不能替代该宿主机验证。

固定验收由 `node docs/phase-plans/verify-phase006.mjs --case <case>` 执行。顺序从 auto-generate、auto-migrate、auto-status 开始，再运行计划中其余用例；`--quality` 执行全部既有质量检查。单元测试使用默认 Vitest 发现规则；真实数据库测试使用 `tests/phase006/vitest.database.config.mjs`，不加载会覆盖注入 DATABASE_URL 的共享单元测试 setup。变异只改临时副本，并分别以全新的隔离数据库验证恢复。

报告绑定完整 sourceHashes、输入、计划和所有原始测试/浏览器制品。失败保留在当前 attempt，通过 `complete-phase006.mjs --retry` 冻结下一轮后重跑；已存在的报告不可覆盖。最终通过独立 Agent 复核后，artifact 提交保存实现与报告，`complete-phase006.mjs --metadata` 生成 Gate、进度和完成日志，再执行 metadata 提交、双 shell seal 与推送。当前授权止于 Phase006。
