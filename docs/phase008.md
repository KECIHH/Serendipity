# Phase008 TravelRecord 与 ChatMessage 数据层

本阶段建立旅行聚合所有权和有序聊天历史。冻结输入见 `docs/phase-plans/Phase008-inputs.json`，固定8项验收见 `docs/phase-plans/Phase008.json`；用户授权止于008。

## 持久模型

`TravelRecord` 的 `userId` 与 `anonTokenHash` 恰有一项非空，数据库 XOR CHECK 直接拒绝两空和两非空。匿名凭据只通过服务端工具转换为64字符小写 SHA-256，原文不写入数据库、日志和证据。User 外键使用 Restrict。状态精确包含七个登记值，默认 DRAFT；version 默认0且非负。查询索引分别覆盖用户、匿名hash和状态的稳定列表顺序。

`ChatMessage` 使用 `(travelRecordId, sequence)` 唯一顺序和正整数 CHECK，同毫秒消息仍可确定排序。非空 `(travelRecordId, clientMessageId)` 唯一，null 可以重复。TravelRecord purge 级联其消息；回复外键保留存在性，目标删除置空。同记录回复由事务边界验证。迁移只新增两个表及 TravelStatus、MessageRole、ChatMessageKind 三个明确要求的枚举，不新增 AI、命令账或计划版本模型。

迁移目录保留 Prisma 实际生成时间戳，SQL及生成回执见 `docs/evidence/attempts/Phase008/setup/migration-generation.json`。四个 CHECK 在首次应用前加入，既有 User/SystemConfig 迁移保持原字节。生成回执同时绑定原始 SQL 和最终 SQL，所有验收报告与最终 Gate 另绑定真实迁移文件。

## 服务端持久边界

Owner 参数是互斥联合，所有权来自已验证的服务端身份。匿名工具消费已验证 Cookie 中 canonical base64url 编码的32字节随机值，对该 Cookie 原文的 UTF-8 字节计算 SHA-256。Cookie 发行、签名验证和会话解析按后续生产卡接入，本阶段不创建 HTTP 入口。

创建与读取记录均验证明确 owner。匿名转移 helper 在同一记录锁和事务内比较当前匿名归属，然后同时设置 userId、清空 hash；这是持久层原语，完整登录合并、匿名凭据消费及 alias/tombstone 由 Phase082 提供。

消息写入由调用方提供显式 sequence，本卡没有序号分配服务。事务先锁定记录并复核归属，再校验回复、处理重试和写入。相同 clientMessageId 的相同 role/kind/content/contentJson/reply payload 重放原行；异 payload 返回安全冲突。服务生成的 id、createdAt 和 sequence 不属于客户端 payload。原始数据库错误不会被伪装为空列表，普通 repository 不暴露单条消息删除。

读取顺序是 sequence ASC。内部游标编码 record/sequence/id，验证格式、当前owner和持久锚点，分页不会仅依靠 createdAt。它不作为公开 HTTP Cursor；后续 conversation API 按 API 契约添加签名、筛选和读取水位。

## JSON 与后续生产边界

需求 Schema 文档已经冻结，完整运行时验证器首次由 Phase017 生产。因此008的 repository 只接受 absent/null requirementJson 和 TEXT contentJson；非空 JSON、STRUCTURED 消息在 SQL 前拒绝。未实现的 Schema 不用 permissive callback 或“已校验”标记替代。数据库 JSON 可空及结构往返仅在受控合成 schema fixture 中验证，不代表产品入口允许未校验写入。

Phase016 生产命令账和序号分配，Phase025 生产正式版本正文、current/final 指针及 requirementRevision。七状态的枚举往返只验证存储，不宣称已实现生命周期转换服务。

## 自动验收与复现

先运行 `node docs/phase-plans/setup-phase008.mjs --database`，该命令创建带阶段/run 标签、loopback 端口和数据库 marker 的 PostgreSQL 17 tmpfs 容器。连接信息仅保留在忽略目录 `.scaffold/phase008/`。正式 runner 注入 `PHASE008_DATABASE_URL` 并验证实际数据库名、marker和版本；普通 Vitest 无此变量时显式跳过实库组。

`node docs/phase-plans/verify-phase008.mjs --case lifecycle-version` 应用并检查迁移、生成 Client、从旧两模型重放并验证数据保留。其余固定 case 依计划逐项执行，`--quality` 运行全量 Vitest、相关上游实库回归、lint、typecheck、build、格式、目录、网络和证据协议检查。每个 fixture 记录自己的精确 ID 并按 ID 清理，另验证并发 fixture 与哨兵互不影响。

SQL mutation 只作用于临时副本和独立数据库，分别移除 owner CHECK、sequence unique 和 clientMessageId unique。对应原负例必须实际失败，恢复后重跑通过。任何失败保留在本阶段独立 attempt，重试不覆盖历史证据或缩减断言。完整验收与独立 Agent 复核后执行 artifact/metadata 双提交、PowerShell 5.1/7 seal，再推送并核对 GitHub。
