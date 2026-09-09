# Serendipity · 际遇 运行与恢复边界契约

Owner: 运行环境与恢复；producerPhase: 2；消费者: Phase016、Phase084、Phase119–126。本文件冻结部署拓扑、配置来源、持久边界与恢复门槛，当前不创建 Dockerfile、Compose、数据库或环境文件。运行技术见 [技术栈](tech-stack.md)，任务字段见 [数据库规范](database.md)，公开接口见 [API](api.md)，网络安全见 [Provider](travel-data-provider-strategy.md)，隐私水位见 [隐私契约](privacy-and-user-data.md)。来源与 SHA-256 见 [输入清单](phase-plans/Phase002-inputs.json)。

## 进程与持久存储

Phase119 的应用拓扑固定为 web + worker + postgres，另接 Phase084 首产的独立 privacy-ledger PostgreSQL 数据库/卷/备份集。web/worker 使用同一不可变应用 image digest；worker 运行 Phase016 已实现的真实任务入口。PostgreSQL 17 同时承担业务事务、DurableTask、Outbox、租约/fencing 和幂等协调，不引入 Redis 或第二队列权威。

应用库与 ledger 库不能是同一 database 的两个 schema，也不能共用卷或恢复集合。PRIVACY_LEDGER_DATABASE_URL 是 Phase084 的 server/worker/recovery secret，必须由统一环境 registry/parser 登记；本文件不产生配置值。受控恢复角色具有最小擦除/重放权限，Web 普通角色不能修改 append-only 账本或执行历史清理。

正式版本引用的 Requirement/Fact/Workspace 快照与版本同保留期；普通缓存过期不得删这些内容。TaskPayload 保存受控加密输入而非仅 checksum，版本、未消费确认/pendingOverrides、未完成 ERASE 意图所需输入不随任务终态 TTL 清除。对象存储的删除使用 tombstone/outbox 与幂等对账，不能声称跨库/对象原子事务。

## 版本与配置

启动精确 Node 24.19.0、npm 11.7.0、Next.js 15.5.24 与 manifest.runtimePolicy 一致。Phase119 才固定基础镜像完整 tag/digest、SBOM/hash、Prisma runtime 与内置中文字体；当前不写虚构镜像 digest。构建使用 package-lock.json 与 npm ci，runtime 非 root，只有声明的临时目录可写。镜像层排除密钥、.env、开发文档、上传/导出、数据库 dump、日志、测试产物与机器缓存。

Web 启动不隐式 migrate、seed 或调用外部 Provider。迁移与 seed 是分别授权、显式执行的 CLI 阶段，失败不启用新流量。环境变量构成不可动态突破的硬上限；类型化 SystemConfig 只在其内调节非秘密运行配置，Prompt/模型/Provider/策略从激活的不可变治理版本读取。更改范围与测试按各首次消费者契约完成。

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
