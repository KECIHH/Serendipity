# 旅行事实 Provider 策略

本文件是 Phase002 首产的唯一 Provider 策略，owner 为本文件；规则机器块与正文一起构成契约。后续实现按 [数据库规范](database.md)、[旅行 Schema](travel-plan-schema.md) 与 [API 契约](api.md) 消费字段，不新增第二套来源或状态。运行拓扑、安全配置和独立隐私水位见 [托管规范](hosting.md)，数据外发与日志边界见 [隐私规范](privacy-and-user-data.md)。

本阶段只冻结文档。没有发起 Provider 请求、安装依赖、创建适配器、数据库或应用接口；下面的网络案例仅把合成地址作为纯函数输入。真实适配器/合同服务/数据库验收分别由 Phase028–031 生产，当前 evaluationApproved=false、productionApproved=false，不把文档测试作为服务条款批准或生产可用证据。

## 来源与后续责任

路线包输入只保存规范化绝对路径与 SHA-256，列在规则块 sources，必须与 [Phase002 输入清单](phase-plans/Phase002-inputs.json) 相符；不复制本地开发文档正文。固定输入与目录优先级见 [执行契约](agent-execution-contract.md)。

| 阶段 | 唯一责任 |
|---|---|
| 028 | TravelDataProvider/ProviderRegistry/FactQuery 与受控 ManualEvidence，冻结类型和三条 Beta 包 |
| 029 | Nominatim-compatible、OSRM-compatible、Open-Meteo 只读适配器与解析 |
| 030 | FactSnapshot 持久化、CacheEnvelope、DNS/redirect 安全 client、PostgreSQL lease/fencing |
| 031 | 四类来源的完整合规 profile、三场景隔离合同回放与能力结论 |
| 032–043 | 消费可信事实，确定性地生成地点、交通、天气与计划；不能直连未登记源 |
| 092–093 | 演进既有 Provider/PlanningPolicy 不可变版本与激活指针 |
| 107–110 | 演进缓存存储/协调/一致 freshness 展示；不重建事实权威 |

## 五种独立状态

FactStatus 回答单条事实是否有可追溯证据；FactFreshness 是绑定 checkedAt/freshnessPolicyVersion 的时间判断；ProviderAvailability 仅描述这次请求；CapabilityStatus 描述长期能力覆盖；CacheEnvelope.state 描述缓存服务。枚举可以有相同拼写的值，但字段和类型不能互换。超时只改变本次 availability/errorCategory，不能把能力改为 unsupported；无能力不是事实 unknown 的同义词。

非 unknown 事实的 sourceRefs 在同一 snapshot 中可解析，fetchedAt 为原始采集时间，confidence 经确定性规则计算；unknown 必须 value/unit/fetchedAt/validFrom/validUntil/conflictGroup=null、sourceRefs=[]、confidence=0，freshness.status=unknown 且保留检查时间/策略版本。冲突保留各项证据并绑定同一 conflictGroup；其他状态的 conflictGroup=null。AI 不能写事实、来源、坐标、confidence、状态或保存资格。

## 能力、许可与准入

规则块的四个 profile 是实现蓝图，endpoint/许可证证据尚未产出时保持关闭。capabilities 声明接口边界，不代表该服务已经可用。每个实际 config 必須补齐条款/许可证证据 hash、适用范围、核验时间、attribution、缓存与再展示许可、地域/语言、配额、成本、TTL/maxStale 和 machineAdmissionRuleVersion，机器准入缺任意项即 BLOCK。NONE 必须 secretRef=null 且禁止发送凭据；REQUIRED 必须引用 ACTIVE key。无密钥不等于没有条款/配额约束。

Nominatim 与 OSRM 公共演示端点不成为生产默认值；底层数据许可与软件许可分开核对。Open-Meteo 的免费/付费及具体端点条款分别核对。ManualEvidence 的单条证据还须具备来源机构、受控录入者标识、核验时间、适用对象/日期/有效期、摘要和许可；录入者由隔离合成主体提供，不编造真人审批。没有 URL 时允许真实受控 sourceLocator+contentHash，不伪造公网 URL。相同资源、URL 或 locator/hash 去重，不能重复算独立证据。

三条 Beta 场景固定为黄山两天一晚、江西上饶、周末深圳到武功山，每包覆盖规则列出的七项最小内容。ManualEvidence 之外不承诺中国住宿/餐饮/景点运营全国覆盖；只给名称不构成具体 property/venue/attraction 证据。OSRM 道路时间不能代替高铁、公交或景区接驳班次，也不能直接作为 canonical RouteLeg。缺关键来源时 precise 阻断；quick 只能在版本化策略允许时显示已有来源的 area/dish/unknown，未知交通限 order_only，不能确认执行或导航。

## 查询、网络与资源上限

Registry 是唯一业务入口；query 只读，不接受 URL、endpoint、Provider 私有 ID 或 AI 猜测的精确事实。文本按 NFC/去首尾空白/合并空白规范化，保留目的地顺序；locale、日期、IANA zone、批量、单位和坐标范围逐分支验证。道路/天气坐标仅来自可证明的公共地理编码或受控公共数据库，敏感需求和私人坐标不进当前共享缓存或外部查询。其余 capability 的 subject 查询由 028 按同一封闭 FactQuery 派生，不能以任意 JSON/URL 作为临时分支。

