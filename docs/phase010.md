# Phase010：版本化密钥存储与基础 seed

本阶段收口 M2 数据层：新增 ApiKeyConfig/ApiKeyStatus 和一条 api_key_config additive migration，提供 exact envelope parser、指纹/AAD 工具及仅创建的管理员/SystemConfig seed。继续复用 Phase006–009 的 User、SystemConfig、AuditLog 与事务保护；不改写既有迁移，不创建治理模型、管理 API 或 Provider 外呼。

阶段范围与六项验收以 [冻结计划](phase-plans/Phase010.json) 为准，本地开发文档仅通过 [输入收据](phase-plans/Phase010-inputs.json) 固定路径和 SHA-256。本文记录实现边界与验收要求，不替代实际 Gate、独立复核、artifact/metadata 双提交或双 shell seal。仅授权 Phase010/M2；Phase011 的准入编号不代表已获准执行。

## ApiKeyConfig 存储边界

精确字段为 `id/name/provider/encryptedKey/encryptionKeyId/envelopeVersion/keyFingerprint/status/lastUsedAt/revokedAt/createdAt/updatedAt/revision`。id 为 cuid 主键；全局管理员配置没有 userId。keyFingerprint 是规范化 API key 的完整 SHA-256 小写64位 hex，Char(64) 唯一；主密钥字节的 SHA-256 标识则为 encryptionKeyId，两者不混用。状态默认 ACTIVE，唯一集合为 ACTIVE/DISABLED/REVOKED；revision 默认0且非负，provider/status 有复合索引，四个时间字段为 timestamptz(3)。

encryptedKey 是 Text 中的 RFC8785 JCS canonical JSON，exact 六字段为 `version/keyId/algorithm/iv/ciphertext/tag`。version 必须是数字1，algorithm 固定 A256GCM，keyId 是64位小写 hex，并分别与 envelopeVersion/encryptionKeyId 列精确绑定。只有 iv/ciphertext/tag 接受带标准 padding 的 canonical base64，解码后分别为12/1–16384/16 bytes；重新编码必须逐字节相等。完整文本上限22500 UTF-8 bytes，键序为 algorithm/ciphertext/iv/keyId/tag/version。格式错误、重复/未知字段、错误类型、非规范转义/空白/键序、超限及列不匹配都拒绝。

`src/server/api-key-envelope.ts` 暴露三个 server-only 工具：parseApiKeyEnvelope 校验上述存储文本，apiKeyFingerprint 仅 trim 输入边界后按保留大小写/中间字节的1–16384 UTF-8 bytes 取完整摘要，apiKeyAad 为当前行生成 JCS UTF-8 的 `{recordId,provider,envelopeVersion}`。AAD 的 canonical 键序为 envelopeVersion/provider/recordId，不能写入额外 envelope 字段，也不能从另一行复制身份。

迁移 CHECK 与更新 trigger 固定 `id/provider/encryptedKey/encryptionKeyId/envelopeVersion/keyFingerprint/createdAt`。name 或 status 实际改变时 revision 恰加1，均不变时 revision 保持；lastUsedAt/updatedAt 不充当 CAS。ACTIVE 可到 DISABLED/REVOKED，DISABLED 可到 ACTIVE/REVOKED；REVOKED 没有出口且撤销时间不可再改。status=REVOKED 与 revokedAt 非 null 必须等价。

格式校验不能证明 GCM tag 正确。本阶段没有加解密服务、KeyResolver、随机 IV 生成、管理授权/expectedVersion 服务或轮换入口；Phase013 复用同一 parser/AAD 实现这些行为，并验证真正加解密与数据库往返。未来 `ProviderConfigVersion.secretRef` 直接引用现有 ApiKeyConfig.id；Phase015 才首产治理模型和引用约束，不建立第二张 secret 表。migration 与基础 seed 均不创建 ApiKeyConfig 行。

## CLI 输入与目标识别

`npm run db:seed` 执行 `node --conditions=react-server --import tsx prisma/seed.ts`。`readSeedEnv` 通过统一 registry/parser 仅读取 NODE_ENV/DATABASE_URL 和 command=seed 的 ADMIN_EMAIL/ADMIN_INITIAL_PASSWORD；后两项为 CLI scope、producerPhase=10、requiredWhen=seed，不放 `.env.example`，Web 启动无需提供。入口不读取 Auth、加密主密钥或 Provider 凭据。

