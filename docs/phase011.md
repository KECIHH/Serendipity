# Phase011 管理员认证、限流与会话撤销

本阶段只交付 Phase011。输入及其 SHA-256 见 `docs/phase-plans/Phase011-inputs.json`；固定八项验收及当前 attempt 见 `docs/phase-plans/Phase011.json`。唯一 Gate 由 runner 在实现、真实数据库和浏览器验证、独立复核完成后生成。

## 登录与请求边界

`/admin/login` 与 `/login` 复用一个表单和一个 Auth.js Credentials provider，唯一认证 HTTP 入口为 `/api/auth/[...nextauth]`。前者签发 ADMIN audience，只接纳 ACTIVE ADMIN；后者签发 USER audience，接纳 ACTIVE USER/ADMIN。普通注册与用户管理属于后续阶段，本卡无业务登录别名或管理数据 API。

固定依赖为 `next-auth@5.0.0-beta.30`（`@auth/core@0.41.0`）和 `bcryptjs@3.0.2`。服务只通过 `normalizeEmailV1` 规范化邮箱；密码保留原始 UTF-8 字节，先拒绝 12–72 bytes 之外的输入。每个准入成功且格式合法的请求恰好执行一次 cost12 bcrypt compare，未知账户使用进程启动时生成的固定 dummy hash。不存在、密码错误、USER 管理员入口、DISABLED 四类失败统一为 HTTP 401 和“邮箱或密码错误”，响应字段、header 集合一致。输入/CSRF错误分别为400/403；限流为429和不区分 bucket 的 Retry-After；数据库或审计故障为503。

`npm run dev` 与 `npm run start` 通过 `scripts/auth-server.mjs` 启动 Next。Node 入口从 socket 取得直连地址，默认忽略转发头；只有配置的可信 proxy CIDR 才从链尾解析。入口覆盖客户端内部头，对 method/path/时间/nonce/规范地址生成 HMAC 证明；Next handler 在同一请求的 AsyncLocalStorage 范围验签并消费一次。不同请求或重复使用的证明拒绝。该范围只证明传输上下文，限流计数始终在 PostgreSQL。应用被直接通过其他 Next 启动方式访问时，登录缺失传输证明会安全拒绝。

`AUTH_URL` 是唯一外部 origin，非 localhost/127.0.0.1/[::1] 必须 HTTPS；请求 Host、X-Forwarded-Host 或 Proto 不改变 Cookie、CSRF allowlist 或回调地址。`AUTH_TRUSTED_PROXY_CIDRS` 为空表示没有可信代理。每次 Cookie 写请求都检查固定 Origin、Fetch Metadata 和 Auth.js double-submit CSRF token。

## 数据库安全模型

唯一追加迁移 `auth_session_login_attempt` 创建 `AuthSession`、`AuthLoginAttempt` 及两种状态枚举，五份历史 migration 字节不变。用户模型仅添加关系导航。会话包含固定签发版本、访问域和最长12小时期限；随机 token 为256-bit，数据库只存其 SHA-256。Auth.js JWE 只包裹 opaque token 与绝对到期时刻，不保存或返回密码、权限列表或 sessionVersion。

认证服务按 scope/account/ip 字典序取得两个 PostgreSQL transaction advisory locks，在 ReadCommitted 事务内计算15分钟窗口内 FAILED 与未过期 RESERVED。账户上限5、IP上限20；达到阈值的下一请求拒绝。成功仅收敛本次 reservation，不删除先前失败。Retry-After 取所有已满 bucket 恢复至阈值以下所需的最长时间；FAILED 最长900秒，崩溃 reservation 在60秒到期。不同进程共享这些行；不存在进程内计数权威。

`public.auth_now()` 默认使用数据库 statement timestamp。服务和 SQL lifecycle trigger 共用它；应用角色没有替换函数或DDL权限。独立测试库的 owner 才可替换为固定/推进时钟。到期 reservation 在后续 admission 的幂等、有界 sweep 中置 EXPIRED。settlement 锁住对应行，仅能一次 RESERVED→FAILED/SUCCEEDED/EXPIRED；终态不可修改。

应用角色可 SELECT/INSERT 两张表，仅对 session 的 status/lastSeenAt/revokedAt 与 attempt 的 status/completedAt 获得列级 UPDATE。DELETE、TRUNCATE、身份/摘要/期限修改均拒绝，lifecycle trigger 额外保护误授 DML 的场景。当前卡不执行历史保留清理。

## 签发、授权与退出

bcrypt 后，成功事务锁住并重读 User，核对 email、passwordHash、ACTIVE、允许 role 与 sessionVersion；任何并发安全变更均拒绝本次签发。lastLoginAt、AuthSession、attempt SUCCEEDED 和 LOGIN_SUCCESS audit 同事务提交；审计失败回滚全部成功副作用。

`requireAdmin` 每次从 JWE 解出 opaque token，然后用同一数据库查询复核会话 ACTIVE、absolute expiry、ADMIN audience、规范邮箱和 User 的 ACTIVE ADMIN、sessionVersion。返回最小 AdminPrincipal；没有跨请求授权缓存。`withAdminRoute`/`withAdminAction` 将全部资源操作放在守卫之后，写入另验证 CSRF。当前 `/admin` 是包含退出操作的临时成功页，layout 为无导航的中性容器；middleware 只按 Cookie 有无预筛，永不授予权限。

退出先数据库CAS撤销当前session并写 SESSION_LOGOUT，再清 Cookie；其他 session 不受影响。数据库不可用时仍清除能识别的本机会话 Cookie，同时返回503且不声称服务器撤销完成。Auth.js Cookie 解析差异或签出内部错误不能变成虚假成功；UI 只在明确的清除回执下说明本机 Cookie 已清除。角色/状态管理与批量撤销由 Phase012 消费当前边界。

## 验证与证据

八项为 valid-login、uniform-failure、dual-throttle、persistence-proxy、session-revocation、guards、routing-logout、mutation。均在独占、带来源标记、角色分离的真实 PostgreSQL17 disposable 数据库运行；管理员由真实 Phase010 seed 创建，密码、Cookie 与地址只用于合成 fixture，不进入报告。

时序测试四组交错运行，每组预热1次、测量16次；记录实际样本与中位数，固定 median ratio≤1.5、2000轮确定性置换检验 p≥0.01。时序测试不代替响应字节/headers完全相同或 compare恰好一次的断言。并发测试通过真实 pg_stat_activity 的 advisory wait 证明锁生效，再验证两个 bucket 配额；独立进程测试重启后仍被限流。

守卫测试通过真实 Next request store 与数据库运行 Route/Server Action 包装器，未登录、USER audience 以及被撤销的会话对资源查询/写入均为0。浏览器运行真实生产构建和真实 Auth.js，覆盖登录成功、退出、故障、CSRF、非法 Cookie、无循环路由、两个视口、键盘/焦点及自动无障碍。截图在输入凭据之前或清空之后获取。

隔离副本分别去掉会话状态、sessionVersion、dummy compare、account bucket 和 advisory lock，原断言必须实际非零退出，恢复后重新变绿。历史 Phase006–010 回归、完整 lint/typecheck/test/build/format、目录/schema/hash/失败链检查和独立 Agent 复核为共同门槛。所有最终报告精确绑定受测源码；失败 attempt 保留，不覆盖历史 Gate。

环境结论仅为 `ISOLATED_SYNTHETIC`，`productionTraffic=false`。真实身份、生产部署、外部服务调用、真人读屏体验不在本卡验证范围；自动无障碍标记 `AUTOMATED_BROWSER_A11Y`，真人读屏为 `NOT_EVALUATED`。
