# Phase014：SystemConfig、Dashboard 与 M3

本卡收口已实现的认证、用户、密钥、审计、配置与后台概览。授权止于014；不创建模型、Prompt、Provider 表，不运行 AI 或生产流量。完成状态以唯一 Gate、artifact/metadata 直接父子提交、双 shell seal 和远端同步为准。

实现与运维规则见 [管理指南](admin.md)。本卡复用全部八个迁移和 SystemConfig/AdminCommandReceipt，不修改 schema、历史迁移或 Phase010 seed。五组七个登记 key 中，原 seed 的三个 planner 默认值立即可管理；另外四个 key 需要受审 provisioning 才出现，GET/PATCH 不隐式创建数据。

| 固定场景 | 实际验收 |
| --- | --- |
| settings | 每 key schema、边界/空值/部署上限、真实读写、同时间戳 CAS、重启幂等、审计与收据回滚 |
| public-projection | 数据库标记与 registry 双重白名单、内部字段剔除、仅公开投影驱动 ETag/304 |
| dashboard | 四项聚合、真实空值、权限故障导致单项失败、真实断线与恢复、逐迁移/表缺失及漂移 |
| authorization | 匿名/USER/禁用管理员/旧或撤销会话/CSRF、持锁后的 actor 复核、五页键盘与375px |
| m3-regression | 当前全仓库与专用完整集合、历史 M3 链、四种隔离反向控制、真实生产构建与浏览器 |

业务分母固定5，全部必须通过；未授权写入、私有泄漏、丢失更新与成功写入缺审计均为0。Vitest 断言数、浏览器场景数和反向控制数另记，不能扩充业务分母。

冻结计划为 [Phase014.json](phase-plans/Phase014.json)，148份本地输入只记录路径/hash；两份执行政策及维护链单独绑定。`testMode=full` 的原因是 M3 里程碑、安全边界与共享组件变化。先完成诊断、类型/格式/路径、fixture与证据自检，再运行四个隔离故障删除、恢复后的专用命令及全仓库回归，发现集合与实际 file/fullName 集合必须完全一致、非零且无跳过。

执行入口：`node docs/phase-plans/setup-phase014.mjs --database`；`node docs/phase-plans/verify-phase014.mjs --precheck`；`node docs/phase-plans/verify-phase014.mjs --all`；最终独立 reviewer 绑定来源、原始报告和截图后，`node docs/phase-plans/complete-phase014.mjs --check` 验证候选。正式失败保留 attempt，修复后 `--retry` 创建下一 attempt，完整重验；跨 attempt 产品缓存保持 disabled。

只在 artifact 提交后运行 `node docs/phase-plans/complete-phase014.mjs --metadata`，形成唯一 Gate、run state 和完成日志，立即提交 metadata，再用 PowerShell5.1/7 执行 `scripts/validate-phase.ps1 -CompletedThrough 14 -Strict -Json`。测试均使用任务专属 PostgreSQL17、锁定 Chromium 和合成身份，秘密仅保留在忽略区；真人读屏体验未评估。命令、耗时、断言映射、诊断/失败及独立复核保存在 [本卡证据目录](evidence/attempts/Phase014/)。
