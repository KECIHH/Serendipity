# Serendipity · 际遇 认证与凭据契约

Owner: 认证安全；producerPhase: 2；实现消费者: Phase011、Phase012、Phase082–084。本文件拥有凭据规范化、会话准入、限流与重新认证规则。[数据库规范](database.md) 拥有持久字段，[API 契约](api.md) 拥有端点和 exact DTO，[隐私规范](privacy-and-user-data.md) 拥有保留、撤回及删除。路线包来源、绝对路径和 SHA-256 见 [输入清单](phase-plans/Phase002-inputs.json) 与 [索引](index.md)。本阶段只验证文档规则。

## 唯一凭据服务

Auth.js Credentials 是唯一登录/退出 handler；框架路由边界由 API 契约的 apiPolicy 单列。Phase011 的共享 credentials-service 同时服务管理员和普通登录入口；注册由 Phase083 首产，匿名合并由 Phase082 首产。不能新建业务登录别名、复制第二套凭据校验或提前依赖后期模型。

`normalizeEmailV1` 依次 trim 外围空白、拆分唯一 @、验证 ASCII local-part、对 domain 执行 UTS #46 non-transitional IDNA ToASCII，再校验 DNS label 并整体 ASCII lowercase。local-part 为 1–64 bytes，不允许首尾点或连续点；整体不超过 254 bytes。注册、登录、seed 与数据库 CHECK/unique 使用同一结果；不得把 Unicode local-part 猜成 ASCII。

密码按原始 UTF-8 字节校验 12–72 bytes，不 trim、不 lowercase、不作 Unicode 归一化；确认字段按原字节比较。只使用 bcryptjs cost 12，超过 72 bytes 在 compare/hash 前拒绝，不能依赖 bcrypt 截断。账户不存在仍执行一次启动时准备的固定 dummy hash compare；正常账户、未知账户、禁用账户与 ADMIN 入口的 USER 失败拥有相同外部状态、header 和“邮箱或密码错误”文案。内部原因通过安全 requestId 定位，不写原始邮箱或密码。

## 会话与授权

Cookie 使用 256-bit CSPRNG opaque token 或其 Auth.js 签名/加密封装，httpOnly、SameSite=Lax、path=/，非本机环境强制 Secure。绝对有效期 12 小时，lastSeenAt 不延长有效期；数据库只存 tokenHash。每次请求复核 AuthSession 的 ACTIVE、expiresAt、audience 与 User 的 ACTIVE、role、sessionVersion；Cookie 内角色声明、middleware 重定向和 UI 隐藏均不能代替数据库复核。

USER audience 可接纳 ACTIVE USER/ADMIN；ADMIN audience 还必须是 ACTIVE ADMIN。ADMIN 只授权管理职责，不隐式授予私人行程 owner 权限。会话终态 REVOKED/EXPIRED 不可恢复。角色/状态/凭据安全变更原子递增 User.sessionVersion 并撤销活动会话。

logout 正常顺序为数据库 CAS 撤销、提交、清 Cookie。数据库失败仍清客户端 Cookie 以降低风险，但返回安全失败，不能宣称服务器会话已撤销。所有 Cookie 授权写操作验证 CSRF token 和允许 Origin，拒绝跨站 Fetch Metadata；Origin、代理地址均来自可信配置，不信任任意 X-Forwarded-For 或 Host。

## 数据库限流

唯一计数权威为 AuthLoginAttempt。LOGIN/REGISTER 使用独立 scope，共享同一 admission 服务和有类型配置。事务按字典序获取 HMAC 后 ipHash/accountHash 对应的 PostgreSQL advisory transaction locks，计数 15 分钟内未过期 RESERVED 与 FAILED，然后预留一次 RESERVED。账户阈值 5 次、IP 阈值 20 次，达到任一阈值锁 15 分钟；对外统一 429 和 Retry-After，不披露触发的 bucket。

本地默认 reservation TTL 为 60 秒，时钟来自数据库或注入 clock。完成只能幂等收敛为 FAILED/SUCCEEDED；崩溃预留到期才由 job 收敛 EXPIRED。成功不能清空同 IP 失败历史。限流或审计数据库不可用时拒绝准入，重启不能解除计数，AuditLog 不能作为“先查询再写入”的替代权威。

## 匿名、注册与擦除