NODE_ENV 必须显式为 development/test；production、未知或缺失环境在创建客户端前拒绝。URL 只能指向精确127.0.0.1、显式端口的 postgresql disposable 数据库，且数据库 comment 必须匹配命名中的12位运行标识。URL 参数、实际数据库/角色、PostgreSQL17、最小权限角色、迁移名称/checksum/完成状态均在读取业务表前验证。完整目标规则见 [托管规范](hosting.md#phase010-配置优先级与基础-seed)。不使用共享/生产库，不使用 db push/reset。

email 经 normalizeEmailV1 规范化。密码须为合法 UTF-8 12–72 bytes，含大小写字母、数字与非空白特殊字符，拒绝控制字符；不 trim、不改变大小写/Unicode，bcryptjs cost12。隔离凭据由 CSPRNG 生成，准备值只保留在被忽略的受控本地区域；缺失/非法值与原始数据库异常均不会回显原文。

## 创建、来源与幂等

空库只创建一个 ADMIN/ACTIVE 与以下三项 SystemConfig；每项配置均为 GENERAL/isPublic=false，不进入公共投影。

| key | valueJson |
|---|---|
| planner.quick.defaultDurationDays | 3 |
| planner.quick.defaultTravelerCount | 1 |
| planner.quick.defaultPace | "moderate" |

全部业务写入仅 create。存在规范化 email 时，必须是同一次 seed 先前创建、来源与指纹均一致、密码可验证的 ACTIVE ADMIN；USER、DISABLED、无来源管理员、变更后的凭据/身份/状态均拒绝，不提权、启用或覆盖。已有配置要求 valueJson/group/isPublic 与冻结定义一致；相同项完全保留，冲突即整事务失败，只有缺失项才创建。环境部署上限始终先于 DB 运行值，默认值只承担缺项初始化，详见 [托管规范](hosting.md)。

每次实际创建附加一条同事务 AuditLog：SEED_ADMIN_CREATE→User、SEED_CONFIG_CREATE→SystemConfig，actor 为 SYSTEM/MIGRATION，actorId 与 actorEmailSnapshot 均 null。固定非秘密来源标识为 PHASE010_BASE_SEED_V1，稳定 seedRunId 来自目标的阶段/项目标识和12位运行标识。管理员创建审计的 seedFingerprint 对 `sourceMarker/seedRunId/id/email/passwordHash/role/status/revision/sessionVersion/createdAt` 的 JCS UTF-8 取 SHA-256，其中 createdAt 为 ISO 字符串；不存明文密码的直接摘要。来源核验要求唯一匹配的管理员创建审计、正确目标与主体、相同来源及当前行指纹，再验证现有 bcrypt hash cost12 和输入密码。

首次空库预期1个管理员、3项配置和4条创建审计。同输入重放预期业务新增/更新0、审计新增0，passwordHash、创建时间、角色/状态/sessionVersion/revision 与配置内容保持。完全验证的 no-op 使用私有信号回滚只读事务并返回 UNCHANGED；审计 helper 仍禁止没有已等待成功审计的提交。

seed 由 helper 自行创建真实 Prisma 连接，使用已登记的 Serializable 交互事务；不接受调用方事务包装。只有 serialization/unique 冲突可按25/50/100ms固定退避最多重试3次，每次重读目标和内容。耗尽后只执行一次只读核对；全部已匹配才能返回 UNCHANGED，缺失/冲突继续非零失败。创建和审计全部原子，审计故障不得留下部分用户或配置。

成功 CLI 只输出 SEEDED/UNCHANGED、创建计数与重试次数。失败分类为 INVALID_INPUT、UNSAFE_TARGET、MIGRATION_DRIFT、EXISTING_DATA_CONFLICT、RETRY_EXHAUSTED、DATABASE_FAILURE，退出码非零。邮箱、密码、数据库 URL、bcrypt hash、管理员行指纹值、API key 和 encryptedKey 内容均不进入 CLI 输出或证据。

## 验收与后续阶段

当前计划固定以下六项，阈值6/6，原阈值不因重试而降低；这里列出要求，实际结果只能来自对应 attempt 的运行输出。

| case | 必须覆盖 |
|---|---|
| migration | 从 Phase009 重放唯一新增迁移；保留旧迁移和数据；字段/索引/CHECK/trigger、Client 类型、status/drift 与全部非法 envelope/状态反例 |
| first-seed | 真实 CLI 首次创建1/3/4；bcrypt 验证、来源/指纹、目标守卫与审计故障回滚 |
| repeated-seed | 相同输入零写入；既有身份/密码/配置不变；来源、fingerprint 与输入冲突拒绝 |
| concurrent-seed | 两个独立 CLI 从空库竞争；有限重试与重读；最终唯一行与原子创建审计 |
| secret-privilege | 缺输入、弱/过长密码、非法邮箱、production、未知目标、USER/DISABLED/无来源账户与配置冲突；原始输出扫描及反向 mutation |
| governance-absence | ApiKeyConfig 初始行0；无治理/过渡模型；Phase006–009 回归、产品质量检查、证据绑定与独立复核 |

验收入口按冻结计划运行 `node docs/phase-plans/verify-phase010.mjs --case <case>`，另执行现有 lint/typecheck/test/format:check/build、目录校验和校验器回归。迁移生成/应用、Prisma generate/status 与串行/并发 db:seed 都只在明确标记的 disposable PostgreSQL17 环境运行。反向实验在独立副本把 create-only 改成覆盖更新或移除 production guard，原断言必须实际非零失败；恢复后的真实实现重新验证。

原始 stdout/stderr 先扫描再归档，报告只保存安全分类、计数、命令退出码与文件 hash，不保存生成密码、Provider key、密文或管理员凭据。失败 attempt 保持不可变；全部当前断言与独立复核完成后才生成 Gate 并按 artifact→metadata、双 shell seal 与远端同步封口。本文不宣称当前验收已通过。

本阶段不执行 Phase011–015。Phase013 负责受权密钥录入/轮换与安全投影；Phase015 负责最终 Prompt/Model/Provider/PlanningPolicy 治理、AiOutputRecord、激活和真实引用 adapter，并按既定契约退役 AI bootstrap 输入。禁止提前创建 PromptConfig/AiModelConfig、占位密钥、默认模型/Prompt/Provider 或治理激活记录。