只允许配置白名单 HTTPS host/port、固定 path/query 模板和 GET。每次 DNS 的全部地址均验证，连接锁定已验证地址并核对实际 peer；每次重定向重新解析 host、DNS、协议、端口、路径和所有限制。拒绝 userinfo、fragment、私网/保留网段、metadata、IPv4/IPv6 混淆与非 HTTP(S)；TLS 校验不能关闭。redirect 默认不自动跟随，不能跨跳携带秘密。受控 loopback HTTP 例外要求 ISOLATED_SYNTHETIC、精确 inventory 地址/端口且 peer 一致，不能推广到其他私网或真实生产。

连接/总 deadline、有限重试与抖动退避、Retry-After 上限、并发、每秒速率、每日请求/成本配额、压缩前后响应大小和 content type 同时执行。只对已声明暂时错误重试；security/schema/配置错误不重试。配额在跨实例账本先预留；可能计费的重试另占额度，未知账单保持占额并对账，不因 TTL 释放。熔断按固定窗口/失败次数开放，冷却后只准单探针；不把熔断内部态写成新的 ProviderAvailability。所有数字来自被冻结的版本化配置，下面数值仅用于本阶段离线文档 fixture，不能作为生产批准。

## 缓存、版本与降级

每次调用冻结 ProviderConfigVersion 与 schema/normalizer/freshness/resolution policy 的精确版本；fallback 保留实际来源与版本。cache key 纳入全部语义参数，不含 secret/user/trace/run；敏感输入或许可禁止共享时绕过公共缓存。value/payloadRef 恰一，payloadRef 不指向他人的 FactSnapshot。命中先验证许可、版本、hash 和安全期限，再按当前 plannerRunId+collectionAttemptId 物化独立不可变快照；同 attempt 重试复用本 run 的同一快照，不同 run/refresh 创建新 ID。版本引用的 blob 不随缓存淘汰。

expiresAt=min(fetchedAt+TTL,来源有效期,许可缓存截止)，staleUntil=min(fetchedAt+TTL+maxStale,来源有效期,许可缓存截止)。到边界即拒绝复用；refreshAfter 抖动只能提前刷新。缓存过期不能延长事实有效期，错误/空结果不能无限缓存。使用 stale fallback 时仅新快照将事实固定为 stale，保留原 fetchedAt/sourceRefs；历史快照和 generatedFreshness 不修改。currentFreshness 对同一历史快照按新的 checkedAt/实际策略只读计算，不能拿当前缓存 value 替换历史事实。

所有 Provider 失败时记录 availability/errorCategory 与 unknown，不补造票价、班次、营业时间、geometry 或坐标。正式保存仍由统一质量闸门决定，失败不生成正常版本或修改 TravelRecord。日志仅保留安全 provider/capability/latency/resultCount/cacheState/trace/version/error 字段；原始响应、完整 query、凭据和私人数据禁止进入日志/notes/API。

## 可执行文档规则

