# Phase009：只追加审计与事务边界

本阶段只生产 AuditLog、审计输入纯函数和 `writeAuditLog(tx, input)`。冻结验收为 schema、append-only、recursive-redaction、transaction、system-actor、lookup、bounded-metadata、mutation 八组；输入收据、计划和数据库生成收据位于根 `docs/phase-plans/` 与 `docs/evidence/attempts/Phase009/`。

业务服务使用 `runAuditedTransaction(async tx => …)`，在回调中执行业务写入并 await `writeAuditLog(tx, input)`。边界直接调用产品 db.$transaction，用私有 WeakMap 登记客户端且退出时撤销，并通过 AsyncLocalStorage 绑定当前异步事务上下文；helper 的首参仍是 Prisma.TransactionClient 的封闭子类型。全局客户端、delegate 包装、复制对象、跨上下文及已结束的客户端均拒绝；拒绝在校验起点就标记当前事务失败，即使已有成功审计且错误被吞掉也不能提交。嵌套审计事务在开启独立数据库事务前拒绝，并使外层回滚。验证或持久化失败、未等待的审计、没有成功审计的回调均阻止提交，调用方 catch 掉审计错误仍整体回滚。成功只返回 id/action/createdAt；异常只输出安全错误。不得在业务提交之后另写审计。

封闭 action registry 初始登记 CONFIG_UPDATE→SystemConfig、USER_DISABLE→User、API_KEY_ROTATE→ApiKeyConfig。未来动作由其生产阶段扩展，当前不存在相应管理 API 或未来表。actor 是 USER（已认证 ID 和规范邮箱快照）或 SYSTEM（MIGRATION/SCHEDULER/MAINTENANCE），系统动作持久化两个 null 主体字段及 detailJson.systemActor；targetId 可 null。helper 不承担登录/ADMIN 权限验证，调用业务入口仍须自行完成授权。

`createAuditContext` 在可信服务端边界生成 UUID v4 requestId，可选生成 traceId；同一请求复用原对象。不可变对象由私有 WeakSet 证明本进程生成，克隆对象和客户端传来的标识均拒绝。后台无请求上下文时两列可 null。调用方提供可信网络地址及独立的 32-byte HMAC key，hashAuditIp 使用 HMAC-SHA256 和 audit/ip/v1 域分离，数据库只收到小写 64 位摘要。UA 最多接收 4096 个 UTF-16 单元，去 C0/C1/换行控制字符，按 Unicode 码点截为 256 字符；257 字符输入规范化为 256。网络代理可信源判定属于后续 HTTP 入口，不从浏览器自报头推断身份。

detailJson 只能是对象摘要。根深度为0，最大8；最多1024节点、128单元键名；过多 own keys 在逐项读取属性前拒绝，输入与脱敏输出的紧凑 UTF-8 JSON 均最多16384字节。先对整个输入（含将被脱敏的值）核验界限、JSON 类型与无环性，敏感 key 仅接受已登记完整名称的 NFKC/大小写和 ASCII 点、空格、下划线、连字符变体，拒绝携带私文的动态键名，再递归替换其值为 `***`，不修改原对象。拒绝 getter、Proxy、自定义原型、symbol、稀疏数组、非有限数、未配对代理码点和 NUL；错误不带 key 路径或原始值。

非敏感摘要使用封闭字段：before/after/changes/metadata/items 递归容器；revision/previousRevision/nextRevision/version/previousVersion/newVersion/count 为非负安全整数；isPublic/enabled 为布尔；result=SUCCESS；reasonCode 为 CONFIG_CHANGED/USER_DISABLED/KEY_ROTATED/SCHEDULED/MAINTENANCE；status=ACTIVE/DISABLED/REVOKED；group 和 role 沿既有枚举。changedFields 仅允许已登记的字段名。systemActor 由 actor 注入，调用方不能填顶层同名字段。未知字段或自由文本拒绝；不得把完整 valueJson、秘密或用户原文作为所谓安全 diff。

数据库迁移保留 Prisma 自动生成的目录时间戳，在第一次应用前追加 CHECK、UPDATE/DELETE trigger、TRUNCATE trigger 和 PUBLIC 权限撤销。应用角色必须非 owner、非 superuser、无 DDL/角色切换权限，仅获 AuditLog SELECT/INSERT。即使错误授予 DML，trigger 仍拒绝篡改。唯一例外是实际父 User 删除触发的嵌套 FK SetNull：核验父行消失、旧 actorId 非 null、新 actorId 为 null 且其余所有列逐值相等，邮箱快照保留。User 主键被引用时不可改。物理清理和去标识只能在未来受控 maintenance/ERASE 流程实现并另留审计，当前不设应用可调用的旁路。

验收使用任务独占的 PostgreSQL17 tmpfs、独立迁移和应用角色、合成数据。反向实验只在独立数据库/源码副本移除保护或递归清洗，检查原测试确实失败，再恢复重跑。审计行不通过测试清理删除，随 disposable 数据库销毁；普通业务 fixture 只清理自身 ID。不宣称生产运行、未来维护能力或完整审计页面已完成。

验收扩充的追溯：首轮独立复核发现的三项边界已在本卡修复；attempt-2 为原要求追加文字后被旧计划的逐字校验拒绝，保持失败记录。当前计划以 expectationExtensions 绑定原 frozen-plan 的路径/hash、完整原文与纯追加后缀；校验器仅对 Phase009 的明确收据接受追加，原文、命令、分母、输入路径和失败链均不能删改。证据反向回归覆盖缺收据、错hash、改原文、删前缀、重复收据及原断言字段变化。
