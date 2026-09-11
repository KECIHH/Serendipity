# Serendipity · 际遇 运行与恢复边界契约

Owner: 运行环境与恢复；producerPhase: 2；消费者: Phase016、Phase084、Phase119–126。本文件冻结部署拓扑、配置来源、持久边界与恢复门槛，当前不创建 Dockerfile、Compose、数据库或环境文件。运行技术见 [技术栈](tech-stack.md)，任务字段见 [数据库规范](database.md)，公开接口见 [API](api.md)，网络安全见 [Provider](travel-data-provider-strategy.md)，隐私水位见 [隐私契约](privacy-and-user-data.md)。来源与 SHA-256 见 [输入清单](phase-plans/Phase002-inputs.json)。

## 进程与持久存储

Phase119 的应用拓扑固定为 web + worker + postgres，另接 Phase084 首产的独立 privacy-ledger PostgreSQL 数据库/卷/备份集。web/worker 使用同一不可变应用 image digest；worker 运行 Phase016 已实现的真实任务入口。PostgreSQL 17 同时承担业务事务、DurableTask、Outbox、租约/fencing 和幂等协调，不引入 Redis 或第二队列权威。

应用库与 ledger 库不能是同一 database 的两个 schema，也不能共用卷或恢复集合。PRIVACY_LEDGER_DATABASE_URL 是 Phase084 的 server/worker/recovery secret，必须由统一环境 registry/parser 登记；本文件不产生配置值。受控恢复角色具有最小擦除/重放权限，Web 普通角色不能修改 append-only 账本或执行历史清理。

正式版本引用的 Requirement/Fact/Workspace 快照与版本同保留期；普通缓存过期不得删这些内容。TaskPayload 保存受控加密输入而非仅 checksum，版本、未消费确认/pendingOverrides、未完成 ERASE 意图所需输入不随任务终态 TTL 清除。对象存储的删除使用 tombstone/outbox 与幂等对账，不能声称跨库/对象原子事务。

## 版本与配置

启动精确 Node 24.19.0、npm 11.7.0、Next.js 15.5.24 与 manifest.runtimePolicy 一致。Phase119 才固定基础镜像完整 tag/digest、SBOM/hash、Prisma runtime 与内置中文字体；当前不写虚构镜像 digest。构建使用 package-lock.json 与 npm ci，runtime 非 root，只有声明的临时目录可写。镜像层排除密钥、.env、开发文档、上传/导出、数据库 dump、日志、测试产物与机器缓存。

Web 启动不隐式 migrate、seed 或调用外部 Provider。迁移与 seed 是分别授权、显式执行的 CLI 阶段，失败不启用新流量。环境变量构成不可动态突破的硬上限；类型化 SystemConfig 只在其内调节非秘密运行配置，Prompt/模型/Provider/策略从激活的不可变治理版本读取。更改范围与测试按各首次消费者契约完成。

### Phase010 配置优先级与基础 seed