匿名 bootstrap 只建立或复用签名 httpOnly anon_token，不创建业务行、不返回 token 原文；数据库后续只保存 anonTokenHash。匿名凭据被消费后不可继续读写、取消或合并到另一账户。Phase082 在合并事务中消费 anonTokenHash、转移归属、记录 AnonymousMergeReceipt，提交后才签发会话；原 ownerKeyHash/requestHash 不改写，在途命令从当前 owner 与 alias 解析权限。跨 alias 幂等碰撞必须整笔拒绝。

Phase083 注册始终创建 USER，拒绝角色和会话字段注入；新邮箱与重复邮箱返回相同 202、body、headers 和站内登录引导。注册本身不签发 session、不合并匿名资料。邮箱唯一约束裁决并发；任何失败不留下部分账户/Profile。

ERASE 的重新认证仅使用当前密码及 confirmErasure=true；EXPORT 禁止夹带该字段。先持久化独立 PrivacyRevocationLedger 意图，再投影应用库，流程见隐私规范。已接受擦除不要求已注销主体再登录；密码不进入 requestHash、任务、日志或证据。receipt 只授最小状态读取，不能下载个人数据。

## 可执行规则与验证

Phase011 的真实实现及当前运行边界见 [阶段说明](phase011.md)。两入口复用一个 Credentials Provider；Auth.js JWE 与 Cookie 的到期时间均固定为数据库的绝对期限。Node ingress 的连接证明、固定 origin、默认不信代理、请求范围防重放及最小列权限由 [hosting](hosting.md) 与阶段说明展开。退出须以严格解码的当前会话完成撤销，框架解析失败不能冒充成功；本机清 Cookie 与数据库撤销结果分别表达。

以下块是本文件机器规则；测试用合成字符串与注入时钟解释规则，不声称已经运行 Auth.js、bcrypt 或 PostgreSQL。Phase011/083 必须再通过真实实现和并发数据库验证。

<!-- contract:auth-policy -->
```json
{
  "schemaVersion": 1,
  "producerPhase": 2,
  "implementationPhases": [11, 12, 82, 83, 84],
  "roles": ["USER", "ADMIN"],
  "userStatuses": ["ACTIVE", "DISABLED"],
  "sessionStatuses": ["ACTIVE", "REVOKED", "EXPIRED"],
  "email": {"normalizer": "normalizeEmailV1", "localPart": "ASCII_DOT_ATOM", "localMaxBytes": 64, "maxBytes": 254, "domain": "UTS46_NON_TRANSITIONAL_TO_ASCII", "lowercaseAscii": true},
  "password": {"encoding": "UTF-8", "minBytes": 12, "maxBytes": 72, "normalize": false, "algorithm": "bcryptjs", "cost": 12, "missingAccountCompare": "DUMMY_HASH"},
  "session": {"randomBits": 256, "persist": "SHA256_HASH_ONLY", "httpOnly": true, "sameSite": "Lax", "path": "/", "secureOutsideLoopback": true, "absoluteMaxAgeSeconds": 43200, "slidingExpiry": false, "databaseCheckEveryRequest": true, "logoutOrder": ["REVOKE_DATABASE", "COMMIT", "CLEAR_COOKIE"]},
  "throttle": {"owner": "AuthLoginAttempt", "scopes": ["LOGIN", "REGISTER"], "locks": "SORTED_POSTGRES_ADVISORY_XACT", "windowSeconds": 900, "accountLimit": 5, "ipLimit": 20, "lockSeconds": 900, "reservationSeconds": 60, "countedStates": ["RESERVED", "FAILED"], "successClearsFailures": false, "storageFailure": "DENY"},
  "csrf": {"tokenRequired": true, "originAllowlist": true, "rejectCrossSite": true},
  "registration": {"httpStatus": 202, "role": "USER", "newAndExistingIndistinguishable": true, "createsSession": false, "mergesAnonymous": false},
  "erasure": {"freshPasswordAtAdmission": true, "confirmErasure": true, "ledgerBeforeProjection": true, "reauthorizeAcceptedIntent": false}
}
```

验收归属 `Phase002:api`：邮箱 IDNA/点号/大小写、密码 UTF-8 边界、过期/撤销/版本不匹配会话、双 bucket/TTL、角色注入与重新认证边界。命令 `node docs/phase-plans/verify-phase002.mjs --case api`，具体报告由当前冻结计划定位。拒绝例必须断言规则诊断，不能把 TypeError 等程序错误当作预期拒绝。
