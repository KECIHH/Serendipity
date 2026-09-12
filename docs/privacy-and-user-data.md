# 隐私与用户数据规范

本文件是 Phase002 首产的隐私、最小化与删除契约，owner 为本文件。API exact DTO、认证、密钥持久化和运行拓扑分别由 [API](api.md)、[认证规范](auth.md)、[加密规范](crypto.md)、[托管规范](hosting.md) 负责；数据库模型与不可变性由 [数据库规范](database.md) 定义。需求 consent 字段仅由 [旅行 Schema](travel-plan-schema.md) 定义，Prompt 与事实外发还须满足 [Prompt](prompt-design.md) 和 [Provider](travel-data-provider-strategy.md) 边界。

PrivacyDecisionRegister 只对当前 run 的 ISOLATED_SYNTHETIC 数据有效；automatedDecision 是执行规则得出的本地决定，不代表真人 consent、生产保留政策或法律审批。真实用户研究、真人读屏体验与生产政策均为 NOT_EVALUATED。Phase002 证据只执行文档规则、注入时钟和临时文件清理，没有创建账号/数据库/真实 Provider 请求；后续产品实现和隔离验证按各自 Phase 归档，不由这些规则模拟器代替。

## 来源与责任

路线包输入的规范化绝对路径和 SHA-256 存在规则块 sources，并与 [Phase002 输入清单](phase-plans/Phase002-inputs.json) 校验一致；本地路线正文不进入仓库。权威顺序遵循 [执行契约](agent-execution-contract.md)。Phase008–013 首产匿名/身份/秘密与审计；082 消费匿名合并；084 首产 profile、DataRequest、独立 PrivacyRevocationLedger 和个人删除 worker；085/088/095/096/106 随模型生产注册 archive/erase hooks；101–106 消费导出与公开投影；123 用同一 ruleVersion 核验实际清理，126 验证恢复重放，127–137 消费去标识、同意与隔离证据。未到阶段不创建对应模型或占位业务实现。

## 分类、收集目的与有界规则

默认 private、默认拒绝未知字段；只收集完成用户明确动作所需数据。身份证/护照/支付资料、精确健康诊断和真人生产数据列入禁止收集清单，不属于获准数据类别，命中即零写入。每类存储字段白名单在机器块 categories，保留/删除/备份/同意规则在下方 exact register。姓名、邮箱等只在相应已授权本人/管理操作显示，不能因管理员身份取得任意私有旅行正文。账号数据导出只允许用户本人的资料、聊天、需求/计划、来源说明及同意记录，排除密码/hash、token/hash、密钥、内部 Prompt、审计与他人数据。账号数据导出和行程 PDF/Markdown 是不同产物。

| 数据类别 | 目的与范围 | 隔离合成保留上限 | 到期动作 |
|---|---|---|---|
| account | 账户识别、登录和 owner 授权 | 2592000 秒 | ERASE_SUBJECT |
| anonymous_token | 临时记录归属与一次性匿名合并 | 86400 秒 | ERASE_SUBJECT |
| password | 仅凭据验证；原文只存在录入/重新认证请求边界 | 2592000 秒 | ERASE_SUBJECT |
| api_key | 受控 Provider 鉴权；禁止读取明文 | 2592000 秒 | REVOKE_AND_PURGE |
| auth_session | 可撤销登录会话及安全检查 | 604800 秒 | REVOKE_AND_PURGE |
| chat_and_requirement | 理解需求、追问、展示本人历史 | 2592000 秒 | ERASE_SUBJECT |
| travel_profile | 显式保存并采用旅行偏好/必要行动限制 | 2592000 秒 | ERASE_SUBJECT |
| location | 用户行程地点与公共 POI 证据；私人坐标不得外发当前公共 Provider/底图 | 2592000 秒 | ERASE_SUBJECT |
| travel_plan_and_snapshot | 正式版本、可复现上下文和本人历史 | 2592000 秒 | ERASE_SUBJECT |
| plan_trace | 版本/attempt 最小可追溯记录 | 2592000 秒 | ERASE_SUBJECT |
| trace_detail | 有界脱敏故障诊断和低基数指标 | 86400 秒 | PURGE_CATEGORY |
| audit_and_command_receipt | 必要审计、幂等与无正文删除证明 | 转为 tombstone 后 691200 秒 | PURGE_AFTER_RESTORE_RETIREMENT |
| share_token | 固定确认版本的只读授权；只存 hash | 604800 秒 | REVOKE_AND_PURGE |
| data_and_feedback_receipt | 独立定位最小状态与反馈同意；不是下载能力 | 转为 tombstone 后 691200 秒 | PURGE_AFTER_RESTORE_RETIREMENT |
| export_temporary_file | 有界账号数据/PDF/Markdown 交付；临时产物私有 | 3600 秒 | PURGE_CATEGORY |
| evaluation_sample | 仅明确同意的合成反馈回归候选，授权/来源/独立复核另查 | 604800 秒 | PURGE_CATEGORY |
| feedback_contact | 仅登录提交者自己明确授权的规范邮箱；guest 禁止 | 604800 秒 | PURGE_CATEGORY |
| media_attachment | 受控用途附件与有许可的地点媒体 | 2592000 秒 | ERASE_SUBJECT |
| backup | 隔离恢复应用和对象；与独立账本分开 | 604800 秒 | RETIRE_BACKUP |
| privacy_revocation_ledger | 恢复时不可回退的删除/撤权意图；不存个人正文 | 转为 tombstone 后 691200 秒 | PURGE_AFTER_RESTORE_RETIREMENT |

普通数据上限从 createdAt 起按注入 UTC 计算，now>=deadline 即失效；回执/删除账本的8天期限仅从专用清理写入 tombstonedAt 起算，活动命令和仍与现存聚合绑定的回执不受创建时间 TTL 清理。清理完成上限为 3600 秒，备份通常最多 7 天，删除意图相关备份最迟 24 小时销毁或使相应内容不可恢复。所有数字都是本地合成测试配置，不能推广为生产政策。30 天的计划/账户上限触发专用 ERASE，连同关联正文/快照/最小 trace 清理；普通缓存或详细日志 TTL 不能删除已被正式版本引用的上下文。

审计/命令回执、数据/反馈回执及独立删除意图遵循 manifest.apiPolicy：activeOperationNeverExpires=true，domainReceiptsRetainedWithAggregate=true。活动命令、RUNNING ERASE、仍存在的关联聚合所需的幂等定位、回执 hash、checkpoint 和最小删除意图持续保留；不能因为创建超过8天就破坏重放、撤回同意或已注销主体的恢复能力。

只有操作已终结、关联聚合已删除且领域专用清理已完成，才写入一次 tombstonedAt，转为不含个人正文的最小 tombstone，并开始最多8天的保留计时。清除还必须证明所有能复活被删数据的恢复集合已经退休/应用当前水位；缺少生命周期或到期后仍无法证明保护解除时阻断本地使用与 readiness，继续保留恢复意图并告警，不能先删水位来满足 TTL。活动 ERASE 跨过该时间仍以原 intent/receipt/checkpoint 续接，不要求已失效会话或再次密码授权。仍有合法治理引用的 key 先撤销使用，历史版本元数据保持不可变，专用清理只移除不再需要的秘密/个人正文。普通任务完成不自动清未消费覆盖、待确认或未完成 ERASE 的受控 payload；它们由领域清理完成后解除 pin。

## 公开字段与嵌套值

Phase065 的唯一 PlanViewModelSchema 按 access=owner/share/public 判别。本文是递归披露白名单，不生产第二份公共 Schema；share/public 同一最大范围，publication 不能更宽。允许根节点与叶字段规则在 publicProjection，未知字段删除；输出仍须通过同一 Schema 的 access 分支和完整引用/geometry 校验。

| 可公开内容 | 必须递归执行的限制 |
|---|---|
| planVersion | 只保留 id/version/schemaVersion/generatedAt/finalizedAt；不含 owner、内部 CAS/revision |
| summary、assumptions、finalSummary、notes 与各种提醒/理由 | 使用可信公共结构化字段与模板重建；不直接复制用户/AI 原文，不以 publicSafe=true 批准自由文案 |
| 日程/交通/推荐/地图 | stable ref 与顺序保留；私人 PlaceView 为 redacted，label/address/coordinate=null，相关 geometry 降 sequence_only |
| 预算/天气/行李/风险/备选/质量/freshness | 保留验证后的展示值与通用限制；排除原始预算、健康/证件/同行人身份、内部调试、可执行 planPatch/requestedChange 与确认 token |
| sourceCatalog | 仅 exact SourceSummary 字段；删除 sourceLocator/contentHash/endpoint/config，URL 不安全或不存在时置 null，保留安全标题/机构/许可/时间 |

敏感限制同样适用于风险 code、target 路径、备选标题、attribution 和 SourceSummary 的值。白名单字段中夹带私人字符串/签名 URL 仍拒绝；sourceLocator+contentHash 可以满足内部 SourceReference 证据，但不授予公开权限。不能删除被引用的私人节点，也不能伪造粗化坐标。外部底图即使 owner 访问也只按公共可信 POI 计算 center/fitBounds/pan/瓦片范围；只有私人节点时瓦片请求为 0，保留文字行程。

## 秘密、回执与日志

匿名值由服务端 CSPRNG 生成 256-bit，anon_token 为 HttpOnly/Secure/SameSite=Lax Cookie；bootstrap 不创建业务记录、不在 JSON 返回原文。服务端只在验证边界短暂接触 Cookie，数据库只存 anonTokenHash；TravelRecord.userId 与 anonTokenHash 恰一非空。082 合并按 hash 一次消费，保留匿名 alias/tombstone，不改历史 requestHash，不让旧 token 再读写或合并另一账号。会话 token 也只存 hash；每次验证 AuthSession、User 状态/角色/sessionVersion/期限，退出先撤数据库行再清 Cookie。密码仅输入边界出现，bcrypt cost 12、UTF-8 12–72 bytes、不 trim 或静默截断，详细规则由 auth 拥有；API key 使用版本化 AES-256-GCM envelope，不明文读回。

DATA_RECEIPT/FEEDBACK_RECEIPT 在客户端创建请求前由 Web Crypto 生成 256-bit，只通过 X-Data-Request-Receipt/X-Feedback-Receipt 敏感头发送，服务端仅存 receiptHash 并参与规范化 requestHash。同键同 payload/receipt 重放原结果；异 receipt/payload 返回 409 且零写入。服务器不生成或回传 receipt 秘密。数据回执只读 id/type/status/completedAt/errorCategory；反馈回执只管理自身 id/status/revision/consents/安全回复。注销/撤回 share 后仍可凭独立回执查询/撤回自身同意，不能下载数据、读取计划、修改业务或分诊。固定 receipt 路由先于动态 ID；产品 exact 路径/字段见 API，不在这里再维护端点表。

分享 token 是另一协议：服务端创建/显式 reissue 时首次一次性交付，持久层/幂等收据只存 tokenHash。重放同 grant 返回 tokenAvailable=false 且省略 token；显式新键换发在同事务撤旧建新，保持目标版本和原 expiresAt。只有首次响应与规定 share/public 读取路径携带 token，入口在日志前裁剪路径；随后导出/反馈仅经 X-Share-Token。分享不自动公开发布，不因换发延长有效期，公开无效/越权/撤销/过期/停用统一 404 NOT_FOUND。