<!-- contract:provider-policy -->
```json
{
  "contractVersion": "phase002.provider.v1",
  "owner": "docs/travel-data-provider-strategy.md",
  "producerPhase": 2,
  "implementationStatus": "NOT_CREATED",
  "consumers": [
    28,
    29,
    30,
    31,
    32,
    33,
    34,
    35,
    36,
    37,
    38,
    39,
    40,
    41,
    42,
    43,
    92,
    93,
    107,
    108,
    109,
    110
  ],
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
      "id": "Phase028",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/Phase028.md",
      "sha256": "8fc942cc64dbbaa11816a81e874c8b09d61068df8a951e9ac797f0700c2ebd9f"
    },
    {
      "id": "Phase029",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/Phase029.md",
      "sha256": "e32eb21dc2db2a214fc72937bcd7cb9905ab8ee227ea5c1bf3a73d3b95aea934"
    },
    {
      "id": "Phase030",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/Phase030.md",
      "sha256": "a9f1ab2645b3b43dd4b33a815855dad16007e3525ac44c26981eb49b28cedabb"
    },
    {
      "id": "Phase031",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/Phase031.md",
      "sha256": "d275178419b7004647537fd8aa51c37a8ae297d070587c84cfa23e57c371bfa5"
    },
    {
      "id": "Phase092",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/Phase092.md",
      "sha256": "901425bc98988ff18c3b45dda0697a067f9b2843e2b9162e47d8ee1f30d077eb"
    },
    {
      "id": "Phase093",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/Phase093.md",
      "sha256": "1215e671ead655373907f155163708f0894c164c8310af0bfe4295c7a768a8f9"
    },
    {
      "id": "Phase107",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/Phase107.md",
      "sha256": "691069b060a30d8e2bc22fbb29fea0af320ea96c39358b3e0d1bd47f9c26de70"
    },
    {
      "id": "Phase108",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/Phase108.md",
      "sha256": "d06ba9898d30b91a98a45d6544efc51817e851bef751f012a056c47b43a78966"
    },
    {
      "id": "Phase109",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/Phase109.md",
      "sha256": "52f0c7bc5f3c7e82f43a26ec34502b6eb4bc0656f98d5e436ca75f629b4fb2d4"
    },
    {
      "id": "Phase110",
      "sourceAbsolutePath": "C:/Users/11295/Desktop/Serendipity · 际遇/Serendipity · 际遇/Phase110.md",
      "sha256": "5b9541086698281f4c626883f07727ea84a2b1b2fcaa7033890c16d7931df60d"
    }
  ],
  "domains": {
    "FactStatus": [
      "verified",
      "estimated",
      "unknown",
      "conflicting",
      "stale"
    ],
    "FactFreshness": [
      "fresh",
      "aging",
      "stale",
      "expired",
      "unknown"
    ],
    "ProviderAvailability": [
      "available",
      "degraded",
      "unavailable"
    ],
    "CapabilityStatus": [
      "supported",
      "partial",
      "unsupported"
    ],
    "CacheEnvelope.state": [
      "fresh",
      "stale_revalidating",
      "stale_fallback",
      "expired",
      "unavailable"
    ]
  },
  "domainFields": {
    "FactStatus": "fact.status",
    "FactFreshness": "fact.freshness.status",
    "ProviderAvailability": "provider.availability",
    "CapabilityStatus": "capability.coverage",
    "CacheEnvelope.state": "cache.state"
  },
  "capabilityIds": [
    "manual_evidence",
    "place_search",
    "geocoding",
    "road_route",
    "road_matrix",
    "weather_forecast",
    "weather_seasonal",
    "lodging_candidates",
    "attraction_candidates",
    "food_dish",
    "food_area",
    "food_venue",
    "opening_hours",
    "public_cost",
    "reservation_requirements",
    "static_transit",
    "high_speed_rail_schedule",
    "flight_schedule",
    "city_bus_schedule",
    "scenic_shuttle_schedule",
    "realtime_inventory",
    "live_traffic"
  ],
  "profiles": [
    {
      "providerId": "controlled-static-evidence",
      "firstConsumer": 28,
      "credentialRequirement": "NONE",
      "secretRef": null,
      "capabilities": {
        "manual_evidence": "supported",
        "place_search": "unsupported",
        "geocoding": "unsupported",
        "road_route": "unsupported",
        "road_matrix": "unsupported",
        "weather_forecast": "unsupported",
        "weather_seasonal": "unsupported",
        "lodging_candidates": "partial",
        "attraction_candidates": "partial",
        "food_dish": "partial",
        "food_area": "partial",
        "food_venue": "partial",
        "opening_hours": "partial",
        "public_cost": "partial",
        "reservation_requirements": "partial",
        "static_transit": "partial",
        "high_speed_rail_schedule": "unsupported",
        "flight_schedule": "unsupported",
        "city_bus_schedule": "unsupported",
        "scenic_shuttle_schedule": "unsupported",
        "realtime_inventory": "unsupported",
        "live_traffic": "unsupported"
      },
      "endpoint": null,
      "environment": "ISOLATED_SYNTHETIC",
      "licenseEvidence": null,
      "attribution": null,
      "cachePermission": false,
      "redistributionPermission": false,
      "evaluationApproved": false,
      "productionApproved": false,
      "limitation": "只覆盖三条受控 Beta evidence package；具体物业/餐馆/景点逐属性有来源才可用。"
    },
    {
      "providerId": "nominatim-compatible",
      "firstConsumer": 29,
      "credentialRequirement": "NONE",
      "secretRef": null,
      "capabilities": {
        "manual_evidence": "unsupported",
        "place_search": "supported",
        "geocoding": "supported",
        "road_route": "unsupported",
        "road_matrix": "unsupported",
        "weather_forecast": "unsupported",
        "weather_seasonal": "unsupported",
        "lodging_candidates": "unsupported",
        "attraction_candidates": "unsupported",
        "food_dish": "unsupported",
        "food_area": "unsupported",
        "food_venue": "unsupported",
        "opening_hours": "unsupported",
        "public_cost": "unsupported",
        "reservation_requirements": "unsupported",
        "static_transit": "unsupported",
        "high_speed_rail_schedule": "unsupported",
        "flight_schedule": "unsupported",
        "city_bus_schedule": "unsupported",
        "scenic_shuttle_schedule": "unsupported",
        "realtime_inventory": "unsupported",
        "live_traffic": "unsupported"
      },
      "endpoint": null,
      "environment": "ISOLATED_SYNTHETIC",
      "licenseEvidence": null,
      "attribution": null,
      "cachePermission": false,
      "redistributionPermission": false,
      "evaluationApproved": false,
      "productionApproved": false,
      "limitation": "仅地点身份/坐标证据；不提供候选排名、运营、营业、价格或设施事实。"
    },
    {
      "providerId": "osrm-compatible",
      "firstConsumer": 29,
      "credentialRequirement": "NONE",
      "secretRef": null,
      "capabilities": {
        "manual_evidence": "unsupported",
        "place_search": "unsupported",
        "geocoding": "unsupported",
        "road_route": "supported",
        "road_matrix": "supported",
        "weather_forecast": "unsupported",
        "weather_seasonal": "unsupported",
        "lodging_candidates": "unsupported",
        "attraction_candidates": "unsupported",
        "food_dish": "unsupported",
        "food_area": "unsupported",
        "food_venue": "unsupported",
        "opening_hours": "unsupported",
        "public_cost": "unsupported",
        "reservation_requirements": "unsupported",
        "static_transit": "unsupported",
        "high_speed_rail_schedule": "unsupported",
        "flight_schedule": "unsupported",
        "city_bus_schedule": "unsupported",
        "scenic_shuttle_schedule": "unsupported",
        "realtime_inventory": "unsupported",
        "live_traffic": "unsupported"
      },
      "endpoint": null,
      "environment": "ISOLATED_SYNTHETIC",
      "licenseEvidence": null,
      "attribution": null,
      "cachePermission": false,
      "redistributionPermission": false,
      "evaluationApproved": false,
      "productionApproved": false,
      "limitation": "仅部署 road profile 的道路原始事实；不能生成 canonical RouteLeg、高铁、航班、公交、景区接驳或实时交通。"
    },
    {
      "providerId": "open-meteo",
      "firstConsumer": 29,
      "credentialRequirement": "NONE",
      "secretRef": null,
      "capabilities": {
        "manual_evidence": "unsupported",
        "place_search": "unsupported",
        "geocoding": "unsupported",
        "road_route": "unsupported",
        "road_matrix": "unsupported",
        "weather_forecast": "supported",
        "weather_seasonal": "supported",
        "lodging_candidates": "unsupported",
        "attraction_candidates": "unsupported",
        "food_dish": "unsupported",
        "food_area": "unsupported",
        "food_venue": "unsupported",
        "opening_hours": "unsupported",
        "public_cost": "unsupported",
        "reservation_requirements": "unsupported",
        "static_transit": "unsupported",
        "high_speed_rail_schedule": "unsupported",
        "flight_schedule": "unsupported",
        "city_bus_schedule": "unsupported",
        "scenic_shuttle_schedule": "unsupported",
        "realtime_inventory": "unsupported",
        "live_traffic": "unsupported"
      },
      "endpoint": null,
      "environment": "ISOLATED_SYNTHETIC",
      "licenseEvidence": null,
      "attribution": null,
      "cachePermission": false,
      "redistributionPermission": false,
      "evaluationApproved": false,
      "productionApproved": false,
      "limitation": "forecast 受窗口限制，seasonal 不能冒充确定日期预报；不证明道路或景区开放。"
    }
  ],
  "admission": {
    "required": [
      "providerId",
      "configVersion",
      "endpoint",
      "environment",
      "licenseEvidence",
      "attribution",
      "cachePermission",
      "redistributionPermission",
      "limits",
      "regions",
      "locales",
      "machineAdmissionRuleVersion",
      "evaluationApproved",
      "productionApproved",
      "credentialRequirement",
      "secretRef"
    ],
    "productionApproved": false,
    "publicDemoProductionDefault": false,
    "missingRuleAction": "BLOCK",
    "noneForbidsCredential": true,
    "requiredNeedsActiveKey": true,
    "licenseEvidenceFields": [
      "id",
      "contentHash",
      "termsScope",
      "checkedAt",
      "cacheMaxAgeSeconds",
      "redistributionAllowed"
    ]
  },
  "request": {
    "commonRequired": [
      "queryType",
      "normalizedName",
      "locale"
    ],
    "commonOptional": [
      "country",
      "placeHint"
    ],
    "nameNormalization": [
      "NFC",
      "TRIM",
      "COLLAPSE_WHITESPACE"
    ],
    "nameMaxCharacters": 200,
    "allowedLocales": [
      "zh-CN",
      "en-US"
    ],
    "maxLimit": 10,
    "maxCoordinates": 8,
    "maxForecastDays": 16,
    "privateCoordinatesAllowed": false,
    "coordinateAuthority": [
      "TRUSTED_PUBLIC_GEOCODER",
      "CONTROLLED_PUBLIC_DATABASE"
    ],
    "forbiddenKeys": [
      "url",
      "endpoint",
      "baseUrl",
      "scheme",
      "host",
      "port",
      "path",
      "providerPlaceId",
      "price",
      "openingHours",
      "schedule",
      "userId",
      "email",
      "phone",
      "password",
      "token"
    ],
    "branches": {
      "place_search": {
        "required": [
          "limit"
        ],
        "optional": []
      },
      "geocoding": {
        "required": [
          "limit"
        ],
        "optional": []
      },
      "road_route": {
        "required": [
          "coordinates",
          "roadProfile"
        ],
        "optional": []
      },
      "road_matrix": {
        "required": [
          "coordinates",
          "roadProfile"
        ],
        "optional": []
      },
      "weather_forecast": {
        "required": [
          "coordinates",
          "timeZone",
          "dateRange"
        ],
        "optional": []
      },
      "weather_seasonal": {
        "required": [
          "coordinates",
          "timeZone",
          "month"
        ],
        "optional": []
      },
      "manual_evidence": {
        "required": [
          "subjectRef",
          "factTypes"
        ],
        "optional": []
      }
    },
    "otherCapabilities": "CONTROLLED_SUBJECT_LOOKUP_BY_REGISTERED_PROVIDER_ONLY",
    "allowedRoadProfiles": [
      "driving"
    ],
    "coordinateFields": [
      "lat",
      "lng",
      "authority",
      "sourceRef"
    ]
  },
  "transport": {
    "readOnlyMethods": [
      "GET"
    ],
    "schemes": [
      "https:"
    ],
    "allowlistHosts": [
      "provider.fixture.invalid"
    ],
    "ports": [
      443
    ],
    "allowedPaths": [
      "/facts"
    ],
    "allowedQueryKeys": [
      "q",
      "locale",
      "limit"
    ],
    "maxRedirects": 2,
    "revalidateEveryDnsAnswer": true,
    "revalidateEveryRedirect": true,
    "pinConnectionAddress": true,
    "verifyConnectedPeer": true,
    "allowUserinfo": false,
    "allowFragment": false,
    "followRedirectAutomatically": false,
    "dropCredentialsOnRedirect": true,
    "tlsVerification": true,
    "localException": {
      "environment": "ISOLATED_SYNTHETIC",
      "inventoryBound": true,
      "hosts": [
        "127.0.0.1",
        "[::1]"
      ],
      "port": 18765,
      "path": "/contract",
      "networkScope": "LOOPBACK_ONLY"
    },
    "blockedIpv4Cidrs": [
      "0.0.0.0/8",
      "10.0.0.0/8",
      "100.64.0.0/10",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.0.0.0/24",
      "192.0.2.0/24",
      "192.88.99.0/24",
      "192.168.0.0/16",
      "198.18.0.0/15",
      "198.51.100.0/24",
      "203.0.113.0/24",
      "224.0.0.0/4",
      "240.0.0.0/4"
    ],
    "ipv6GlobalUnicast": "2000::/3",
    "blockedIpv6Cidrs": [
      "2001::/23",
      "2001:db8::/32",
      "2002::/16"
    ],
    "rejectMappedOrTranslatedIpv4": true
  },
  "limits": {
    "scope": "DOCUMENT_FIXTURE_ONLY",
    "connectTimeoutMs": 1000,
    "totalTimeoutMs": 5000,
    "maxAttempts": 3,
    "baseBackoffMs": 100,
    "maxBackoffMs": 500,
    "retryableCategories": [
      "timeout",
      "unavailable",
      "rate_limited"
    ],
    "nonRetryableCategories": [
      "configuration",
      "unsupported",
      "invalid_response",
      "security",
      "normalization"
    ],
    "maxWireBytes": 131072,
    "maxDecodedBytes": 262144,
    "contentTypes": [
      "application/json"
    ],
    "concurrency": 2,
    "ratePerSecond": 1,
    "dailyRequestQuota": 100,
    "costUpperBoundMicros": 0,
    "circuitFailureThreshold": 3,
    "circuitWindowMs": 60000,
    "circuitOpenMs": 30000,
    "halfOpenProbeLimit": 1
  },
  "versionBinding": [
    "providerId",
    "configVersion",
    "schemaVersion",
    "normalizerVersion",
    "freshnessPolicyVersion",
    "resolutionPolicyVersion"
  ],
  "cache": {
    "keyIncludes": [
      "providerId",
      "capability",
      "normalizedQuery",
      "locale",
      "region",
      "dateWindow",
      "roadProfile",
      "configVersion",
      "schemaVersion",
      "normalizerVersion",
      "resolutionPolicyVersion"
    ],
    "keyExcludes": [
      "secretRef",
      "apiKey",
      "userId",
      "traceId",
      "plannerRunId"
    ],
    "valueOrPayloadRefExactlyOne": true,
    "recordOrRunOwnershipAllowed": false,
    "payloadMayReferenceFactSnapshot": false,
    "privateQuerySharedCacheAllowed": false,
    "hitRequires": [
      "license",
      "attribution",
      "schemaVersion",
      "providerVersion",
      "contentHash",
      "semanticKey",
      "safetyDeadlines"
    ],
    "snapshotMaterializationKey": [
      "plannerRunId",
      "collectionAttemptId"
    ],
    "preserveOriginalFetchedAt": true,
    "refreshCreatesNewSnapshot": true,
    "versionPinnedBlobEviction": false,
    "coordination": "POSTGRES_LEASE_AND_FENCING",
    "refreshMayExtendDeadline": false,
    "miss": {
      "state": "unavailable",
      "reason": "MISS"
    }
  },
  "freshnessFixturePolicy": {
    "version": "fixture-freshness-v1",
    "agingAfterSeconds": 60,
    "ttlSeconds": 120,
    "maxStaleSeconds": 180,
    "licenseMaxAgeSeconds": 600
  },
  "fallback": {
    "ordered": true,
    "retainActualProviderAndVersion": true,
    "allowStaleWithinAllDeadlines": true,
    "expiredAction": "UNKNOWN_OR_BLOCK",
    "conflictAction": "PRESERVE_ALL_WITH_CONFLICT_GROUP",
    "unsupportedAction": "SKIP_PROVIDER_WITH_COVERAGE_REASON",
    "sourceRequiredFor": [
      "verified",
      "estimated",
      "conflicting",
      "stale"
    ],
    "aiMaySetFacts": false,
    "aiMaySetStatus": false,
    "aiMayCreateSources": false,
    "aiMaySetCoordinates": false,
    "preciseMissingCriticalAction": "BLOCK",
    "quickMissingCriticalAction": "POLICY_GATED_VISIBLE_UNKNOWN",
    "unknownTransportAction": "ORDER_ONLY_NO_EXECUTION_CONFIRMATION_OR_NAVIGATION"
  },
  "betaScenarios": [
    "黄山两天一晚旅游",
    "江西上饶旅行攻略",
    "周末从深圳去武功山"
  ],
  "betaCoverageRequired": [
    "destination_and_entrance",
    "lodging_area_anchor",
    "two_attractions_or_activities",
    "food_dish_or_area",
    "public_cost_or_free",
    "reservation_or_restriction",
    "static_first_last_transport_constraint"
  ],
  "productionPolicy": "NOT_EVALUATED",
  "outboundPublicRequests": 0
}
```

