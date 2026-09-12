# Serendipity · 际遇 密钥与加密契约

Owner: 服务端秘密管理；producerPhase: 2；存储消费者: Phase010；行为消费者: Phase013、Phase015、Phase092、Phase126。ApiKeyConfig 及数据库列由 [数据库规范](database.md) 定义；本文件唯一拥有 envelope 字节格式、AAD、KeyResolver 与生命周期约束。安全响应由 [API](api.md) 定义，轮换事务由 [管理契约](admin.md) 定义，保留和擦除由 [隐私契约](privacy-and-user-data.md) 定义。来源及 hash 见 [输入清单](phase-plans/Phase002-inputs.json)。

## Envelope v1

`encryptedKey` 是 String @db.Text，内容为 RFC8785 JCS canonical JSON UTF-8；不是 Prisma Json 列，不是明文或任意 ciphertext 字符串。对象 exact 六字段 `version/keyId/algorithm/iv/ciphertext/tag`，未知字段或非 canonical 序列化拒绝。version 为整数 1，algorithm 为字面值 A256GCM；keyId 为解码后 32-byte ENCRYPTION_KEY 的 SHA-256 小写 64 位 hex，必须与 encryptionKeyId 列相等，version 与 envelopeVersion 列相等。

iv/ciphertext/tag 仅接受标准 alphabet、标准 padding 的 canonical base64，解码后重新编码必须逐字节相等。IV 为 12 bytes（96-bit），tag 为 16 bytes（128-bit），ciphertext 为 1–16384 bytes。每次加密使用新的 CSPRNG IV，同一密钥明文两次加密 ciphertext 不同；测试固定输入不意味着生产可以固定 IV。

先由服务端生成 ApiKeyConfig.id，AAD 精确为 JCS UTF-8 `{recordId,provider,envelopeVersion}`，字段来自当前行与受控 Provider 标识。GCM 将记录身份、Provider 与版本绑定到认证标签；跨记录搬运密文、修改 IV/tag/ciphertext/AAD、错误 key、未知版本或未知 keyId 均失败。解密前完整校验 schema/长度/编码，禁止宽松 base64 或算法 fallback。

## 明文、指纹与解析

API key 的规范化仅移除输入两端空白，不 lowercase、不 Unicode 归一化、不改变中间字节；结果须为 1–16384 UTF-8 bytes。keyFingerprint 是这些规范化字节的 SHA-256 全量小写 64 位 hex，唯一约束用于去重，与主密钥 keyId 不是同一含义。ADMIN 安全 DTO 仅派生 fingerprint 前 12 个字符加 `…`，不返回完整 fingerprint、envelope、encryptedKey、encryptionKeyId 或明文。

KeyResolver 按精确 keyId 解析受控 key ring，未知 keyId 关闭调用；Phase126 的扩展保留历史合法 key 的解密能力，不覆盖旧 envelope。主 key 经统一环境 parser 解码并验证 32 bytes，数据库不保存主 key。ProviderConfigVersion 的 secretRef 只引用 ApiKeyConfig.id；credentialRequirement=NONE 要求 secretRef=null 且不发送凭据，REQUIRED 普通调用只允许 ACTIVE key。

明文仅短暂存在于受控请求和加解密/候选连接测试调用栈，不进入日志、trace、审计、响应、任务输入、浏览器持久状态或 Gate evidence。JavaScript string 无法保证清零，因此只承诺缩小持有范围、不缓存、不回显。所有异常服务端分类 SECRET_DECRYPT_FAILED；普通 API 映射为 CONFIG_ERROR，保留相同 requestId/traceId，不区分 keyId、AAD、tag 等失败细节。

## 生命周期与轮换

ACTIVE 可进入 DISABLED 或 REVOKED，DISABLED 可恢复 ACTIVE 或进入 REVOKED，REVOKED 无出口且 revokedAt 非空。修改 name/status 使用 expectedVersion 对比 revision，实际改变才递增；lastUsedAt/updatedAt 不充当 CAS。

encryptedKey 永不原地更新。常规轮换按管理契约创建 DISABLED 新行，经受控测试与全引用事务切换后撤销旧行；只有受保护候选测试可解密本次 DISABLED 候选，普通外呼仍仅接受 ACTIVE。紧急撤销立即拒绝新调用。Phase010 seed 不创建任何 ApiKeyConfig，不能将 bootstrap 环境 API key 复制成占位配置。

## Phase010 存储实现与消费边界