日志在首边界剥离敏感 header，再递归白名单输出机器块 logging 允许的安全标识/枚举/有界数字。denylist 禁止密码、hash/envelope/原始秘密、Cookie、token/receipt、完整 Prompt/rawOutput/rawResponse/query、聊天/私人文本、邮箱/电话/地址/坐标；即使放在深层未知字段或伪装安全 message 也不记录。普通日志不保留任意自由文本；原始调试数据的受控持久化必须按自身类别授权/期限，不能借日志旁路。指标标签低基数，不含 URL、地点名、userId 或敏感查询。

### Phase010 秘密存储与 seed 来源

ApiKeyConfig 只保存 exact AES-256-GCM envelope、完整 keyFingerprint、主密钥标识及生命周期字段；格式、JCS、AAD 与不可变列由 [加密契约](crypto.md#phase010-存储实现与消费边界) 统一定义。完整 fingerprint 仅用于服务端去重/追溯，管理展示短值运行时派生；明文、完整 fingerprint、encryptedKey/envelope 和 encryptionKeyId 不进入用户/ADMIN 响应、普通日志、trace 或 Gate evidence。`secretRef` 将是现有 `ApiKeyConfig.id`，不能借引用建立第二份凭据存储。撤销限制新调用，不等于已经实现历史秘密的保留清理；相应维护能力仍按其生产阶段交付。

Phase010 基础 seed 只创建本次隔离 run 的合成管理员与三项内部非秘密 SystemConfig。ADMIN_INITIAL_PASSWORD 只从 CLI 命令环境读取，CSPRNG 生成值仅在被忽略的受控本地准备区保留；数据库只收到 bcryptjs cost12 hash。缺变量或校验失败不回显邮箱、密码或 URL。seed 不读取、生成或复制 Provider 凭据，不创建 ApiKeyConfig 行，也不提前生产 Phase015 的治理表或数据。

管理员创建与 `SEED_ADMIN_CREATE`、配置创建与 `SEED_CONFIG_CREATE` 均同事务；使用既有 SYSTEM/MIGRATION 主体，actorId/actorEmailSnapshot 均为 null。审计只增加受限 `sourceMarker/seedRunId/seedFingerprint` 及安全计数/结果：固定来源为 PHASE010_BASE_SEED_V1，seedRunId 是可稳定重读的非秘密 disposable-run 标识；seedFingerprint 对已落库管理员行的指定字段（包含加盐 bcrypt hash）连同来源取 JCS SHA-256，精确字段见 [数据库规范](database.md#seed-执行规则)。不直接 hash 明文密码，不将管理员邮箱、bcrypt hash 或指纹输入对象放进 detailJson；普通日志和证据也不输出该行指纹值。

重放同时验证来源、当前行指纹、ADMIN/ACTIVE 和 bcrypt 密码；仅全部匹配才零写入返回。已有普通用户、停用管理员、来源缺失或修改后的凭据/配置均拒绝，seed 不承担提权、启用、重置口令或恢复生产账户的职责。重复 seed 也不追加独立 run 审计。验收在归档 stdout/stderr 前扫描实际原始输出，证据只记录退出码、安全分类、计数与文件 hash；密文虽已加密仍不得作为 fixture 内容复制到 evidence。保留/ERASE 继续遵循本文件既有类别规则，不由 seed 扩大用途或期限。

### Phase012 用户管理最小披露与账本

用户管理列表、成功更新、终态重放及版本冲突只通过 ADMIN_USER_FIELDS 选择九个字段：id/email/name/avatarUrl/role/status/lastLoginAt/createdAt/revision。它们只对当下授权的管理员显示，不能用于公开投影；passwordHash、sessionVersion、phone 和完整 User 均不进入管理 DTO。后台顶部仅接收已认证管理员的 id/email，不附带凭据或其他身份资料。签名游标绑定当前 owner/filter/order/watermark，不构成独立授权凭据。

用户提交的 reason 先校验、trim，规范化内容只参与非秘密 requestHash；AdminCommandReceipt 不保存该正文。USER_UPDATE 的 detailJson 只留下 before/after 的角色、状态、revision、`sessionVersionIncremented` 布尔及受控结果/原因码，reason 全文通过既有脱敏器替换为 `***`，不能将自由文案借审计落库。可信 actorEmailSnapshot 仍遵循下述独立审计追溯边界，不复制到 detailJson、普通日志或阶段证据。

AdminCommandReceipt 仅持久化幂等键 hash、请求 hash、当前领域安全结果和受控执行元数据。重放必须重新授权，历史结果不让被降权/停用或已撤销会话继续读取。活跃记录不按 TTL 删除；终态以数据库完成时刻至少保留24小时，不可倒填时间缩短期限。KeyRotationRun 只存既有 key ID、受控 revision/hash/checkpoint，当前 candidateIdsJson 为 `[]`；不存明文 key、envelope、任意候选正文或外部原始响应。密钥审计到期清理协议尚未生产，当前轮换 run 禁止删除并以 Restrict FK 保留相关收据与密钥引用，不能因终态24小时已过拆除引用链。

Phase012 验收使用任务专属的隔离 PostgreSQL 与合成身份，随机凭据和 canary 仅存被忽略的本地准备区。归档 stdout/stderr、浏览器 DOM/截图和报告前扫描秘密；证据只保留安全计数、版本差异、状态、命令退出码与文件 hash。界面展示的合成示例邮箱不代表真实用户。上述新增持久化边界不声明已实现个人 ERASE、生产保留清理或 Phase016 worker。

## 删除、归档与恢复

Phase011认证审计新增 LOGIN_SUCCESS、LOGIN_FAILURE、LOGIN_THROTTLED、SESSION_LOGOUT，使用SYSTEM/MAINTENANCE主体；登录失败没有User FK/邮箱快照或原IP。detail只允许已登记的结果/原因枚举、audience、scope以及64位小写HMAC的ipHash/accountHash。成功目标可定位已验证User，退出目标可定位AuthSession；密码、opaque token、JWE/Cookie和邮箱/地址原文均不进入认证审计detail、普通日志或证据。限流计数独立于AuditLog，只由AuthLoginAttempt承担。原审计事务来源、异步等待、失败回滚与append-only限制继续生效。

### Phase009 审计落库边界

AuditLog 是同事务的只追加安全摘要，独立于普通日志输出。actorEmailSnapshot 仅来自可信已认证 actor 的 normalizeEmailV1 规范邮箱，限254字符，后台受权追溯使用；主体删除后 FK 可为空而快照仍保留，后续 ERASE/retention 专用程序承担去标识责任，应用角色不能自行改写或删除历史。当前不把这项未来维护责任当作已实现。

递归 denylist 统一 NFKC、大小写和分隔符，覆盖 password/passwordHash/secret/apiKey/encryptedKey/authorization/cookie/token/anonToken/shareToken/promptContent/DATABASE_URL，并包含上述 logging 敏感头、envelope、receipt、原始响应、聊天及联系方式等限制。仅允许 NFKC/大小写和 ASCII 点、空格、下划线、连字符变体的已登记完整敏感键名，动态后缀/未知字符拒绝以防字段名携带私文；命中键值替换为 `***`；仍先检查完整输入大小、深度和 JSON 合法性。其余字段仅允许 [Phase009 摘要字段](phase009.md) 中的枚举、有界数字、布尔、字段名和递归容器；未知 key、自由文本和原始配置正文拒绝。输入与脱敏输出限16KiB/8层/1024节点，拒绝超限而不截掉审计事实。

请求上下文由服务端 CSPRNG 生成并保持不可变，不接受客户端 requestId/traceId；网络地址仅经注入的32-byte server HMAC key及 audit/ip/v1 域分离输出64位小写 HMAC-SHA256。原始地址与 HMAC key 不进入审计参数或错误。UA 去控制字符后按码点限制256，最多接收4096个 UTF-16 单元。数据库/验证异常只暴露固定错误码和安全模板；测试和证据扫描要求敏感 canary 明文命中0。

首次 ERASE 先用当前密码重新认证，在主体/session/revision 锁下向独立 PrivacyRevocationLedger 可靠 append 不可撤销意图，然后在应用库投影同一 DataRequest、禁止该主体新增业务、递增 sessionVersion 并撤会话。ledger 使用独立 PostgreSQL database/卷/备份集；受锁 head 与 entry 同事务保证连续水位，不用裸 sequence 跳号证明完整性。ledger 仅存 intentId/scopeHash/requestId/requestHash/receiptHash/ownerKeyHash 与最小受控定位，禁止原密码、回执、个人正文。

跨库不宣称原子。ledger 失败不能确认接受；ledger 成功、本库或响应失败时按原意图/receipt 对账补齐同一请求，独立意图已阻断主体继续写入。ERASE 技术失败保持 RUNNING；单个 DurableTask 重试耗尽可 FAILED，协调器以 revision/continuationSequence CAS 创建至多一个后继 task，继承意图/范围/checkpoint/水位和 fencing，不重开旧任务，不要求已失效会话、密码或第二份授权，不允许取消删除。EXPORT 可 FAILED，新请求仍须活动 owner。

专用擦除角色处理账户身份、聊天/需求/profile、计划/工作区/事实快照中的私人正文、派生缓存、文件、评测副本和本地准备状态；普通版本不可变规则继续有效。保留的 User 壳只能 DISABLED，身份凭据为空，不能 ADMIN enable 复活。对象删除按 tombstone+拒读→outbox→不可变 key/hash 幂等删除→确认不存在执行；任何待对账对象都不能令 ERASE=COMPLETED。只清目标主体所属或必须去标识内容，不级联删除其他用户独立合法副本。

归档保留私有历史、不可恢复，同事务取消活动 run 并撤销当前已存在的 ShareGrant/PlanPublication，绝不等价 ERASE。未来对象由首次生产阶段注册 hooks，不能提前造表。share/media/export 每次读取检查水位；分享和导出 no-store/no-referrer。PDF/Markdown 在发送首字节前通过跨实例授权 fence 重新检查 session/grant、确认/readiness、kill、水位与 AssetUsage/rights；已下载字节不声称能够召回。

恢复应用/对象备份时先停流，读取独立当前水位，完整重放 ERASE、CONSENT_WITHDRAWAL、SESSION_REVOKE、SHARE_REVOKE、PUBLICATION_REVOKE、MEDIA_REVOKE、KILL_DISABLE，再追平新增水位、确认正文/对象未复活后开放。水位缺失、回退、hook 缺失或对象未对账时 readiness=false；只换 token 不能替代删除正文和撤权重放。

## 同意与评测链

preferences.consent.sensitiveRequirementProcessing=false/null 不允许向模型/外部 Provider 发送健康/无障碍敏感原文；true 必须来自明确产品动作，不能由 AI、默认值、开发 Agent 自动推进产生。结构化最低行动限制也须检查实际授权。字段 clear 按撤回处理，新计划不能读取被清空旧值；profile UNAVAILABLE 不得作为 ABSENT 使用默认值丢掉硬限制，旧版本不自动随档案变更改写。

反馈 contactConsent/evaluationConsent 独立且默认 false。联系字段仅来自登录提交者明确授权的自身规范邮箱，guest=true 拒绝，不从 description 或分享 owner 推断。撤回先写独立 CONSENT_WITHDRAWAL，立即拒绝新使用，再对账新 consentRevision、清联系字段/待评测候选/可识别副本和水位；反馈回执在 share 撤销后仍只控制自己的同意。每次采样/回放核验 feedbackId、consentRevision、privacyWatermark 和当前 consent；撤回后旧 dataset manifest 保持历史字节，但其成员失去可用资格，不能继续采样。用户 claim 不能直接成为 verified Fact 或黄金事实；来源与独立 Agent 复核另行验证。

## 可执行规则与 PrivacyDecisionRegister

所有顶层条目 exact 只有 decisionId/dataCategory/environment/automatedDecision/ruleVersion/evaluatedAt/runnerRef/retentionRule/deletionRule/backupDeadline/consentRule 共 11 字段；不添加 owner、姓名、approvedAt 等虚构审批。evaluatedAt 是固定注入时钟下的规则评估基准，runnerRef 指向实际文档规则运行器，不是人工批准。Phase123 按相同 ruleVersion 消费并记录自己的实际执行时间；缺类别/字段/版本、BLOCK 或实际清理失败都返回 BLOCKED_DECISION 并保持未完成。

<!-- contract:privacy-policy -->
```json
{
  "contractVersion": "phase002.privacy.v1",
  "owner": "docs/privacy-and-user-data.md",
  "producerPhase": 2,
  "implementationStatus": "NOT_CREATED",
  "ruleVersion": "phase002.synthetic-retention.v1",
  "environment": "ISOLATED_SYNTHETIC",
  "productionPolicy": "NOT_EVALUATED",
  "realUserConsent": "NOT_EVALUATED",
  "humanScreenReaderExperience": "NOT_EVALUATED",
  "sources": [
    {
      "id": "manifest",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/docs/roadmap-execution-manifest.json",
      "sha256": "497689843e4576c5f8e8a6636d29b04023ac997309a3ffab83cc67d90ea7bf3e"
    },
    {
      "id": "product-requirements",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/docs/product-requirements.md",
      "sha256": "320583e7baa5c0b3ee15b13ce0bc4f264e8ff1ae531feb94eb71e1102040854b"
    },
    {
      "id": "canonical-contract",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/docs/roadmap-canonical-contract.md",
      "sha256": "06d0ccdb218482a5688d78a9f69a88a0183cedc9d5eac5d0553e224b8d6e27e5"
    },
    {
      "id": "terminology",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/docs/术语冻结表.md",
      "sha256": "403f21a6063aac79a3a93554156b06d9aff9277e6267c8f9ec17109cff4aff9f"
    },
    {
      "id": "state-machines",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/docs/state-machines.md",
      "sha256": "3dab632bd549b26908312b09b166947b2a26128a0298749ba1c7efc6d3d6717a"
    },
    {
      "id": "testing-strategy",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/docs/testing-strategy.md",
      "sha256": "36d90b927e90916a3dcfd0105022884c8f3c64cb04e22996da4cb4299acc93a5"
    },
    {
      "id": "phase-card",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/Phase002.md",
      "sha256": "4a7a80ea2cf1ccc4ca02406bc892e4e72c15ec20ca2758718332dd08858f9304"
    },
    {
      "id": "Phase084",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/Phase084.md",
      "sha256": "48af27082c237dd30ed8bd388ea71e8236acc20107fa9d24f01004367e56e08c"
    },
    {
      "id": "Phase088",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/Phase088.md",
      "sha256": "0b8a7322f254ba613cdb0ca324a5a413eaf34a446f96d020e383e36e2f93afdf"
    },
    {
      "id": "Phase095",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/Phase095.md",
      "sha256": "22ffd5535ce57c42cd7cce507c74ea813eb521cef7fb5b5d8c2a3a150178aa04"
    },
    {
      "id": "Phase096",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/Phase096.md",
      "sha256": "0e79439da9bb34743e8a54e35d25943dc17444998b4fb1523e7cdad539b46629"
    },
    {
      "id": "Phase104",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/Phase104.md",
      "sha256": "1f387c9e08d14bf624fb63200ae78b0a245c5c32863d018882a784503ff16995"
    },
    {
      "id": "Phase105",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/Phase105.md",
      "sha256": "91be234854fe407be9a9763f4f0e5b06a7d8171818d51b4f443aea5c0e663bef"
    },
    {
      "id": "Phase106",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/Phase106.md",
      "sha256": "75018ff641b6ecce57a64ec07fee06e080af012c17f0ff4e626b40c5211f88a6"
    },
    {
      "id": "Phase123",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/Phase123.md",
      "sha256": "242ab8bdbe4092d70ab7e5ea0610240a925e608e7bdaa9bac45a38c372f889aa"
    },
    {
      "id": "Phase126",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/Phase126.md",
      "sha256": "26e705a020f356b9414d8b5c7e20d52f31c3dba3c7fe7e418f1eba3363499c6d"
    },
    {
      "id": "Phase137",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/Phase137.md",
      "sha256": "9f669165a0c76f18ed3e10af9d7909fff413846f19ffe841443085c6e321de5a"
    }
  ],
  "categories": [
    {
      "dataCategory": "account",
      "purpose": "账户识别、登录和 owner 授权",
      "fieldWhitelist": [
        "id",
        "email",
        "name",
        "avatarUrl",
        "role",
        "status",
        "revision",
        "sessionVersion"
      ]
    },
    {
      "dataCategory": "anonymous_token",
      "purpose": "临时记录归属与一次性匿名合并",
      "fieldWhitelist": [
        "anonTokenHash",
        "expiresAt",
        "consumedAt"
      ]
    },
    {
      "dataCategory": "password",
      "purpose": "仅凭据验证；原文只存在录入/重新认证请求边界",
      "fieldWhitelist": [
        "passwordHash"
      ]
    },
    {
      "dataCategory": "api_key",
      "purpose": "受控 Provider 鉴权；禁止读取明文",
      "fieldWhitelist": [
        "envelope",
        "keyFingerprint",
        "status",
        "secretRef"
      ]
    },
    {
      "dataCategory": "auth_session",
      "purpose": "可撤销登录会话及安全检查",
      "fieldWhitelist": [
        "tokenHash",
        "userId",
        "status",
        "expiresAt",
        "sessionVersion"
      ]
    },
    {
      "dataCategory": "chat_and_requirement",
      "purpose": "理解需求、追问、展示本人历史",
      "fieldWhitelist": [
        "messageId",
        "content",
        "requirementJson",
        "requirementRevision",
        "fieldSources"
      ]
    },
    {
      "dataCategory": "travel_profile",
      "purpose": "显式保存并采用旅行偏好/必要行动限制",
      "fieldWhitelist": [
        "profileVersion",
        "pace",
        "interests",
        "dietaryRestrictions",
        "accessibilityNeeds",
        "consent"
      ]
    },
    {
      "dataCategory": "location",
      "purpose": "用户行程地点与公共 POI 证据；私人坐标不得外发当前公共 Provider/底图",
      "fieldWhitelist": [
        "placeRef",
        "position",
        "address",
        "precision",
        "sourceRefs"
      ]
    },
    {
      "dataCategory": "travel_plan_and_snapshot",
      "purpose": "正式版本、可复现上下文和本人历史",
      "fieldWhitelist": [
        "planVersionId",
        "planJson",
        "requirementSnapshot",
        "factSnapshot",
        "workspaceSnapshot",
        "qualityReport"
      ]
    },
    {
      "dataCategory": "plan_trace",
      "purpose": "版本/attempt 最小可追溯记录",
      "fieldWhitelist": [
        "traceId",
        "attemptId",
        "plannerRunId",
        "planVersionId",
        "status",
        "versionReferences"
      ]
    },
    {
      "dataCategory": "trace_detail",
      "purpose": "有界脱敏故障诊断和低基数指标",
      "fieldWhitelist": [
        "eventId",
        "traceId",
        "sequence",
        "stage",
        "durationMs",
        "errorCategory",
        "typedMetrics"
      ]
    },
    {
      "dataCategory": "audit_and_command_receipt",
      "purpose": "必要审计、幂等与无正文删除证明",
      "fieldWhitelist": [
        "action",
        "actorType",
        "targetHash",
        "requestHash",
        "result",
        "safeVersionDiff",
        "completedAt"
      ]
    },
    {
      "dataCategory": "share_token",
      "purpose": "固定确认版本的只读授权；只存 hash",
      "fieldWhitelist": [
        "tokenHash",
        "planVersionId",
        "revision",
        "status",
        "expiresAt",
        "revokedAt"
      ]
    },
    {
      "dataCategory": "data_and_feedback_receipt",
      "purpose": "独立定位最小状态与反馈同意；不是下载能力",
      "fieldWhitelist": [
        "receiptHash",
        "requestHash",
        "ownerKeyHash",
        "requestId",
        "feedbackId",
        "status",
        "consents"
      ]
    },
    {
      "dataCategory": "export_temporary_file",
      "purpose": "有界账号数据/PDF/Markdown 交付；临时产物私有",
      "fieldWhitelist": [
        "assetId",
        "dataRequestId",
        "ownerKeyHash",
        "contentHash",
        "expiresAt"
      ]
    },
    {
      "dataCategory": "evaluation_sample",
      "purpose": "仅明确同意的合成反馈回归候选，授权/来源/独立复核另查",
      "fieldWhitelist": [
        "feedbackId",
        "consentRevision",
        "privacyWatermark",
        "contentHash",
        "datasetMembershipRefs"
      ]
    },
    {
      "dataCategory": "feedback_contact",
      "purpose": "仅登录提交者自己明确授权的规范邮箱；guest 禁止",
      "fieldWhitelist": [
        "feedbackId",
        "email",
        "consentRevision"
      ]
    },
    {
      "dataCategory": "media_attachment",
      "purpose": "受控用途附件与有许可的地点媒体",
      "fieldWhitelist": [
        "assetId",
        "usageId",
        "ownerUserId",
        "purpose",
        "binding",
        "rightsStatus",
        "attributionText"
      ]
    },
    {
      "dataCategory": "backup",
      "purpose": "隔离恢复应用和对象；与独立账本分开",
      "fieldWhitelist": [
        "backupId",
        "createdAt",
        "expiresAt",
        "contentHash",
        "appliedWatermark",
        "encryptedObjectRefs"
      ]
    },
    {
      "dataCategory": "privacy_revocation_ledger",
      "purpose": "恢复时不可回退的删除/撤权意图；不存个人正文",
      "fieldWhitelist": [
        "intentId",
        "subjectHash",
        "requestId",
        "scopeHash",
        "sequence",
        "category",
        "schemaVersion",
        "createdAt",
        "minimalMetadata"
      ]
    }
  ],
  "classification": {
    "default": "PRIVATE",
    "unknownFields": "DENY",
    "adminImpliesPrivateAccess": false,
    "plaintextPasswordsPersisted": false,
    "plaintextTokensPersisted": false,
    "apiKeyStorage": "VERSIONED_AES_256_GCM_ENVELOPE",
    "anonStorageField": "anonTokenHash",
    "hashEncoding": "SHA256_LOWER_HEX_64",
    "ordinaryVersionMutationAllowed": false,
    "erasureDedicatedRoleException": true,
    "prohibitedDataCategories": [
      "identity_documents",
      "passport",
      "payment_credentials",
      "precise_health_diagnosis",
      "real_production_personal_data"
    ]
  },
  "publicProjection": {
    "schemaOwnerPhase": 65,
    "schemaName": "PlanViewModelSchema",
    "accessDiscriminator": [
      "owner",
      "share",
      "public"
    ],
    "shareAndPublicSameMaximum": true,
    "recursive": true,
    "unknownFields": "DROP",
    "topLevelAllowlist": [
      "planVersion",
      "summary",
      "assumptions",
      "dailyItinerary",
      "routePlan",
      "transportPlan",
      "accommodationRecommendations",
      "attractionRecommendations",
      "foodRecommendations",
      "photoGuide",
      "budgetAnalysis",
      "weatherAnalysis",
      "packingList",
      "riskAlerts",
      "pitfallGuide",
      "alternatives",
      "specialReminders",
      "emergencyAdvice",
      "returnAdvice",
      "finalSummary",
      "dataNotes",
      "qualitySummary",
      "freshnessSummary",
      "sourceCatalog",
      "mapView"
    ],
    "planVersionFields": [
      "id",
      "version",
      "schemaVersion",
      "generatedAt",
      "finalizedAt"
    ],
    "sourceSummaryFields": [
      "id",
      "provider",
      "sourceType",
      "title",
      "url",
      "organization",
      "license",
      "fetchedAt",
      "confidence",
      "validFrom",
      "validUntil"
    ],
    "placeFields": [
      "id",
      "disclosure",
      "label",
      "address",
      "coordinate"
    ],
    "redactedPlace": {
      "disclosure": "redacted",
      "label": null,
      "address": null,
      "coordinate": null
    },
    "assumptionFields": [
      "id",
      "label",
      "displayValue",
      "reason"
    ],
    "alternativeFields": [
      "id",
      "title",
      "description"
    ],
    "narrativeOrigin": "VERIFIED_PUBLIC_FIELDS_AND_TEMPLATE",
    "rawNarrativeCopyAllowed": false,
    "publicSafeBooleanSufficient": false,
    "sourceUrlSchemes": [
      "https:"
    ],
    "sourceUrlSensitiveQueryKeys": [
      "token",
      "key",
      "apikey",
      "api_key",
      "signature",
      "sig",
      "secret",
      "auth",
      "authorization",
      "credential",
      "expires",
      "x-amz-signature",
      "x-amz-credential"
    ],
    "internalSourceFields": [
      "sourceLocator",
      "contentHash",
      "endpoint",
      "config"
    ],
    "privateGeometry": "sequence_only",
    "keepPrivateStableReferences": true,
    "externalMapPrivateCoordinatesAllowed": false,
    "allPrivateMapRequestCount": 0,
    "denyKeys": [
      "userId",
      "ownerUserId",
      "email",
      "phone",
      "requirementSnapshot",
      "profileSnapshot",
      "planningContext",
      "planLocks",
      "chat",
      "messages",
      "traceId",
      "trace",
      "prompt",
      "systemPrompt",
      "secret",
      "password",
      "passwordHash",
      "apiKey",
      "token",
      "tokenHash",
      "anonToken",
      "anonTokenHash",
      "receipt",
      "receiptHash",
      "sourceLocator",
      "contentHash",
      "endpoint",
      "config",
      "ownerCapabilities",
      "planPatch",
      "requestedChange",
      "confirmationToken",
      "accessibilityNeeds",
      "dietaryRestrictions",
      "ageBands",
      "healthDiagnosis"
    ]
  },
  "logging": {
    "recursive": true,
    "unknownFields": "DROP",
    "sensitiveHeaders": [
      "Authorization",
      "Cookie",
      "Set-Cookie",
      "X-Share-Token",
      "X-Feedback-Receipt",
      "X-Data-Request-Receipt"
    ],
    "allowFields": [
      "requestId",
      "traceId",
      "attemptId",
      "eventId",
      "operationId",
      "providerId",
      "capability",
      "availability",
      "errorCategory",
      "latencyMs",
      "statusCode",
      "resultCount",
      "cacheState",
      "providerVersion",
      "policyVersion",
      "action",
      "actorType",
      "result"
    ],
    "denyKeys": [
      "password",
      "passwordHash",
      "apiKey",
      "envelope",
      "ciphertext",
      "Authorization",
      "Cookie",
      "Set-Cookie",
      "anon_token",
      "anonToken",
      "sessionToken",
      "token",
      "shareToken",
      "feedbackReceipt",
      "dataRequestReceipt",
      "receipt",
      "rawOutput",
      "rawResponse",
      "prompt",
      "systemPrompt",
      "query",
      "description",
      "email",
      "phone",
      "coordinate",
      "address",
      "chat",
      "messages",
      "privateText",
      "X-Share-Token",
      "X-Feedback-Receipt",
      "X-Data-Request-Receipt"
    ],
    "allowRawText": false,
    "stripAtFirstBoundary": true,
    "redactSharePathBeforeLogging": true,
    "metricHighCardinalityLabelsAllowed": false
  },
  "secretProtocols": {
    "anonymous": {
      "generator": "SERVER_CSPRNG_256_BIT",
      "delivery": "HTTPONLY_COOKIE_ONLY",
      "database": "anonTokenHash",
      "cookie": "anon_token",
      "flags": [
        "HttpOnly",
        "Secure",
        "SameSite=Lax"
      ],
      "bootstrapCreatesBusinessRecord": false,
      "bootstrapReturnsRawToken": false,
      "consumedTokenReusable": false
    },
    "session": {
      "generator": "SERVER_CSPRNG_256_BIT",
      "database": "tokenHash",
      "logoutOrder": [
        "REVOKE_DATABASE_SESSION",
        "CLEAR_COOKIE"
      ],
      "authRecheck": [
        "AuthSession.status",
        "AuthSession.expiresAt",
        "User.status",
        "User.role",
        "User.sessionVersion"
      ]
    },
    "receipt": {
      "generator": "CLIENT_WEB_CRYPTO_256_BIT_BEFORE_CREATE",
      "delivery": "SENSITIVE_HEADER_ONLY",
      "headers": [
        "X-Data-Request-Receipt",
        "X-Feedback-Receipt"
      ],
      "database": "receiptHash",
      "boundToRequestHash": true,
      "serverReturnsSecret": false,
      "dataCapabilities": [
        "MINIMAL_STATUS"
      ],
      "feedbackCapabilities": [
        "OWN_MINIMAL_STATUS",
        "OWN_CONSENT"
      ],
      "downloadAllowed": false,
      "planAccessAllowed": false,
      "triageAllowed": false,
      "validAfterShareRevocation": true,
      "validAfterSessionRevocation": true
    },
    "share": {
      "generator": "SERVER_CSPRNG_256_BIT",
      "database": "tokenHash",
      "firstDelivery": "CREATE_OR_EXPLICIT_REISSUE_RESPONSE_ONCE",
      "firstTokenAvailable": true,
      "replayTokenAvailable": false,
      "replayOmitsToken": true,
      "reissueRevokesOldGrant": true,
      "reissuePreservesPlanVersionAndExpiry": true,
      "followUpHeader": "X-Share-Token",
      "invalidPublicResponse": "404 NOT_FOUND",
      "shareImpliesPublication": false
    }
  },
  "deletion": {
    "ledger": "PrivacyRevocationLedger",
    "ledgerProducerPhase": 84,
    "ledgerStorage": "INDEPENDENT_POSTGRES_DATABASE_VOLUME_AND_BACKUP_SET",
    "independentFromApplicationRestore": true,
    "categories": [
      "ERASE",
      "CONSENT_WITHDRAWAL",
      "SESSION_REVOKE",
      "SHARE_REVOKE",
      "PUBLICATION_REVOKE",
      "MEDIA_REVOKE",
      "KILL_DISABLE"
    ],
    "acceptOrder": [
      "REAUTHENTICATE_AND_LOCK_SUBJECT",
      "APPEND_INDEPENDENT_LEDGER",
      "PROJECT_APPLICATION_REQUEST_AND_REVOKE",
      "RUN_IDEMPOTENT_ERASURE",
      "RECONCILE_OBJECTS_AND_WATERMARK",
      "COMPLETE"
    ],
    "ledgerUniqueKey": [
      "intentId",
      "scopeHash"
    ],
    "ledgerSequence": "LOCK_HEAD_AND_APPEND_IN_ONE_LEDGER_TRANSACTION",
    "ledgerContainsPlaintext": false,
    "applicationFailureAfterLedger": "RECONCILE_SAME_INTENT_AND_RECEIPT",
    "eraseReauthenticationOnContinuation": false,
    "eraseCancellable": false,
    "eraseTechnicalFailureState": "RUNNING",
    "eraseCompletedState": "COMPLETED",
    "exportFailureState": "FAILED",
    "maxActiveTasksPerRequest": 1,
    "continuationCas": [
      "revision",
      "continuationSequence"
    ],
    "continuationRetains": [
      "intentId",
      "scopeHash",
      "privacyWatermark",
      "checkpoint"
    ],
    "taskFencingRequired": true,
    "objectOrder": [
      "TOMBSTONE_AND_DENY_READ",
      "OUTBOX",
      "DELETE_BY_IMMUTABLE_KEY_AND_HASH",
      "CONFIRM_ABSENCE"
    ],
    "completeRequiresObjectReconciliation": true,
    "erasedUserState": "DISABLED",
    "erasedUserReenableAllowed": false,
    "archiveEqualsErasure": false,
    "archiveRevokesExistingShareAndPublication": true,
    "eraseHookFirstConsumers": [
      84,
      85,
      88,
      95,
      96,
      106
    ],
    "restoreOrder": [
      "STOP_TRAFFIC",
      "READ_CURRENT_INDEPENDENT_WATERMARK",
      "REPLAY_ALL_CATEGORIES_AND_OBJECT_DELETION",
      "CATCH_UP_NEW_WATERMARK",
      "VERIFY_NO_RESURRECTION",
      "READINESS_TRUE"
    ],
    "missingWatermarkReadiness": false,
    "replaceErasureWithTokenRotation": false,
    "deleteOthersIndependentCopies": false
  },
  "consent": {
    "sensitiveRequirementField": "preferences.consent.sensitiveRequirementProcessing",
    "falseOrNullAllowsExternalSensitiveText": false,
    "feedbackFields": [
      "contactConsent",
      "evaluationConsent"
    ],
    "defaultGranted": false,
    "guestContactAllowed": false,
    "contactSource": "SUBMITTERS_OWN_NORMALIZED_ACCOUNT_EMAIL",
    "inferFromDescriptionAllowed": false,
    "withdrawalOrder": [
      "APPEND_CONSENT_WITHDRAWAL_LEDGER",
      "DENY_NEW_USE",
      "PROJECT_CONSENT_REVISION",
      "REMOVE_CONTACT_AND_PENDING_SAMPLES",
      "PURGE_IDENTIFIABLE_DERIVATIVES",
      "RECONCILE_WATERMARK"
    ],
    "sampleRequiredBinding": [
      "feedbackId",
      "consentRevision",
      "privacyWatermark"
    ],
    "recheckBeforeEverySampleOrReplay": true,
    "historyManifestMutable": false,
    "claimIsVerifiedFact": false
  },
  "enforcement": {
    "clock": "INJECTED_UTC",
    "expiryComparison": "NOW_GREATER_THAN_OR_EQUAL_DEADLINE",
    "maxOrdinaryRetentionSeconds": 2592000,
    "maxCleanupSeconds": 3600,
    "maxBackupAgeSeconds": 604800,
    "maxBackupErasureSeconds": 86400,
    "blockedDecisionAction": "BLOCKED_DECISION",
    "unprovenPinOrDeletionAction": "BLOCK_AND_KEEP_RECOVERY_INTENT",
    "productionEnvironmentAllowed": false,
    "oldRuleVersionAllowed": false,
    "fixtureStores": "TEMPORARY_FILES_WITH_SEPARATE_LEDGER_AND_APPLICATION_DIRECTORIES",
    "maxLedgerTombstoneRetentionSeconds": 691200,
    "receiptRetention": {
      "categories": [
        "audit_and_command_receipt",
        "data_and_feedback_receipt",
        "privacy_revocation_ledger"
      ],
      "activeOperationNeverExpires": true,
      "domainReceiptsRetainedWithAggregate": true,
      "startsAt": "tombstonedAt",
      "tombstoneRequires": [
        "OPERATION_TERMINAL",
        "AGGREGATE_DELETED",
        "DOMAIN_CLEANUP_COMPLETE"
      ],
      "reauthorizeAcceptedErasure": false,
      "unknownLifecycle": "BLOCK_AND_KEEP_RECOVERY_INTENT"
    }
  }
}
```

<!-- contract:privacy-decision-register -->
```json
[
  {
    "decisionId": "privacy:account:v1",
    "dataCategory": "account",
    "environment": "ISOLATED_SYNTHETIC",
    "automatedDecision": "ALLOW",
    "ruleVersion": "phase002.synthetic-retention.v1",
    "evaluatedAt": "2026-09-09T00:00:00.000Z",
    "runnerRef": "docs/phase-plans/check-phase002-provider-privacy.mjs#checkPrivacy",
    "retentionRule": {
      "startsAt": "createdAt",
      "maxAgeSeconds": 2592000,
      "expiryAction": "ERASE_SUBJECT",
      "protectedBy": "NONE"
    },
    "deletionRule": {
      "triggerEvents": [
        "RETENTION_EXPIRED",
        "SUBJECT_ERASE"
      ],
      "scope": [
        "PRIMARY",
        "DERIVED",
        "CACHE",
        "CLIENT_STATE",
        "OBJECTS"
      ],
      "completeWithinSeconds": 3600,
      "preserveIndependentOtherOwners": true,
      "preserveOnlyMinimalTombstone": true
    },
    "backupDeadline": {
      "maxAgeSeconds": 604800,
      "eraseWithinSeconds": 86400,
      "restoreRequiresCurrentLedger": true
    },
    "consentRule": {
      "scopeFields": [],
      "defaultGranted": false,
      "withdrawalStopsUseImmediately": true,
      "withdrawalPurgesIdentifiableCopies": true,
      "requiresExplicitProductAction": false
    }
  },
  {
    "decisionId": "privacy:anonymous_token:v1",
    "dataCategory": "anonymous_token",
    "environment": "ISOLATED_SYNTHETIC",
    "automatedDecision": "ALLOW",
    "ruleVersion": "phase002.synthetic-retention.v1",
    "evaluatedAt": "2026-09-09T00:00:00.000Z",
    "runnerRef": "docs/phase-plans/check-phase002-provider-privacy.mjs#checkPrivacy",
    "retentionRule": {
      "startsAt": "createdAt",
      "maxAgeSeconds": 86400,
      "expiryAction": "ERASE_SUBJECT",
      "protectedBy": "NONE"
    },
    "deletionRule": {
      "triggerEvents": [
        "RETENTION_EXPIRED",
        "SUBJECT_ERASE"
      ],
      "scope": [
        "PRIMARY",
        "DERIVED",
        "CACHE",
        "CLIENT_STATE",
        "OBJECTS"
      ],
      "completeWithinSeconds": 3600,
      "preserveIndependentOtherOwners": true,
      "preserveOnlyMinimalTombstone": true
    },
    "backupDeadline": {
      "maxAgeSeconds": 604800,
      "eraseWithinSeconds": 86400,
      "restoreRequiresCurrentLedger": true
    },
    "consentRule": {
      "scopeFields": [],
      "defaultGranted": false,
      "withdrawalStopsUseImmediately": true,
      "withdrawalPurgesIdentifiableCopies": true,
      "requiresExplicitProductAction": false
    }
  },
  {
    "decisionId": "privacy:password:v1",
    "dataCategory": "password",
    "environment": "ISOLATED_SYNTHETIC",
    "automatedDecision": "ALLOW",
    "ruleVersion": "phase002.synthetic-retention.v1",
    "evaluatedAt": "2026-09-09T00:00:00.000Z",
    "runnerRef": "docs/phase-plans/check-phase002-provider-privacy.mjs#checkPrivacy",
    "retentionRule": {
      "startsAt": "createdAt",
      "maxAgeSeconds": 2592000,
      "expiryAction": "ERASE_SUBJECT",
      "protectedBy": "NONE"
    },
    "deletionRule": {
      "triggerEvents": [
        "RETENTION_EXPIRED",
        "SUBJECT_ERASE"
      ],
      "scope": [
        "PRIMARY",
        "DERIVED",
        "CACHE",
        "CLIENT_STATE",
        "OBJECTS"
      ],
      "completeWithinSeconds": 3600,
      "preserveIndependentOtherOwners": true,
      "preserveOnlyMinimalTombstone": true
    },
    "backupDeadline": {
      "maxAgeSeconds": 604800,
      "eraseWithinSeconds": 86400,
      "restoreRequiresCurrentLedger": true
    },
    "consentRule": {
      "scopeFields": [],
      "defaultGranted": false,
      "withdrawalStopsUseImmediately": true,
      "withdrawalPurgesIdentifiableCopies": true,
      "requiresExplicitProductAction": false
    }
  },
  {
    "decisionId": "privacy:api_key:v1",
    "dataCategory": "api_key",
    "environment": "ISOLATED_SYNTHETIC",
    "automatedDecision": "ALLOW",
    "ruleVersion": "phase002.synthetic-retention.v1",
    "evaluatedAt": "2026-09-09T00:00:00.000Z",
    "runnerRef": "docs/phase-plans/check-phase002-provider-privacy.mjs#checkPrivacy",
    "retentionRule": {
      "startsAt": "createdAt",
      "maxAgeSeconds": 2592000,
      "expiryAction": "REVOKE_AND_PURGE",
      "protectedBy": "GOVERNANCE_REFERENCE"
    },
    "deletionRule": {
      "triggerEvents": [
        "RETENTION_EXPIRED",
        "SUBJECT_ERASE"
      ],
      "scope": [
        "PRIMARY",
        "DERIVED",
        "CACHE",
        "CLIENT_STATE",
        "OBJECTS"
      ],
      "completeWithinSeconds": 3600,
      "preserveIndependentOtherOwners": true,
      "preserveOnlyMinimalTombstone": true
    },
    "backupDeadline": {
      "maxAgeSeconds": 604800,
      "eraseWithinSeconds": 86400,
      "restoreRequiresCurrentLedger": true
    },
    "consentRule": {
      "scopeFields": [],
      "defaultGranted": false,
      "withdrawalStopsUseImmediately": true,
      "withdrawalPurgesIdentifiableCopies": true,
      "requiresExplicitProductAction": false
    }
  },
  {
    "decisionId": "privacy:auth_session:v1",
    "dataCategory": "auth_session",
    "environment": "ISOLATED_SYNTHETIC",
    "automatedDecision": "ALLOW",
    "ruleVersion": "phase002.synthetic-retention.v1",
    "evaluatedAt": "2026-09-09T00:00:00.000Z",
    "runnerRef": "docs/phase-plans/check-phase002-provider-privacy.mjs#checkPrivacy",
    "retentionRule": {
      "startsAt": "createdAt",
      "maxAgeSeconds": 604800,
      "expiryAction": "REVOKE_AND_PURGE",
      "protectedBy": "NONE"
    },
    "deletionRule": {
      "triggerEvents": [
        "RETENTION_EXPIRED",
        "SUBJECT_ERASE"
      ],
      "scope": [
        "PRIMARY",
        "DERIVED",
        "CACHE",
        "CLIENT_STATE",
        "OBJECTS"
      ],
      "completeWithinSeconds": 3600,
      "preserveIndependentOtherOwners": true,
      "preserveOnlyMinimalTombstone": true
    },
    "backupDeadline": {
      "maxAgeSeconds": 604800,
      "eraseWithinSeconds": 86400,
      "restoreRequiresCurrentLedger": true
    },
    "consentRule": {
      "scopeFields": [],
      "defaultGranted": false,
      "withdrawalStopsUseImmediately": true,
      "withdrawalPurgesIdentifiableCopies": true,
      "requiresExplicitProductAction": false
    }
  },
  {
    "decisionId": "privacy:chat_and_requirement:v1",
    "dataCategory": "chat_and_requirement",
    "environment": "ISOLATED_SYNTHETIC",
    "automatedDecision": "ALLOW",
    "ruleVersion": "phase002.synthetic-retention.v1",
    "evaluatedAt": "2026-09-09T00:00:00.000Z",
    "runnerRef": "docs/phase-plans/check-phase002-provider-privacy.mjs#checkPrivacy",
    "retentionRule": {
      "startsAt": "createdAt",
      "maxAgeSeconds": 2592000,
      "expiryAction": "ERASE_SUBJECT",
      "protectedBy": "PLAN_VERSION"
    },
    "deletionRule": {
      "triggerEvents": [
        "RETENTION_EXPIRED",
        "SUBJECT_ERASE",
        "CONSENT_WITHDRAWAL"
      ],
      "scope": [
        "PRIMARY",
        "DERIVED",
        "CACHE",
        "CLIENT_STATE",
        "OBJECTS"
      ],
      "completeWithinSeconds": 3600,
      "preserveIndependentOtherOwners": true,
      "preserveOnlyMinimalTombstone": true
    },
    "backupDeadline": {
      "maxAgeSeconds": 604800,
      "eraseWithinSeconds": 86400,
      "restoreRequiresCurrentLedger": true
    },
    "consentRule": {
      "scopeFields": [
        "preferences.consent.sensitiveRequirementProcessing"
      ],
      "defaultGranted": false,
      "withdrawalStopsUseImmediately": true,
      "withdrawalPurgesIdentifiableCopies": true,
      "requiresExplicitProductAction": true
    }
  },
  {
    "decisionId": "privacy:travel_profile:v1",
    "dataCategory": "travel_profile",
    "environment": "ISOLATED_SYNTHETIC",
    "automatedDecision": "ALLOW",
    "ruleVersion": "phase002.synthetic-retention.v1",
    "evaluatedAt": "2026-09-09T00:00:00.000Z",
    "runnerRef": "docs/phase-plans/check-phase002-provider-privacy.mjs#checkPrivacy",
    "retentionRule": {
      "startsAt": "createdAt",
      "maxAgeSeconds": 2592000,
      "expiryAction": "ERASE_SUBJECT",
      "protectedBy": "PLAN_VERSION"
    },
    "deletionRule": {
      "triggerEvents": [
        "RETENTION_EXPIRED",
        "SUBJECT_ERASE",
        "CONSENT_WITHDRAWAL"
      ],
      "scope": [
        "PRIMARY",
        "DERIVED",
        "CACHE",
        "CLIENT_STATE",
        "OBJECTS"
      ],
      "completeWithinSeconds": 3600,
      "preserveIndependentOtherOwners": true,
      "preserveOnlyMinimalTombstone": true
    },
    "backupDeadline": {
      "maxAgeSeconds": 604800,
      "eraseWithinSeconds": 86400,
      "restoreRequiresCurrentLedger": true
    },
    "consentRule": {
      "scopeFields": [
        "preferences.consent.sensitiveRequirementProcessing"
      ],
      "defaultGranted": false,
      "withdrawalStopsUseImmediately": true,
      "withdrawalPurgesIdentifiableCopies": true,
      "requiresExplicitProductAction": true
    }
  },
  {
    "decisionId": "privacy:location:v1",
    "dataCategory": "location",
    "environment": "ISOLATED_SYNTHETIC",
    "automatedDecision": "ALLOW",
    "ruleVersion": "phase002.synthetic-retention.v1",
    "evaluatedAt": "2026-09-09T00:00:00.000Z",
    "runnerRef": "docs/phase-plans/check-phase002-provider-privacy.mjs#checkPrivacy",
    "retentionRule": {
      "startsAt": "createdAt",
      "maxAgeSeconds": 2592000,
      "expiryAction": "ERASE_SUBJECT",
      "protectedBy": "PLAN_VERSION"
    },
    "deletionRule": {
      "triggerEvents": [
        "RETENTION_EXPIRED",
        "SUBJECT_ERASE"
      ],
      "scope": [
        "PRIMARY",
        "DERIVED",
        "CACHE",
        "CLIENT_STATE",
        "OBJECTS"
      ],
      "completeWithinSeconds": 3600,
      "preserveIndependentOtherOwners": true,
      "preserveOnlyMinimalTombstone": true
    },
    "backupDeadline": {
      "maxAgeSeconds": 604800,
      "eraseWithinSeconds": 86400,
      "restoreRequiresCurrentLedger": true
    },
    "consentRule": {
      "scopeFields": [],
      "defaultGranted": false,
      "withdrawalStopsUseImmediately": true,
      "withdrawalPurgesIdentifiableCopies": true,
      "requiresExplicitProductAction": false
    }
  },
  {
    "decisionId": "privacy:travel_plan_and_snapshot:v1",
    "dataCategory": "travel_plan_and_snapshot",
    "environment": "ISOLATED_SYNTHETIC",
    "automatedDecision": "ALLOW",
    "ruleVersion": "phase002.synthetic-retention.v1",
    "evaluatedAt": "2026-09-09T00:00:00.000Z",
    "runnerRef": "docs/phase-plans/check-phase002-provider-privacy.mjs#checkPrivacy",
    "retentionRule": {
      "startsAt": "createdAt",
      "maxAgeSeconds": 2592000,
      "expiryAction": "ERASE_SUBJECT",
      "protectedBy": "PLAN_VERSION"
    },
    "deletionRule": {
      "triggerEvents": [
        "RETENTION_EXPIRED",
        "SUBJECT_ERASE"
      ],
      "scope": [
        "PRIMARY",
        "DERIVED",
        "CACHE",
        "CLIENT_STATE",
        "OBJECTS"
      ],
      "completeWithinSeconds": 3600,
      "preserveIndependentOtherOwners": true,
      "preserveOnlyMinimalTombstone": true
    },
    "backupDeadline": {
      "maxAgeSeconds": 604800,
      "eraseWithinSeconds": 86400,
      "restoreRequiresCurrentLedger": true
    },
    "consentRule": {
      "scopeFields": [],
      "defaultGranted": false,
      "withdrawalStopsUseImmediately": true,
      "withdrawalPurgesIdentifiableCopies": true,
      "requiresExplicitProductAction": false
    }
  },
  {
    "decisionId": "privacy:plan_trace:v1",
    "dataCategory": "plan_trace",
    "environment": "ISOLATED_SYNTHETIC",
    "automatedDecision": "ALLOW",
    "ruleVersion": "phase002.synthetic-retention.v1",
    "evaluatedAt": "2026-09-09T00:00:00.000Z",
    "runnerRef": "docs/phase-plans/check-phase002-provider-privacy.mjs#checkPrivacy",
    "retentionRule": {
      "startsAt": "createdAt",
      "maxAgeSeconds": 2592000,
      "expiryAction": "ERASE_SUBJECT",
      "protectedBy": "PLAN_VERSION"
    },
    "deletionRule": {
      "triggerEvents": [
        "RETENTION_EXPIRED",
        "SUBJECT_ERASE"
      ],
      "scope": [
        "PRIMARY",
        "DERIVED",
        "CACHE",
        "CLIENT_STATE",
        "OBJECTS"
      ],
      "completeWithinSeconds": 3600,
      "preserveIndependentOtherOwners": true,
      "preserveOnlyMinimalTombstone": true
    },
    "backupDeadline": {
      "maxAgeSeconds": 604800,
      "eraseWithinSeconds": 86400,
      "restoreRequiresCurrentLedger": true
    },
    "consentRule": {
      "scopeFields": [],
      "defaultGranted": false,
      "withdrawalStopsUseImmediately": true,
      "withdrawalPurgesIdentifiableCopies": true,
      "requiresExplicitProductAction": false
    }
  },
  {
    "decisionId": "privacy:trace_detail:v1",
    "dataCategory": "trace_detail",
    "environment": "ISOLATED_SYNTHETIC",
    "automatedDecision": "ALLOW",
    "ruleVersion": "phase002.synthetic-retention.v1",
    "evaluatedAt": "2026-09-09T00:00:00.000Z",
    "runnerRef": "docs/phase-plans/check-phase002-provider-privacy.mjs#checkPrivacy",
    "retentionRule": {
      "startsAt": "createdAt",
      "maxAgeSeconds": 86400,
      "expiryAction": "PURGE_CATEGORY",
      "protectedBy": "NONE"
    },
    "deletionRule": {
      "triggerEvents": [
        "RETENTION_EXPIRED",
        "SUBJECT_ERASE"
      ],
      "scope": [
        "PRIMARY",
        "DERIVED",
        "CACHE",
        "CLIENT_STATE",
        "OBJECTS"
      ],
      "completeWithinSeconds": 3600,
      "preserveIndependentOtherOwners": true,
      "preserveOnlyMinimalTombstone": true
    },
    "backupDeadline": {
      "maxAgeSeconds": 604800,
      "eraseWithinSeconds": 86400,
      "restoreRequiresCurrentLedger": true
    },
    "consentRule": {
      "scopeFields": [],
      "defaultGranted": false,
      "withdrawalStopsUseImmediately": true,
      "withdrawalPurgesIdentifiableCopies": true,
      "requiresExplicitProductAction": false
    }
  },
  {
    "decisionId": "privacy:audit_and_command_receipt:v1",
    "dataCategory": "audit_and_command_receipt",
    "environment": "ISOLATED_SYNTHETIC",
    "automatedDecision": "ALLOW",
    "ruleVersion": "phase002.synthetic-retention.v1",
    "evaluatedAt": "2026-09-09T00:00:00.000Z",
    "runnerRef": "docs/phase-plans/check-phase002-provider-privacy.mjs#checkPrivacy",
    "retentionRule": {
      "startsAt": "tombstonedAt",
      "maxAgeSeconds": 691200,
      "expiryAction": "PURGE_AFTER_RESTORE_RETIREMENT",
      "protectedBy": [
        "ACTIVE_OPERATION",
        "DOMAIN_AGGREGATE",
        "RECOVERY_WATERMARK"
      ]
    },
    "deletionRule": {
      "triggerEvents": [
        "RETENTION_EXPIRED",
        "SUBJECT_ERASE"
      ],
      "scope": [
        "PRIMARY",
        "DERIVED",
        "CACHE",
        "CLIENT_STATE",
        "OBJECTS"
      ],
      "completeWithinSeconds": 3600,
      "preserveIndependentOtherOwners": true,
      "preserveOnlyMinimalTombstone": true
    },
    "backupDeadline": {
      "maxAgeSeconds": 604800,
      "eraseWithinSeconds": 86400,
      "restoreRequiresCurrentLedger": true
    },
    "consentRule": {
      "scopeFields": [],
      "defaultGranted": false,
      "withdrawalStopsUseImmediately": true,
      "withdrawalPurgesIdentifiableCopies": true,
      "requiresExplicitProductAction": false
    }
  },
  {
    "decisionId": "privacy:share_token:v1",
    "dataCategory": "share_token",
    "environment": "ISOLATED_SYNTHETIC",
    "automatedDecision": "ALLOW",
    "ruleVersion": "phase002.synthetic-retention.v1",
    "evaluatedAt": "2026-09-09T00:00:00.000Z",
    "runnerRef": "docs/phase-plans/check-phase002-provider-privacy.mjs#checkPrivacy",
    "retentionRule": {
      "startsAt": "createdAt",
      "maxAgeSeconds": 604800,
      "expiryAction": "REVOKE_AND_PURGE",
      "protectedBy": "NONE"
    },
    "deletionRule": {
      "triggerEvents": [
        "RETENTION_EXPIRED",
        "SUBJECT_ERASE"
      ],
      "scope": [
        "PRIMARY",
        "DERIVED",
        "CACHE",
        "CLIENT_STATE",
        "OBJECTS"
      ],
      "completeWithinSeconds": 3600,
      "preserveIndependentOtherOwners": true,
      "preserveOnlyMinimalTombstone": true
    },
    "backupDeadline": {
      "maxAgeSeconds": 604800,
      "eraseWithinSeconds": 86400,
      "restoreRequiresCurrentLedger": true
    },
    "consentRule": {
      "scopeFields": [],
      "defaultGranted": false,
      "withdrawalStopsUseImmediately": true,
      "withdrawalPurgesIdentifiableCopies": true,
      "requiresExplicitProductAction": false
    }
  },
  {
    "decisionId": "privacy:data_and_feedback_receipt:v1",
    "dataCategory": "data_and_feedback_receipt",
    "environment": "ISOLATED_SYNTHETIC",
    "automatedDecision": "ALLOW",
    "ruleVersion": "phase002.synthetic-retention.v1",
    "evaluatedAt": "2026-09-09T00:00:00.000Z",
    "runnerRef": "docs/phase-plans/check-phase002-provider-privacy.mjs#checkPrivacy",
    "retentionRule": {
      "startsAt": "tombstonedAt",
      "maxAgeSeconds": 691200,
      "expiryAction": "PURGE_AFTER_RESTORE_RETIREMENT",
      "protectedBy": [
        "ACTIVE_OPERATION",
        "DOMAIN_AGGREGATE",
        "RECOVERY_WATERMARK"
      ]
    },
    "deletionRule": {
      "triggerEvents": [
        "RETENTION_EXPIRED",
        "SUBJECT_ERASE"
      ],
      "scope": [
        "PRIMARY",
        "DERIVED",
        "CACHE",
        "CLIENT_STATE",
        "OBJECTS"
      ],
      "completeWithinSeconds": 3600,
      "preserveIndependentOtherOwners": true,
      "preserveOnlyMinimalTombstone": true
    },
    "backupDeadline": {
      "maxAgeSeconds": 604800,
      "eraseWithinSeconds": 86400,
      "restoreRequiresCurrentLedger": true
    },
    "consentRule": {
      "scopeFields": [],
      "defaultGranted": false,
      "withdrawalStopsUseImmediately": true,
      "withdrawalPurgesIdentifiableCopies": true,
      "requiresExplicitProductAction": false
    }
  },
  {
    "decisionId": "privacy:export_temporary_file:v1",
    "dataCategory": "export_temporary_file",
    "environment": "ISOLATED_SYNTHETIC",
    "automatedDecision": "ALLOW",
    "ruleVersion": "phase002.synthetic-retention.v1",
    "evaluatedAt": "2026-09-09T00:00:00.000Z",
    "runnerRef": "docs/phase-plans/check-phase002-provider-privacy.mjs#checkPrivacy",
    "retentionRule": {
      "startsAt": "createdAt",
      "maxAgeSeconds": 3600,
      "expiryAction": "PURGE_CATEGORY",
      "protectedBy": "NONE"
    },
    "deletionRule": {
      "triggerEvents": [
        "RETENTION_EXPIRED",
        "SUBJECT_ERASE"
      ],
      "scope": [
        "PRIMARY",
        "DERIVED",
        "CACHE",
        "CLIENT_STATE",
        "OBJECTS"
      ],
      "completeWithinSeconds": 3600,
      "preserveIndependentOtherOwners": true,
      "preserveOnlyMinimalTombstone": true
    },
    "backupDeadline": {
      "maxAgeSeconds": 604800,
      "eraseWithinSeconds": 86400,
      "restoreRequiresCurrentLedger": true
    },
    "consentRule": {
      "scopeFields": [],
      "defaultGranted": false,
      "withdrawalStopsUseImmediately": true,
      "withdrawalPurgesIdentifiableCopies": true,
      "requiresExplicitProductAction": false
    }
  },
  {
    "decisionId": "privacy:evaluation_sample:v1",
    "dataCategory": "evaluation_sample",
    "environment": "ISOLATED_SYNTHETIC",
    "automatedDecision": "ALLOW",
    "ruleVersion": "phase002.synthetic-retention.v1",
    "evaluatedAt": "2026-09-09T00:00:00.000Z",
    "runnerRef": "docs/phase-plans/check-phase002-provider-privacy.mjs#checkPrivacy",
    "retentionRule": {
      "startsAt": "createdAt",
      "maxAgeSeconds": 604800,
      "expiryAction": "PURGE_CATEGORY",
      "protectedBy": "NONE"
    },
    "deletionRule": {
      "triggerEvents": [
        "RETENTION_EXPIRED",
        "SUBJECT_ERASE",
        "CONSENT_WITHDRAWAL"
      ],
      "scope": [
        "PRIMARY",
        "DERIVED",
        "CACHE",
        "CLIENT_STATE",
        "OBJECTS"
      ],
      "completeWithinSeconds": 3600,
      "preserveIndependentOtherOwners": true,
      "preserveOnlyMinimalTombstone": true
    },
    "backupDeadline": {
      "maxAgeSeconds": 604800,
      "eraseWithinSeconds": 86400,
      "restoreRequiresCurrentLedger": true
    },
    "consentRule": {
      "scopeFields": [
        "evaluationConsent"
      ],
      "defaultGranted": false,
      "withdrawalStopsUseImmediately": true,
      "withdrawalPurgesIdentifiableCopies": true,
      "requiresExplicitProductAction": true
    }
  },
  {
    "decisionId": "privacy:feedback_contact:v1",
    "dataCategory": "feedback_contact",
    "environment": "ISOLATED_SYNTHETIC",
    "automatedDecision": "ALLOW",
    "ruleVersion": "phase002.synthetic-retention.v1",
    "evaluatedAt": "2026-09-09T00:00:00.000Z",
    "runnerRef": "docs/phase-plans/check-phase002-provider-privacy.mjs#checkPrivacy",
    "retentionRule": {
      "startsAt": "createdAt",
      "maxAgeSeconds": 604800,
      "expiryAction": "PURGE_CATEGORY",
      "protectedBy": "NONE"
    },
    "deletionRule": {
      "triggerEvents": [
        "RETENTION_EXPIRED",
        "SUBJECT_ERASE",
        "CONSENT_WITHDRAWAL"
      ],
      "scope": [
        "PRIMARY",
        "DERIVED",
        "CACHE",
        "CLIENT_STATE",
        "OBJECTS"
      ],
      "completeWithinSeconds": 3600,
      "preserveIndependentOtherOwners": true,
      "preserveOnlyMinimalTombstone": true
    },
    "backupDeadline": {
      "maxAgeSeconds": 604800,
      "eraseWithinSeconds": 86400,
      "restoreRequiresCurrentLedger": true
    },
    "consentRule": {
      "scopeFields": [
        "contactConsent"
      ],
      "defaultGranted": false,
      "withdrawalStopsUseImmediately": true,
      "withdrawalPurgesIdentifiableCopies": true,
      "requiresExplicitProductAction": true
    }
  },
  {
    "decisionId": "privacy:media_attachment:v1",
    "dataCategory": "media_attachment",
    "environment": "ISOLATED_SYNTHETIC",
    "automatedDecision": "ALLOW",
    "ruleVersion": "phase002.synthetic-retention.v1",
    "evaluatedAt": "2026-09-09T00:00:00.000Z",
    "runnerRef": "docs/phase-plans/check-phase002-provider-privacy.mjs#checkPrivacy",
    "retentionRule": {
      "startsAt": "createdAt",
      "maxAgeSeconds": 2592000,
      "expiryAction": "ERASE_SUBJECT",
      "protectedBy": "PLAN_VERSION"
    },
    "deletionRule": {
      "triggerEvents": [
        "RETENTION_EXPIRED",
        "SUBJECT_ERASE"
      ],
      "scope": [
        "PRIMARY",
        "DERIVED",
        "CACHE",
        "CLIENT_STATE",
        "OBJECTS"
      ],
      "completeWithinSeconds": 3600,
      "preserveIndependentOtherOwners": true,
      "preserveOnlyMinimalTombstone": true
    },
    "backupDeadline": {
      "maxAgeSeconds": 604800,
      "eraseWithinSeconds": 86400,
      "restoreRequiresCurrentLedger": true
    },
    "consentRule": {
      "scopeFields": [],
      "defaultGranted": false,
      "withdrawalStopsUseImmediately": true,
      "withdrawalPurgesIdentifiableCopies": true,
      "requiresExplicitProductAction": false
    }
  },
  {
    "decisionId": "privacy:backup:v1",
    "dataCategory": "backup",
    "environment": "ISOLATED_SYNTHETIC",
    "automatedDecision": "ALLOW",
    "ruleVersion": "phase002.synthetic-retention.v1",
    "evaluatedAt": "2026-09-09T00:00:00.000Z",
    "runnerRef": "docs/phase-plans/check-phase002-provider-privacy.mjs#checkPrivacy",
    "retentionRule": {
      "startsAt": "createdAt",
      "maxAgeSeconds": 604800,
      "expiryAction": "RETIRE_BACKUP",
      "protectedBy": "NONE"
    },
    "deletionRule": {
      "triggerEvents": [
        "RETENTION_EXPIRED",
        "SUBJECT_ERASE"
      ],
      "scope": [
        "PRIMARY",
        "DERIVED",
        "CACHE",
        "CLIENT_STATE",
        "OBJECTS"
      ],
      "completeWithinSeconds": 3600,
      "preserveIndependentOtherOwners": true,
      "preserveOnlyMinimalTombstone": true
    },
    "backupDeadline": {
      "maxAgeSeconds": 604800,
      "eraseWithinSeconds": 86400,
      "restoreRequiresCurrentLedger": true
    },
    "consentRule": {
      "scopeFields": [],
      "defaultGranted": false,
      "withdrawalStopsUseImmediately": true,
      "withdrawalPurgesIdentifiableCopies": true,
      "requiresExplicitProductAction": false
    }
  },
  {
    "decisionId": "privacy:privacy_revocation_ledger:v1",
    "dataCategory": "privacy_revocation_ledger",
    "environment": "ISOLATED_SYNTHETIC",
    "automatedDecision": "ALLOW",
    "ruleVersion": "phase002.synthetic-retention.v1",
    "evaluatedAt": "2026-09-09T00:00:00.000Z",
    "runnerRef": "docs/phase-plans/check-phase002-provider-privacy.mjs#checkPrivacy",
    "retentionRule": {
      "startsAt": "tombstonedAt",
      "maxAgeSeconds": 691200,
      "expiryAction": "PURGE_AFTER_RESTORE_RETIREMENT",
      "protectedBy": [
        "ACTIVE_OPERATION",
        "DOMAIN_AGGREGATE",
        "RECOVERY_WATERMARK"
      ]
    },
    "deletionRule": {
      "triggerEvents": [
        "RETENTION_EXPIRED",
        "SUBJECT_ERASE"
      ],
      "scope": [
        "PRIMARY",
        "DERIVED",
        "CACHE",
        "CLIENT_STATE",
        "OBJECTS"
      ],
      "completeWithinSeconds": 3600,
      "preserveIndependentOtherOwners": true,
      "preserveOnlyMinimalTombstone": true
    },
    "backupDeadline": {
      "maxAgeSeconds": 604800,
      "eraseWithinSeconds": 86400,
      "restoreRequiresCurrentLedger": true
    },
    "consentRule": {
      "scopeFields": [],
      "defaultGranted": false,
      "withdrawalStopsUseImmediately": true,
      "withdrawalPurgesIdentifiableCopies": true,
      "requiresExplicitProductAction": false
    }
  }
]
```

## 固定执行 fixture

以下是文档验证输入，simulation=true。临时目录中的 application/objects/backup 与 ledger 分开存放；断点、到期、撤回会实际删除合成文件，旧备份恢复会实际重放合成账本。结果不声称实现了真实 PostgreSQL 事务、对象存储或产品同意界面。

<!-- contract:privacy-fixtures -->
```json
{
  "clock": "2026-09-09T00:00:00.000Z",
  "simulation": true,
  "decisions": [
    {
      "id": "allowed-synthetic",
      "category": "account",
      "environment": "ISOLATED_SYNTHETIC",
      "ruleVersion": "phase002.synthetic-retention.v1",
      "expected": true
    },
    {
      "id": "production-is-not-approved",
      "category": "account",
      "environment": "PRODUCTION",
      "ruleVersion": "phase002.synthetic-retention.v1",
      "expected": false
    },
    {
      "id": "prohibited-category-block",
      "category": "prohibited_sensitive_data",
      "environment": "ISOLATED_SYNTHETIC",
      "ruleVersion": "phase002.synthetic-retention.v1",
      "expected": false
    },
    {
      "id": "old-rule-version-block",
      "category": "account",
      "environment": "ISOLATED_SYNTHETIC",
      "ruleVersion": "other-v1",
      "expected": false
    },
    {
      "id": "missing-category-block",
      "category": "unregistered",
      "environment": "ISOLATED_SYNTHETIC",
      "ruleVersion": "phase002.synthetic-retention.v1",
      "expected": false
    },
    {
      "id": "explicit-block-zero-writes",
      "category": "account",
      "environment": "ISOLATED_SYNTHETIC",
      "ruleVersion": "phase002.synthetic-retention.v1",
      "automatedDecision": "BLOCK",
      "expected": false
    }
  ],
  "retention": [
    {
      "id": "before-expiry-preserved",
      "category": "export_temporary_file",
      "ageSeconds": 3599,
      "pinned": false,
      "restoreSetsRetired": true,
      "expectedDeleted": false,
      "expectedBlocked": false
    },
    {
      "id": "expiry-boundary-deleted",
      "category": "export_temporary_file",
      "ageSeconds": 3600,
      "pinned": false,
      "restoreSetsRetired": true,
      "expectedDeleted": true,
      "expectedBlocked": false
    },
    {
      "id": "trace-detail-expires",
      "category": "trace_detail",
      "ageSeconds": 86400,
      "pinned": false,
      "restoreSetsRetired": true,
      "expectedDeleted": true,
      "expectedBlocked": false
    },
    {
      "id": "version-context-erased-together",
      "category": "travel_plan_and_snapshot",
      "ageSeconds": 2592000,
      "pinned": true,
      "restoreSetsRetired": true,
      "expectedDeleted": true,
      "expectedBlocked": false
    },
    {
      "id": "unproven-watermark-blocks-purge",
      "category": "privacy_revocation_ledger",
      "ageSeconds": 691200,
      "pinned": true,
      "restoreSetsRetired": false,
      "expectedDeleted": false,
      "expectedBlocked": true,
      "operationActive": false,
      "aggregatePresent": false,
      "domainCleanupComplete": true,
      "tombstoneAgeSeconds": 691200
    },
    {
      "id": "retired-restore-sets-permit-purge",
      "category": "privacy_revocation_ledger",
      "ageSeconds": 691200,
      "pinned": true,
      "restoreSetsRetired": true,
      "expectedDeleted": true,
      "expectedBlocked": false,
      "operationActive": false,
      "aggregatePresent": false,
      "domainCleanupComplete": true,
      "tombstoneAgeSeconds": 691200
    },
    {
      "id": "active-command-retained-past-eight-days",
      "category": "audit_and_command_receipt",
      "ageSeconds": 3456000,
      "pinned": true,
      "operationActive": true,
      "aggregatePresent": false,
      "domainCleanupComplete": false,
      "tombstoneAgeSeconds": null,
      "restoreSetsRetired": true,
      "expectedDeleted": false,
      "expectedBlocked": false
    },
    {
      "id": "live-aggregate-command-receipt",
      "category": "audit_and_command_receipt",
      "ageSeconds": 3456000,
      "pinned": true,
      "operationActive": false,
      "aggregatePresent": true,
      "domainCleanupComplete": false,
      "tombstoneAgeSeconds": null,
      "restoreSetsRetired": true,
      "expectedDeleted": false,
      "expectedBlocked": false
    },
    {
      "id": "live-feedback-receipt",
      "category": "data_and_feedback_receipt",
      "ageSeconds": 3456000,
      "pinned": true,
      "operationActive": false,
      "aggregatePresent": true,
      "domainCleanupComplete": false,
      "tombstoneAgeSeconds": null,
      "restoreSetsRetired": true,
      "expectedDeleted": false,
      "expectedBlocked": false
    },
    {
      "id": "active-data-request-receipt",
      "category": "data_and_feedback_receipt",
      "ageSeconds": 3456000,
      "pinned": true,
      "operationActive": true,
      "aggregatePresent": false,
      "domainCleanupComplete": false,
      "tombstoneAgeSeconds": null,
      "restoreSetsRetired": true,
      "expectedDeleted": false,
      "expectedBlocked": false
    },
    {
      "id": "completed-receipt-missing-tombstone",
      "category": "data_and_feedback_receipt",
      "ageSeconds": 3456000,
      "pinned": true,
      "operationActive": false,
      "aggregatePresent": false,
      "domainCleanupComplete": true,
      "tombstoneAgeSeconds": null,
      "restoreSetsRetired": true,
      "expectedDeleted": false,
      "expectedBlocked": true
    },
    {
      "id": "incomplete-domain-cleanup-blocks-receipt",
      "category": "data_and_feedback_receipt",
      "ageSeconds": 3456000,
      "pinned": true,
      "operationActive": false,
      "aggregatePresent": false,
      "domainCleanupComplete": false,
      "tombstoneAgeSeconds": 691200,
      "restoreSetsRetired": true,
      "expectedDeleted": false,
      "expectedBlocked": true
    },
    {
      "id": "receipt-tombstone-before-boundary",
      "category": "data_and_feedback_receipt",
      "ageSeconds": 3456000,
      "pinned": true,
      "operationActive": false,
      "aggregatePresent": false,
      "domainCleanupComplete": true,
      "tombstoneAgeSeconds": 691199,
      "restoreSetsRetired": true,
      "expectedDeleted": false,
      "expectedBlocked": false
    },
    {
      "id": "receipt-tombstone-boundary-deleted",
      "category": "data_and_feedback_receipt",
      "ageSeconds": 3456000,
      "pinned": true,
      "operationActive": false,
      "aggregatePresent": false,
      "domainCleanupComplete": true,
      "tombstoneAgeSeconds": 691200,
      "restoreSetsRetired": true,
      "expectedDeleted": true,
      "expectedBlocked": false
    },
    {
      "id": "receipt-tombstone-unretired-backups-blocked",
      "category": "data_and_feedback_receipt",
      "ageSeconds": 3456000,
      "pinned": true,
      "operationActive": false,
      "aggregatePresent": false,
      "domainCleanupComplete": true,
      "tombstoneAgeSeconds": 691200,
      "restoreSetsRetired": false,
      "expectedDeleted": false,
      "expectedBlocked": true
    },
    {
      "id": "active-erasure-ledger-retained",
      "category": "privacy_revocation_ledger",
      "ageSeconds": 3456000,
      "pinned": true,
      "operationActive": true,
      "aggregatePresent": false,
      "domainCleanupComplete": false,
      "tombstoneAgeSeconds": null,
      "restoreSetsRetired": true,
      "expectedDeleted": false,
      "expectedBlocked": false
    },
    {
      "id": "missing-lifecycle-state-blocks-receipt",
      "category": "audit_and_command_receipt",
      "ageSeconds": 3456000,
      "pinned": true,
      "restoreSetsRetired": true,
      "expectedDeleted": false,
      "expectedBlocked": true
    }
  ],
  "backups": [
    {
      "id": "before-backup-deadline",
      "ageAfterEraseSeconds": 86399,
      "expectedDeleted": false
    },
    {
      "id": "backup-deadline-deletes",
      "ageAfterEraseSeconds": 86400,
      "expectedDeleted": true
    }
  ],
  "erasures": [
    {
      "id": "ledger-first-normal",
      "applicationFails": false,
      "taskExhausts": false,
      "objectDeleteFails": false,
      "expectedStatus": "COMPLETED",
      "expectedContinuation": 0
    },
    {
      "id": "ledger-success-app-failure",
      "applicationFails": true,
      "taskExhausts": false,
      "objectDeleteFails": false,
      "expectedStatus": "COMPLETED",
      "expectedContinuation": 0
    },
    {
      "id": "continued-after-credential-erasure",
      "applicationFails": false,
      "taskExhausts": true,
      "objectDeleteFails": false,
      "expectedStatus": "COMPLETED",
      "expectedContinuation": 1
    },
    {
      "id": "objects-unconfirmed-not-completed",
      "applicationFails": false,
      "taskExhausts": false,
      "objectDeleteFails": true,
      "expectedStatus": "RUNNING",
      "expectedContinuation": 0
    },
    {
      "id": "erase-resumes-after-receipt-ttl",
      "applicationFails": false,
      "taskExhausts": true,
      "objectDeleteFails": false,
      "elapsedBeforeContinuationSeconds": 3456000,
      "expectedStatus": "COMPLETED",
      "expectedContinuation": 1
    }
  ],
  "consent": [
    {
      "id": "consent-retained",
      "contactConsent": true,
      "evaluationConsent": true,
      "withdrawContact": false,
      "withdrawEvaluation": false,
      "shareRevoked": false,
      "expectedContact": true,
      "expectedSample": true
    },
    {
      "id": "independent-contact-withdrawal",
      "contactConsent": true,
      "evaluationConsent": true,
      "withdrawContact": true,
      "withdrawEvaluation": false,
      "shareRevoked": false,
      "expectedContact": false,
      "expectedSample": true
    },
    {
      "id": "evaluation-withdrawal-after-share-revoked",
      "contactConsent": true,
      "evaluationConsent": true,
      "withdrawContact": false,
      "withdrawEvaluation": true,
      "shareRevoked": true,
      "expectedContact": true,
      "expectedSample": false
    },
    {
      "id": "both-withdrawals",
      "contactConsent": true,
      "evaluationConsent": true,
      "withdrawContact": true,
      "withdrawEvaluation": true,
      "shareRevoked": true,
      "expectedContact": false,
      "expectedSample": false
    },
    {
      "id": "default-false-no-sampling",
      "contactConsent": false,
      "evaluationConsent": false,
      "withdrawContact": false,
      "withdrawEvaluation": false,
      "shareRevoked": false,
      "expectedContact": false,
      "expectedSample": false
    }
  ],
  "publicProjection": [
    {
      "id": "private-node-redacted",
      "privatePlace": true,
      "maliciousNested": true,
      "expectedCoordinate": null,
      "expectedGeometry": "sequence_only",
      "expectedTileRequests": 0
    },
    {
      "id": "verified-public-point",
      "privatePlace": false,
      "maliciousNested": true,
      "expectedCoordinate": {
        "lat": 30,
        "lng": 120
      },
      "expectedGeometry": "verified",
      "expectedTileRequests": 1
    }
  ],
  "sourceUrls": [
    {
      "id": "safe-public-url",
      "url": "https://source.fixture.invalid/public",
      "expected": "https://source.fixture.invalid/public"
    },
    {
      "id": "source-without-public-url",
      "url": null,
      "expected": null
    },
    {
      "id": "signed-url-not-public",
      "url": "https://source.fixture.invalid/public?X-Amz-Signature=fixture",
      "expected": null
    },
    {
      "id": "credential-url-not-public",
      "url": "https://user:pass@source.fixture.invalid/public",
      "expected": null
    },
    {
      "id": "private-host-not-public",
      "url": "https://127.0.0.1/public",
      "expected": null
    },
    {
      "id": "javascript-not-public",
      "url": "javascript:fixture",
      "expected": null
    }
  ],
  "restore": [
    {
      "id": "old-backup-replay-before-readiness",
      "ledgerAvailable": true,
      "ledgerWatermark": 2,
      "backupWatermark": 0,
      "expectedReadiness": true,
      "expectedPersonalContent": false
    },
    {
      "id": "missing-ledger-fails-closed",
      "ledgerAvailable": false,
      "ledgerWatermark": 2,
      "backupWatermark": 0,
      "expectedReadiness": false,
      "expectedPersonalContent": true
    },
    {
      "id": "regressed-watermark-fails-closed",
      "ledgerAvailable": true,
      "ledgerWatermark": 1,
      "backupWatermark": 2,
      "expectedReadiness": false,
      "expectedPersonalContent": true
    }
  ],
  "secretProtocolCases": [
    "anonymous-cookie-only",
    "hash-only-persistence",
    "same-key-same-receipt-replay",
    "same-key-different-receipt-rejected",
    "receipt-is-not-download",
    "feedback-receipt-after-share-revocation",
    "share-first-delivery",
    "share-replay-has-no-token",
    "share-reissue-keeps-version-and-expiry",
    "nested-log-secret-removal",
    "allowlisted-log-value-is-not-free-text"
  ]
}
```

运行 `node docs/phase-plans/check-phase002-provider-privacy.mjs --case privacy`。生产实现阶段必须用相同规则驱动真实服务/API/UI/存储再验证，不能把本阶段临时文件模拟器作为产品删除服务。