配置按来源职责解析：先执行统一 env registry/parser 的部署约束与安全护栏，再接受其范围内的类型化 SystemConfig 运行值；任何 DB 配置、默认值或未来治理激活均不能扩大环境允许的能力、时限或成本上限。seed 默认值只在首次缺项时持久化，不能作为覆盖已有配置的更高优先级来源；越界/不合法的配置由首次消费服务拒绝，不能静默绕过护栏。本阶段只初始化三项内部 GENERAL 默认值，具体 key/value 见 [数据库规范](database.md#seed-执行规则)，尚不实现它们的规划消费者。

Phase015 起，Prompt、模型、Provider 与规划策略以已激活的不可变版本为调用权威，凭据通过 `secretRef=ApiKeyConfig.id` 解析；环境护栏仍先于调用。`AI_API_KEY/AI_BASE_URL/AI_MODEL` 当前保留为早期 bootstrap 契约，Phase015 才退役为历史 test fixture，不能由 Phase010 seed 导入治理表或密钥行。Phase010 也不提前创建治理默认版本、激活指针或 AI 开关记录。

`npm run db:seed` 只通过 `readSeedEnv` 消费 `NODE_ENV/DATABASE_URL` 与 command=seed 的 `ADMIN_EMAIL/ADMIN_INITIAL_PASSWORD`；后两项为 CLI scope，不进入 `.env.example`，Web 启动不要求它们。密码及数据库凭据只放命令环境或被忽略的 `.scaffold/` 受控准备文件，不进入源码、镜像、Git、命令回显或证据。基础 seed 不需要 `AUTH_SECRET/ENCRYPTION_KEY` 或 Provider 凭据，生产环境无条件拒绝。

目标 URL 必须使用 postgresql 协议、精确 `127.0.0.1` 和显式端口；数据库名为 `(phaseNNN|serendipity)_disposable_<12位小写hex>`，可加下划线后的 fixture 后缀。数据库 comment 必须精确匹配 `serendipity-<phaseNNN|serendipity>-disposable:<同一12位标识>`；仅名称匹配不足以授权写入。URL 不允许 fragment，查询参数仅允许各一次的 connect_timeout/pool_timeout/connection_limit，值为1–999。连接后还须确认实际数据库/当前角色、PostgreSQL17、角色非数据库 owner/非 superuser 且无建库、建角色、replication 或 bypass RLS 权限；已应用迁移名称、checksum、完成与未回滚状态须和工作树全部迁移精确一致。

当前隔离验收使用任务独占 PostgreSQL17 tmpfs、受控网络和分离的迁移/运行角色；迁移使用迁移角色，seed 只使用最小权限运行角色。目标不明、环境不符、输入无效、来源冲突、迁移漂移及审计失败均非零退出，输出固定错误分类而不回显邮箱、口令、数据库 URL、原始数据库错误或密文。该 disposable 执行边界不构成生产初始化方式；生产部署/恢复仍由其生产阶段实现。

## 网络、任务与恢复

本路线运行环境为 ISOLATED_SYNTHETIC。准备阶段可下载公开制品并固定 hash，运行阶段只用受控 HTTP/record-replay，真实 Provider 调用与生产流量为零。外部调用经过 Provider SSRF/许可/时限/预算边界，在数据库提交事务外执行；任务 claim/heartbeat/提交均检查 lease 与 fencingToken，不声称至少一次任务投递可以保证网络外呼恰好一次。

恢复时先停止对外流量、读取独立 ledger 当前水位，再重放 ERASE、CONSENT_WITHDRAWAL、SESSION_REVOKE、SHARE_REVOKE、PUBLICATION_REVOKE、MEDIA_REVOKE 和 KILL_DISABLE，完成应用正文/快照/缓存/对象删除与撤权投影后验证。水位缺失、回退或无法证明投影已追上时 readiness=false；旧备份不能把已擦除主体、公开授权或 kill switch 恢复为有效。仅轮换 token 不能代替正文删除。

持久 kill switch 不因 TTL、进程重启或缓存刷新自动开启；只有显式受审恢复命令可解除。ERASE 技术错误保持 DataRequest RUNNING，由原意图与 continuationSequence 幂等续接，不重开失败 task，也不要求被擦除主体重新认证。发布只得到 LOCAL_RELEASE_READY；本卡不表示已部署、已恢复或已验证生产资格。

## 可执行规则与验证

<!-- contract:hosting-policy -->
```json
{
  "schemaVersion": 1,
  "producerPhase": 2,
  "implementationPhases": [16, 84, 119, 120, 121, 122, 123, 124, 125, 126],
  "applicationServices": ["web", "worker", "postgres"],
  "privacyService": "privacy-ledger",
  "coordinationAuthority": "POSTGRESQL",
  "externalQueue": "ABSENT",
  "postgresMajor": 17,
  "runtime": {"node": "24.19.0", "npm": "11.7.0", "next": "15.5.24"},
  "images": {"sameWebWorkerDigest": true, "immutableDigest": true, "nonRoot": true, "implicitMigrate": false, "implicitSeed": false, "providerCallsAtBoot": false},
  "privacyStorage": {"separateDatabase": true, "separateVolume": true, "separateBackupSet": true, "environmentKey": "PRIVACY_LEDGER_DATABASE_URL", "firstProducerPhase": 84},
  "restoration": {"stopTrafficFirst": true, "requireCurrentLedgerWatermark": true, "replayBeforeReadiness": true, "objectsMustBeReconciled": true, "tokenRotationReplacesErasure": false, "killAutomaticallyResumes": false},
  "environment": "ISOLATED_SYNTHETIC",
  "productionTraffic": false,
  "releaseQualification": "LOCAL_RELEASE_READY"
}
```

验收归属 `Phase002:provider`：对共享 database/卷/备份集、缺失或回退水位、对象未清理、不同 web/worker digest 和未知队列的合成拓扑分别拒绝。fixture 只解释文档配置，不声称运行了 Docker/PostgreSQL。真实部署与恢复验证由上述实现阶段执行。