`src/server/api-key-envelope.ts` 首产 `parseApiKeyEnvelope`、`apiKeyFingerprint` 与 `apiKeyAad`，作为 Phase013 的共同输入边界。完整 envelope 最多22500 UTF-8 bytes；合法字段值全部为固定 ASCII 字面值、hex 或 base64，因此 SQL 可以按 `algorithm/ciphertext/iv/keyId/tag/version` 键序精确重建 JCS 并与原文本逐字节比较。数据库与 TypeScript 均拒绝空白/键序/转义的非规范序列化、重复或未知字段、版本类型错误、非标准 base64、padding/长度错误及列绑定不一致。AAD 的 JCS 键序为 `envelopeVersion/provider/recordId`，内容取当前行，不在 envelope 增加 AAD 字段。

数据库更新保护固定 `id/provider/encryptedKey/encryptionKeyId/envelopeVersion/keyFingerprint/createdAt`；重新命名或状态实际变化时 revision 恰加1，否则保持原值。REVOKED 必须且只有该状态具有 revokedAt，撤销后状态和时间均不可改变。name/lastUsedAt/updatedAt 的可更新性不允许覆盖秘密内容；受权命令的 expectedVersion 校验及审计由 Phase013 服务消费，不能仅依靠 trigger 替代授权。

本阶段实现的是存储格式、指纹/AAD 字节与数据库生命周期约束。parser 不解密，也不能证明 tag 来自正确主密钥；AES-GCM 加解密、随机 IV、KeyResolver、受保护候选测试、轮换服务及 API 安全投影须在 Phase013 实现并验收。Phase015 的 `secretRef` 直接引用现有 `ApiKeyConfig.id`；不另造 secret store。`credentialRequirement=NONE` 不解密且不发凭据，REQUIRED 的普通调用只解析 ACTIVE 行；这些治理模型与调用行为不由 Phase010 提前生产。验收范围见 [Phase010](phase010.md)。

## Phase013 加解密与生命周期实现

`src/server/security/secret-envelope.ts` 实现 server-only 的 `createKeyResolver`、`encryptSecret`、`decryptSecret` 和 `generateFingerprint`，复用既有 `api-key-envelope.ts` 的逐字段 schema、JCS AAD 与规范化规则。未知 keyId、错误主密钥、版本/算法/编码/长度/列绑定或认证标签统一抛出 `SecretDecryptError`；服务端映射为公开 CONFIG_ERROR，不暴露具体失败原因。新 ID 在加密前由服务端生成，IV 每次 CSPRNG 生成；数据库行与服务实际加解密均参与 round-trip 验证。

创建与轮换只保存 envelope 和去重所需 fingerprint。列表 SQL 直接派生短 display，安全 DTO 和持久化收据均拒绝额外秘密字段。React 不持有可复用的明文 state，提交后清空输入；响应丢失时重新输入同一正文并复用原幂等键。常规调用每次复核 ACTIVE；DISABLED 候选只允许归属本次已授权轮换的受控验证，未激活候选也不能通过普通 PATCH 启用。轮换保留历史密文，紧急撤销阻止后续新调用。

真实 Provider adapter 由 Phase015 首产并注册。当前默认零引用轮换仍验证候选 envelope；两引用合同使用隔离 PostgreSQL schema 与受保护 loopback HTTP，包含响应版本/hash、超时、重定向与失败原子性。实现和实际验收入口见 [Phase013](phase013.md)。

## 可执行规则与验证

<!-- contract:crypto-policy -->
```json
{
  "schemaVersion": 1,
  "producerPhase": 2,
  "envelopeFields": ["version", "keyId", "algorithm", "iv", "ciphertext", "tag"],
  "version": 1,
  "algorithm": "A256GCM",
  "serialization": "RFC8785_JCS_UTF8",
  "storage": "String @db.Text",
  "keyBytes": 32,
  "keyId": "SHA256_OF_ENCRYPTION_KEY_BYTES",
  "encoding": "CANONICAL_PADDED_BASE64",
  "ivBytes": 12,
  "tagBytes": 16,
  "ciphertextMinBytes": 1,
  "ciphertextMaxBytes": 16384,
  "aadFields": ["recordId", "provider", "envelopeVersion"],
  "freshRandomIv": true,
  "columnBindings": {"version": "envelopeVersion", "keyId": "encryptionKeyId"},
  "statuses": ["ACTIVE", "DISABLED", "REVOKED"],
  "transitions": {"ACTIVE": ["DISABLED", "REVOKED"], "DISABLED": ["ACTIVE", "REVOKED"], "REVOKED": []},
  "normalCallsRequire": "ACTIVE",
  "overwriteEncryptedKey": false,
  "fingerprintDisplayLength": 12,
  "internalError": "SECRET_DECRYPT_FAILED",
  "publicError": "CONFIG_ERROR"
}
```

`Phase002:api` 用隔离运行内生成的合成 key 执行 schema/base64/长度、AES-GCM 往返、AAD/密文/tag 篡改与状态终态 fixture；报告只记断言 ID 与结果，不归档 key、明文或 envelope。Phase013 仍须验证真正服务、数据库 round-trip、轮换并发和响应脱敏。