## 固定正反例

下列 fixture 不是真实地点数据、请求结果或服务许可。检查器从文档读取规则并执行独立状态、规范化、SSRF、资源预算、来源/缓存/版本不变性断言；临时变异必须失败后恢复通过。

<!-- contract:provider-fixtures -->
```json
{
  "clock": "2026-09-09T00:00:00.000Z",
  "states": [
    {
      "id": "separate-normal",
      "value": {
        "fact": {
          "status": "verified",
          "freshness": {
            "status": "aging",
            "checkedAt": "2026-09-09T00:01:00.000Z",
            "freshnessPolicyVersion": "fixture-freshness-v1"
          }
        },
        "provider": {
          "availability": "degraded",
          "errorCategory": "timeout"
        },
        "capability": {
          "coverage": "supported"
        },
        "cache": {
          "state": "stale_fallback"
        }
      },
      "expected": true
    },
    {
      "id": "no-capability-is-not-fact-status",
      "replace": {
        "path": "fact.status",
        "value": "unsupported"
      },
      "expected": false
    },
    {
      "id": "unknown-is-not-provider-availability",
      "replace": {
        "path": "provider.availability",
        "value": "unknown"
      },
      "expected": false
    },
    {
      "id": "unavailable-is-not-capability",
      "replace": {
        "path": "capability.coverage",
        "value": "unavailable"
      },
      "expected": false
    },
    {
      "id": "cache-is-not-freshness",
      "replace": {
        "path": "fact.freshness.status",
        "value": "stale_fallback"
      },
      "expected": false
    },
    {
      "id": "aging-is-not-cache-state",
      "replace": {
        "path": "cache.state",
        "value": "aging"
      },
      "expected": false
    }
  ],
  "requests": [
    {
      "id": "normalized-query",
      "query": {
        "queryType": "geocoding",
        "normalizedName": "  测试  地点  ",
        "locale": "zh-CN",
        "limit": 3
      },
      "expected": true
    },
    {
      "id": "query-url-injection",
      "query": {
        "queryType": "geocoding",
        "normalizedName": "  测试  地点  ",
        "locale": "zh-CN",
        "limit": 3,
        "url": "https://other.invalid"
      },
      "expected": false
    },
    {
      "id": "query-prototype-field",
      "query": {
        "queryType": "geocoding",
        "normalizedName": "  测试  地点  ",
        "locale": "zh-CN",
        "limit": 3,
        "constructor": "ignored"
      },
      "expected": false
    },
    {
      "id": "unknown-locale",
      "query": {
        "queryType": "geocoding",
        "normalizedName": "  测试  地点  ",
        "locale": "any",
        "limit": 3
      },
      "expected": false
    },
    {
      "id": "batch-over-limit",
      "query": {
        "queryType": "geocoding",
        "normalizedName": "  测试  地点  ",
        "locale": "zh-CN",
        "limit": 11
      },
      "expected": false
    },
    {
      "id": "trusted-road-input",
      "query": {
        "queryType": "road_route",
        "normalizedName": "测试道路",
        "locale": "zh-CN",
        "roadProfile": "driving",
        "coordinates": [
          {
            "lat": 30,
            "lng": 120,
            "authority": "CONTROLLED_PUBLIC_DATABASE",
            "sourceRef": "source:synthetic-a"
          },
          {
            "lat": 31,
            "lng": 121,
            "authority": "TRUSTED_PUBLIC_GEOCODER",
            "sourceRef": "source:synthetic-b"
          }
        ]
      },
      "expected": true
    },
    {
      "id": "ai-coordinate-rejected",
      "mutation": "ai-coordinate",
      "expected": false
    },
    {
      "id": "private-coordinate-rejected",
      "mutation": "private-coordinate",
      "expected": false
    },
    {
      "id": "out-of-range-coordinate",
      "mutation": "out-of-range-coordinate",
      "expected": false
    },
    {
      "id": "road-as-transit-rejected",
      "mutation": "road-as-transit",
      "expected": false
    },
    {
      "id": "valid-forecast",
      "query": {
        "queryType": "weather_forecast",
        "normalizedName": "测试天气",
        "locale": "zh-CN",
        "coordinates": [
          {
            "lat": 30,
            "lng": 120,
            "authority": "CONTROLLED_PUBLIC_DATABASE",
            "sourceRef": "source:synthetic-a"
          }
        ],
        "timeZone": "Asia/Shanghai",
        "dateRange": {
          "start": "2026-09-09",
          "end": "2026-09-10"
        }
      },
      "expected": true
    },
    {
      "id": "impossible-calendar-date",
      "mutation": "impossible-calendar-date",
      "expected": false
    }
  ],
  "transport": [
    {
      "id": "public-address-document-only",
      "chain": [
        {
          "url": "https://provider.fixture.invalid/facts?q=fixture&locale=zh-CN",
          "dns": [
            "93.184.216.34"
          ],
          "peer": "93.184.216.34"
        }
      ],
      "environment": "DOCUMENT_FIXTURE",
      "expected": true
    },
    {
      "id": "private-dns",
      "chain": [
        {
          "url": "https://provider.fixture.invalid/facts?q=fixture&locale=zh-CN",
          "dns": [
            "10.0.0.1"
          ],
          "peer": "10.0.0.1"
        }
      ],
      "environment": "DOCUMENT_FIXTURE",
      "expected": false
    },
    {
      "id": "mixed-dns-answer",
      "chain": [
        {
          "url": "https://provider.fixture.invalid/facts?q=fixture&locale=zh-CN",
          "dns": [
            "93.184.216.34",
            "127.0.0.1"
          ],
          "peer": "93.184.216.34"
        }
      ],
      "environment": "DOCUMENT_FIXTURE",
      "expected": false
    },
    {
      "id": "dns-rebinding",
      "chain": [
        {
          "url": "https://provider.fixture.invalid/facts?q=fixture&locale=zh-CN",
          "dns": [
            "93.184.216.34"
          ],
          "peer": "127.0.0.1"
        }
      ],
      "environment": "DOCUMENT_FIXTURE",
      "expected": false
    },
    {
      "id": "metadata-redirect",
      "chain": [
        {
          "url": "https://provider.fixture.invalid/facts?q=fixture&locale=zh-CN",
          "dns": [
            "93.184.216.34"
          ],
          "peer": "93.184.216.34"
        },
        {
          "url": "http://169.254.169.254/latest/meta-data",
          "dns": [
            "169.254.169.254"
          ],
          "peer": "169.254.169.254"
        }
      ],
      "environment": "DOCUMENT_FIXTURE",
      "expected": false
    },
    {
      "id": "redirect-dns-recheck",
      "chain": [
        {
          "url": "https://provider.fixture.invalid/facts?q=fixture&locale=zh-CN",
          "dns": [
            "93.184.216.34"
          ],
          "peer": "93.184.216.34"
        },
        {
          "url": "https://provider.fixture.invalid/facts?q=fixture&locale=zh-CN",
          "dns": [
            "192.168.1.1"
          ],
          "peer": "192.168.1.1"
        }
      ],
      "environment": "DOCUMENT_FIXTURE",
      "expected": false
    },
    {
      "id": "userinfo-rejected",
      "chain": [
        {
          "url": "https://user:pass@provider.fixture.invalid/facts",
          "dns": [
            "93.184.216.34"
          ],
          "peer": "93.184.216.34"
        }
      ],
      "environment": "DOCUMENT_FIXTURE",
      "expected": false
    },
    {
      "id": "encoded-loopback-host",
      "chain": [
        {
          "url": "https://0x7f000001/facts",
          "dns": [
            "127.0.0.1"
          ],
          "peer": "127.0.0.1"
        }
      ],
      "environment": "DOCUMENT_FIXTURE",
      "expected": false
    },
    {
      "id": "ipv6-mapped-loopback",
      "chain": [
        {
          "url": "https://provider.fixture.invalid/facts?q=fixture&locale=zh-CN",
          "dns": [
            "::ffff:127.0.0.1"
          ],
          "peer": "::ffff:127.0.0.1"
        }
      ],
      "environment": "DOCUMENT_FIXTURE",
      "expected": false
    },
    {
      "id": "ipv6-public",
      "chain": [
        {
          "url": "https://provider.fixture.invalid/facts?q=fixture&locale=zh-CN",
          "dns": [
            "2606:4700:4700::1111"
          ],
          "peer": "2606:4700:4700::1111"
        }
      ],
      "environment": "DOCUMENT_FIXTURE",
      "expected": true
    },
    {
      "id": "ipv6-link-local",
      "chain": [
        {
          "url": "https://provider.fixture.invalid/facts?q=fixture&locale=zh-CN",
          "dns": [
            "fe80::1"
          ],
          "peer": "fe80::1"
        }
      ],
      "environment": "DOCUMENT_FIXTURE",
      "expected": false
    },
    {
      "id": "ipv6-transition-address",
      "chain": [
        {
          "url": "https://provider.fixture.invalid/facts?q=fixture&locale=zh-CN",
          "dns": [
            "2002:7f00:1::"
          ],
          "peer": "2002:7f00:1::"
        }
      ],
      "environment": "DOCUMENT_FIXTURE",
      "expected": false
    },
    {
      "id": "scheme-rejected",
      "chain": [
        {
          "url": "file:///etc/passwd",
          "dns": [],
          "peer": null
        }
      ],
      "environment": "DOCUMENT_FIXTURE",
      "expected": false
    },
    {
      "id": "arbitrary-path",
      "chain": [
        {
          "url": "https://provider.fixture.invalid/admin",
          "dns": [
            "93.184.216.34"
          ],
          "peer": "93.184.216.34"
        }
      ],
      "environment": "DOCUMENT_FIXTURE",
      "expected": false
    },
    {
      "id": "query-secret",
      "chain": [
        {
          "url": "https://provider.fixture.invalid/facts?token=fixture",
          "dns": [
            "93.184.216.34"
          ],
          "peer": "93.184.216.34"
        }
      ],
      "environment": "DOCUMENT_FIXTURE",
      "expected": false
    },
    {
      "id": "controlled-loopback",
      "chain": [
        {
          "url": "http://127.0.0.1:18765/contract",
          "dns": [
            "127.0.0.1"
          ],
          "peer": "127.0.0.1"
        }
      ],
      "environment": "ISOLATED_SYNTHETIC",
      "inventoryBound": true,
      "expected": true
    },
    {
      "id": "production-loopback-rejected",
      "chain": [
        {
          "url": "http://127.0.0.1:18765/contract",
          "dns": [
            "127.0.0.1"
          ],
          "peer": "127.0.0.1"
        }
      ],
      "environment": "PRODUCTION",
      "inventoryBound": true,
      "expected": false
    },
    {
      "id": "unbound-loopback-rejected",
      "chain": [
        {
          "url": "http://127.0.0.1:18765/contract",
          "dns": [
            "127.0.0.1"
          ],
          "peer": "127.0.0.1"
        }
      ],
      "environment": "ISOLATED_SYNTHETIC",
      "inventoryBound": false,
      "expected": false
    },
    {
      "id": "redirect-limit",
      "mutation": "redirect-limit",
      "expected": false
    }
  ],
  "freshness": [
    {
      "id": "fresh",
      "ageSeconds": 30,
      "expected": "fresh"
    },
    {
      "id": "aging-boundary",
      "ageSeconds": 60,
      "expected": "aging"
    },
    {
      "id": "stale-boundary",
      "ageSeconds": 120,
      "expected": "stale"
    },
    {
      "id": "expired-boundary",
      "ageSeconds": 300,
      "expected": "expired"
    },
    {
      "id": "provider-valid-until-wins",
      "ageSeconds": 180,
      "providerValidSeconds": 180,
      "expected": "expired"
    },
    {
      "id": "unknown-source",
      "ageSeconds": 30,
      "unknown": true,
      "expected": "unknown"
    }
  ],
  "cache": [
    {
      "id": "fresh-hit",
      "ageSeconds": 30,
      "refreshing": false,
      "failed": false,
      "expected": "fresh"
    },
    {
      "id": "swr",
      "ageSeconds": 120,
      "refreshing": true,
      "failed": false,
      "expected": "stale_revalidating"
    },
    {
      "id": "stale-fallback",
      "ageSeconds": 180,
      "refreshing": false,
      "failed": true,
      "expected": "stale_fallback"
    },
    {
      "id": "stale-ceiling",
      "ageSeconds": 300,
      "refreshing": false,
      "failed": true,
      "expected": "expired"
    },
    {
      "id": "provider-expiry",
      "ageSeconds": 180,
      "providerValidSeconds": 180,
      "refreshing": false,
      "failed": true,
      "expected": "expired"
    },
    {
      "id": "no-value",
      "ageSeconds": 30,
      "missing": true,
      "expected": "unavailable"
    }
  ],
  "resources": [
    {
      "id": "timeout-retry-bounded",
      "events": [
        {
          "category": "timeout",
          "durationMs": 500
        },
        {
          "category": "timeout",
          "durationMs": 500
        },
        {
          "category": "timeout",
          "durationMs": 500
        }
      ],
      "expectedAttempts": 3,
      "expectedAvailability": "unavailable"
    },
    {
      "id": "retry-then-success",
      "events": [
        {
          "category": "timeout",
          "durationMs": 500
        },
        {
          "category": null,
          "durationMs": 50
        }
      ],
      "expectedAttempts": 2,
      "expectedAvailability": "available"
    },
    {
      "id": "security-is-not-retryable",
      "events": [
        {
          "category": "security",
          "durationMs": 10
        },
        {
          "category": null,
          "durationMs": 50
        }
      ],
      "expectedAttempts": 1,
      "expectedAvailability": "unavailable"
    },
    {
      "id": "retry-after-cannot-exceed-deadline",
      "events": [
        {
          "category": "rate_limited",
          "durationMs": 10,
          "retryAfterMs": 6000
        },
        {
          "category": null,
          "durationMs": 50
        }
      ],
      "expectedAttempts": 1,
      "expectedAvailability": "unavailable"
    },
    {
      "id": "decoded-size-is-bounded",
      "events": [
        {
          "category": null,
          "durationMs": 10,
          "decodedBytes": 262145
        },
        {
          "category": null,
          "durationMs": 50
        }
      ],
      "expectedAttempts": 1,
      "expectedAvailability": "unavailable"
    },
    {
      "id": "wire-size-is-bounded",
      "events": [
        {
          "category": null,
          "durationMs": 10,
          "wireBytes": 131073
        }
      ],
      "expectedAttempts": 1,
      "expectedAvailability": "unavailable"
    },
    {
      "id": "quota-precedes-outbound",
      "quotaRemaining": 0,
      "events": [
        {
          "category": null,
          "durationMs": 50
        }
      ],
      "expectedAttempts": 0,
      "expectedAvailability": "unavailable"
    },
    {
      "id": "circuit-open-precedes-outbound",
      "recentFailures": 3,
      "events": [
        {
          "category": null,
          "durationMs": 50
        }
      ],
      "expectedAttempts": 0,
      "expectedAvailability": "unavailable"
    },
    {
      "id": "cancel-precedes-outbound",
      "cancelled": true,
      "events": [
        {
          "category": null,
          "durationMs": 50
        }
      ],
      "expectedAttempts": 0,
      "expectedAvailability": "unavailable"
    },
    {
      "id": "deadline-prevents-late-success",
      "events": [
        {
          "category": null,
          "durationMs": 5001
        }
      ],
      "expectedAttempts": 1,
      "expectedAvailability": "unavailable"
    }
  ],
  "factSource": {
    "id": "source:synthetic",
    "provider": "controlled-static-evidence",
    "sourceType": "controlled_static",
    "title": "合成文档校验来源",
    "url": null,
    "sourceLocator": "fixture:phase002:source",
    "contentHash": "sha256:b1fc0ac9789c60e467c45a919d52dacf5a7a98501c05cf72f4065c875eef7d4f",
    "organization": "SYNTHETIC",
    "license": "SYNTHETIC-FIXTURE-ONLY",
    "fetchedAt": "2026-09-09T00:00:00.000Z",
    "confidence": 1,
    "validFrom": null,
    "validUntil": null
  },
  "facts": [
    {
      "id": "source-backed-fact",
      "status": "verified",
      "value": 42,
      "sourceRefs": [
        "source:synthetic"
      ],
      "conflictGroup": null,
      "expected": true
    },
    {
      "id": "unknown-is-null",
      "status": "unknown",
      "value": null,
      "sourceRefs": [],
      "conflictGroup": null,
      "expected": true
    },
    {
      "id": "unknown-cannot-be-zero",
      "status": "unknown",
      "value": 0,
      "sourceRefs": [],
      "conflictGroup": null,
      "expected": false
    },
    {
      "id": "dangling-source",
      "status": "verified",
      "value": 42,
      "sourceRefs": [
        "source:missing"
      ],
      "conflictGroup": null,
      "expected": false
    },
    {
      "id": "unbacked-estimate",
      "status": "estimated",
      "value": 42,
      "sourceRefs": [],
      "conflictGroup": null,
      "expected": false
    },
    {
      "id": "conflict-group-required",
      "status": "conflicting",
      "value": 42,
      "sourceRefs": [
        "source:synthetic"
      ],
      "conflictGroup": null,
      "expected": false
    },
    {
      "id": "conflict-kept",
      "status": "conflicting",
      "value": 42,
      "sourceRefs": [
        "source:synthetic"
      ],
      "conflictGroup": "conflict:synthetic",
      "expected": true
    }
  ]
}
```

运行 `node docs/phase-plans/check-phase002-provider-privacy.mjs --case provider`。本阶段证明文档规则可判定；真实 DNS/socket、HTTP、缓存并发、数据库事务与 Provider 集成仍为 NOT_CREATED，hosting 支持边界由 Phase002 主验证器一起检查。
