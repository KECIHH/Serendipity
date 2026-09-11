# Serendipity · 际遇 初始旅行 Schema

Owner: 需求与规划 Schema；producerPhase: 2；运行时首次生产: Phase017；消费者: Phase019-024、Phase053、Phase062。本文是 TravelRequirement 与 TravelPlanSummaryDraft v1 的唯一字段定义。当前 [数据库规范](database.md) 负责持久模型；本地旧任务卡中的“database 2.5 TravelRequirement”仅是旧章节定位，当前需求结构应定位本文，不改变数据库 2.5 的 ApiKeyConfig 定义。

Phase008 先建立 nullable `TravelRecord.requirementJson` 持久列，但不提前生产本文的运行时 Schema。其 repository 只接受缺省/null 并写为 SQL NULL，任何非空 JSON 在 SQL 前拒绝；不能用简化结构、外部验证回调或自报“已校验”绕过。Phase017 消费本文唯一字段定义并接入真实校验后，才开放非空快照持久化；当前 fail-closed 边界不表示已实现需求提取、合并或 readiness。`ChatMessage.contentJson` 同样等待对应内容 Schema，Phase008 只开放无结构的 TEXT 写入。

路线包输入的规范化绝对路径、SHA-256、读取卡片及基线记录在 [Phase002 输入清单](phase-plans/Phase002-inputs.json)，权威顺序见 [项目宪法](project-constitution.md)。本文仅生产文档与可执行文档校验，不生产应用类型、Prisma、数据库、路由或正式计划。公开边界见 [API](api.md)，隐私与 consent 生命周期见 [隐私规范](privacy-and-user-data.md)，模型只能消费 [Prompt 契约](prompt-design.md) 允许的数据。

## 版本与所有权

所有具名 JSON 块是机器可读的唯一结构定义，使用 JSON Schema 2020-12 中本文实际使用的封闭子集；Phase017 的运行时 Schema 逐字段消费此定义，不能另起 TravelPlanSchema 别名。`additionalProperties:false` 递归生效。文档校验器拒绝不支持的 Schema 关键字，避免看似校验而实际忽略约束。

TravelRequirement 是服务端验证、合并后产生的不可变快照。`revision` 从空快照 0 开始，每次接受的新需求补丁恰加 1；重复命令由调用方幂等账本重放原结果。`requirementHash` 是该完整快照 RFC8785 JCS UTF-8 字节的 SHA-256 小写 64 位 hex，不存入快照自身；缺失问题、来源和所有派生值在计算 hash 前冻结。同一 revision 不允许对应不同 hash。Phase025 增加 TravelRecord.requirementRevision 后，该列必须等于 requirementJson.revision；此前 revision 在已校验 JSON 与命令收据中，不提前加列。

实体 `id` 由服务端创建且后续保留。目的地是用户意图，不是已验证 PlaceEntity；不能仅凭目的地名产生坐标、票价或 placeRef。Phase024 引用正式实体时只使用 `placeRef/routeLegRef/dayId/eventId`，不使用名称、数组下标或展示 day 作身份。

## TravelRequirement v1

下表解释字段归属；精确结构、范围与枚举由下一 JSON 块定义。除补丁 `set` 外，不允许省略要求出现的字段。非空文本拒绝全空白和未配对的 UTF-16 代理项；origin 的 city/country 都未知时必须用整体 null，dateRange 连日期原文也未知时必须用整体 null。日期是 ISO local date，必须配 IANA `timezone`；时间点与未来 PlanTimePoint 不是同一种字段。

| 字段 | 语义与生产责任 |
|---|---|
| schemaVersion / revision | 固定 1 / 非负需求版本；服务端生成，AI 不输出 |
| origin | 出发城市/国家意图及置信度，整体未知为 null；国家规范化为 ISO 3166-1 alpha-2 |
| destinations | 按用户顺序保留的地点意图，服务端 stable id；空数组无可解析目的地，始终阻断规划 |
| dateRange | startDate/endDate/text/isFlexible/timezone/confidence；两日期同空或同有值。isFlexible=false 是包含首尾的固定日期，true 是最早出发到最晚返回的可选外窗 |
| durationDays | 已明确或从固定日期确定性计算的正整数天数；未知 null。quick 默认天数保留在 assumption，不回写成用户事实 |
| travelers | totalCount/adultCount/childCount/elderCount/ageUnknownCount、relationship、notes、四个派生标记与 confidence |
| budget | amount/currency/level/isFlexible/perPerson/hardLimit/confidence；金额是用户预算约束，不是 Provider 费用事实 |
| preferences | pace/interests/avoid/transport/hardConstraints/accessibility/consent/confidence；硬约束、无障碍和敏感需求处理 consent 在此完整子对象内，可由既有 RequirementPath=preferences 消费 |
| specialFlags | isSelfDriving/isHiking 从明确偏好派生，isOverseas 从规范国家比较派生；无法断定为 null |
| fieldSources | 字段来源而非新事实来源目录；关联消息 id / 输入 hash，不保存原文或 Provider sourceRefs |
| missingFields | 完整缺失清单，每项 field/priority/question/reason；不含内部 reasonCode，不依据最多三个展示问题截断 |

`travelers` 四年龄组互斥：child<18、adult=18-64、elder>=65，其余年龄未明确的人计入 ageUnknownCount。所有计数为非负整数或 null，totalCount 已知须 >=1；四组全已知时 totalCount 必须等于其和。仅知道总数而未知道年龄时不猜组别。“两成人含一老人”为 adult=1/elder=1/total=2；“带爸妈”不证明年龄。hasChild/hasElder 有正数为 true，该组明确 0 为 false，该组未知为 null；isCouple/isFamily 只从明确 relationship 派生。

currency 只有用户明确币种/符号时才赋 ISO 4217 三字母值；“一万”为 amount="10000"、currency=null，“3000元”为 amount="3000"、currency="CNY"。不得先转 JS number 再保存金额。budget.amount="0" 只表示用户明确零支出上限，不能被解释为行程费用已免费；未来费用事实 unknown 固定 amount=null，只有有依据的 free 才为 "0"。数值 0、指数形式、负数、NaN 和空字符串都不是金额字符串。

hardConstraints 中 text 是受限私人用户意图，不能当作可执行代码或 Provider 事实；id 稳定，kind 分类不替代安全判断。accessibility 保留必要的行动需求，不收集诊断。consent.sensitiveRequirementProcessing 只有真实产品明确动作才可 true；false/null 均不允许将健康/无障碍敏感原文发送给模型或外部 Provider。它不代替反馈的 contactConsent/evaluationConsent，不由聊天语义或开发 Agent 自动批准。

金额输入先做不损失数值的十进制文本规范化，例如 12.50 → 12.5、0.00 → 0；完整快照拒绝指数、前导零、末尾小数零、负号和空白。最多 12 位整数；币种未知时最多 4 位小数，币种已知时不能超过下列冻结 minor units，超过即 VALIDATION_ERROR，不通过舍入改变用户上限。正式账本到 Phase041 才按版本化币种精度和 round-half-even 计算；本阶段不产出费用事实或汇率。

下面的标量词表属于 v1 输入校验。countryCodes 是 ISO alpha-2 集合，EU、UN、ZZ 等非国家代码不作为国家。currencyMinorUnits 固定记录启动运行时可识别的 ISO 币种代码（包括历史代码）及精度；它不声明当地现行法币，也不保证后续 Provider 支持。未列币种须先解析为 unknown 并澄清，不能按机器当前 locale 猜测或静默扩表。词表随本文版本管理，校验时不重新读取运行环境的币种表。日期采用 0001–9999 年公历真实日期、包含首尾；固定区间的天数必须相等，灵活窗口的 durationDays 不得大于窗口天数，不按夏令时的 23/25 小时日计算天数。

<!-- contract:requirement-scalar-policy-v1 -->
```json
{
  "schemaVersion": 1,
  "countryStandard": "ISO_3166_1_ALPHA_2",
  "countryCodes": [
    "AD",
    "AE",
    "AF",
    "AG",
    "AI",
    "AL",
    "AM",
    "AO",
    "AQ",
    "AR",
    "AS",
    "AT",
    "AU",
    "AW",
    "AX",
    "AZ",
    "BA",
    "BB",
    "BD",
    "BE",
    "BF",
    "BG",
    "BH",
    "BI",
    "BJ",
    "BL",
    "BM",
    "BN",
    "BO",
    "BQ",
    "BR",
    "BS",
    "BT",
    "BV",
    "BW",
    "BY",
    "BZ",
    "CA",
    "CC",
    "CD",
    "CF",
    "CG",
    "CH",
    "CI",
    "CK",
    "CL",
    "CM",
    "CN",
    "CO",
    "CR",
    "CU",
    "CV",
    "CW",
    "CX",
    "CY",
    "CZ",
    "DE",
    "DJ",
    "DK",
    "DM",
    "DO",
    "DZ",
    "EC",
    "EE",
    "EG",
    "EH",
    "ER",
    "ES",
    "ET",
    "FI",
    "FJ",
    "FK",
    "FM",
    "FO",
    "FR",
    "GA",
    "GB",
    "GD",
    "GE",
    "GF",
    "GG",
    "GH",
    "GI",
    "GL",
    "GM",
    "GN",
    "GP",
    "GQ",
    "GR",
    "GS",
    "GT",
    "GU",
    "GW",
    "GY",
    "HK",
    "HM",
    "HN",
    "HR",
    "HT",
    "HU",
    "ID",
    "IE",
    "IL",
    "IM",
    "IN",
    "IO",
    "IQ",
    "IR",
    "IS",
    "IT",
    "JE",
    "JM",
    "JO",
    "JP",
    "KE",
    "KG",
    "KH",
    "KI",
    "KM",
    "KN",
    "KP",
    "KR",
    "KW",
    "KY",
    "KZ",
    "LA",
    "LB",
    "LC",
    "LI",
    "LK",
    "LR",
    "LS",
    "LT",
    "LU",
    "LV",
    "LY",
    "MA",
    "MC",
    "MD",
    "ME",
    "MF",
    "MG",
    "MH",
    "MK",
    "ML",
    "MM",
    "MN",
    "MO",
    "MP",
    "MQ",
    "MR",
    "MS",
    "MT",
    "MU",
    "MV",
    "MW",
    "MX",
    "MY",
    "MZ",
    "NA",
    "NC",
    "NE",
    "NF",
    "NG",
    "NI",
    "NL",
    "NO",
    "NP",
    "NR",
    "NU",
    "NZ",
    "OM",
    "PA",
    "PE",
    "PF",
    "PG",
    "PH",
    "PK",
    "PL",
    "PM",
    "PN",
    "PR",
    "PS",
    "PT",
    "PW",
    "PY",
    "QA",
    "RE",
    "RO",
    "RS",
    "RU",
    "RW",
    "SA",
    "SB",
    "SC",
    "SD",
    "SE",
    "SG",
    "SH",
    "SI",
    "SJ",
    "SK",
    "SL",
    "SM",
    "SN",
    "SO",
    "SR",
    "SS",
    "ST",
    "SV",
    "SX",
    "SY",
    "SZ",
    "TC",
    "TD",
    "TF",
    "TG",
    "TH",
    "TJ",
    "TK",
    "TL",
    "TM",
    "TN",
    "TO",
    "TR",
    "TT",
    "TV",
    "TW",
    "TZ",
    "UA",
    "UG",
    "UM",
    "US",
    "UY",
    "UZ",
    "VA",
    "VC",
    "VE",
    "VG",
    "VI",
    "VN",
    "VU",
    "WF",
    "WS",
    "YE",
    "YT",
    "ZA",
    "ZM",
    "ZW"
  ],
  "currencySnapshotSource": {
    "node": "24.19.0",
    "icu": "78.3",
    "source": "Intl.supportedValuesOf(currency)+Intl.NumberFormat currency minor units"
  },
  "currencyMinorUnits": {
    "AED": 2,
    "AFN": 0,
    "ALL": 0,
    "AMD": 2,
    "ANG": 2,
    "AOA": 2,
    "ARS": 2,
    "AUD": 2,
    "AWG": 2,
    "AZN": 2,
    "BAM": 2,
    "BBD": 2,
    "BDT": 2,
    "BGN": 2,
    "BHD": 3,
    "BIF": 0,
    "BMD": 2,
    "BND": 2,
    "BOB": 2,
    "BRL": 2,
    "BSD": 2,
    "BTN": 2,
    "BWP": 2,
    "BYN": 2,
    "BZD": 2,
    "CAD": 2,
    "CDF": 2,
    "CHF": 2,
    "CLP": 0,
    "CNY": 2,
    "COP": 0,
    "CRC": 2,
    "CUC": 2,
    "CUP": 2,
    "CVE": 2,
    "CZK": 2,
    "DJF": 0,
    "DKK": 2,
    "DOP": 2,
    "DZD": 2,
    "EGP": 2,
    "ERN": 2,
    "ETB": 2,
    "EUR": 2,
    "FJD": 2,
    "FKP": 2,
    "GBP": 2,
    "GEL": 2,
    "GHS": 2,
    "GIP": 2,
    "GMD": 2,
    "GNF": 0,
    "GTQ": 2,
    "GYD": 2,
    "HKD": 2,
    "HNL": 2,
    "HRK": 2,
    "HTG": 2,
    "HUF": 0,
    "IDR": 0,
    "ILS": 2,
    "INR": 2,
    "IQD": 0,
    "IRR": 0,
    "ISK": 0,
    "JMD": 2,
    "JOD": 3,
    "JPY": 0,
    "KES": 2,
    "KGS": 2,
    "KHR": 2,
    "KMF": 0,
    "KPW": 0,
    "KRW": 0,
    "KWD": 3,
    "KYD": 2,
    "KZT": 2,
    "LAK": 0,
    "LBP": 0,
    "LKR": 2,
    "LRD": 2,
    "LSL": 2,
    "LYD": 3,
    "MAD": 2,
    "MDL": 2,
    "MGA": 0,
    "MKD": 2,
    "MMK": 0,
    "MNT": 2,
    "MOP": 2,
    "MRU": 2,
    "MUR": 2,
    "MVR": 2,
    "MWK": 2,
    "MXN": 2,
    "MYR": 2,
    "MZN": 2,
    "NAD": 2,
    "NGN": 2,
    "NIO": 2,
    "NOK": 2,
    "NPR": 2,
    "NZD": 2,
    "OMR": 3,
    "PAB": 2,
    "PEN": 2,
    "PGK": 2,
    "PHP": 2,
    "PKR": 0,
    "PLN": 2,
    "PYG": 0,
    "QAR": 2,
    "RON": 2,
    "RSD": 2,
    "RUB": 2,
    "RWF": 0,
    "SAR": 2,
    "SBD": 2,
    "SCR": 2,
    "SDG": 2,
    "SEK": 2,
    "SGD": 2,
    "SHP": 2,
    "SLE": 2,
    "SLL": 0,
    "SOS": 0,
    "SRD": 2,
    "SSP": 2,
    "STN": 2,
    "SVC": 2,
    "SYP": 0,
    "SZL": 2,
    "THB": 2,
    "TJS": 2,
    "TMT": 2,
    "TND": 3,
    "TOP": 2,
    "TRY": 2,
    "TTD": 2,
    "TWD": 2,
    "TZS": 2,
    "UAH": 2,
    "UGX": 0,
    "USD": 2,
    "UYU": 2,
    "UZS": 2,
    "VES": 2,
    "VND": 0,
    "VUV": 0,
    "WST": 2,
    "XAF": 0,
    "XCD": 2,
    "XCG": 2,
    "XDR": 2,
    "XOF": 0,
    "XPF": 0,
    "XSU": 2,
    "YER": 0,
    "ZAR": 2,
    "ZMW": 2,
    "ZWG": 2,
    "ZWL": 2
  },
  "unknownCurrencyMaxFractionDigits": 4,
  "inputRounding": "REJECT_EXCESS_PRECISION",
  "canonicalDecimal": "NO_LEADING_ZEROES_NO_TRAILING_FRACTION_ZEROES_NO_EXPONENT",
  "formalLedgerRoundingProducerPhase": 41,
  "formalLedgerRounding": "ROUND_HALF_EVEN",
  "localDateCalendar": "PROLEPTIC_GREGORIAN_0001_THROUGH_9999",
  "localDateRange": "INCLUSIVE_START_AND_END",
  "timezone": "IANA_TZDB_OR_UTC"
}
```

<!-- contract:travel-requirement-v1 -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "#/$defs/TravelRequirement",
  "$defs": {
    "Id": {
      "type": "string",
      "pattern": "^[A-Za-z][A-Za-z0-9_-]{1,95}$"
    },
    "Hash": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    },
    "Text": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200,
      "format": "nonblank-text"
    },
    "NullableText": {
      "anyOf": [
        {
          "$ref": "#/$defs/Text"
        },
        {
          "type": "null"
        }
      ]
    },
    "Confidence": {
      "type": "number",
      "minimum": 0,
      "maximum": 1
    },
    "NullableBoolean": {
      "type": [
        "boolean",
        "null"
      ]
    },
    "Count": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 0,
      "maximum": 100
    },
    "Date": {
      "type": [
        "string",
        "null"
      ],
      "format": "date"
    },
    "Currency": {
      "type": [
        "string",
        "null"
      ],
      "pattern": "^[A-Z]{3}$",
      "format": "iso-currency"
    },
    "Country": {
      "type": [
        "string",
        "null"
      ],
      "pattern": "^[A-Z]{2}$",
      "format": "iso-country"
    },
    "Amount": {
      "type": [
        "string",
        "null"
      ],
      "pattern": "^(0|[1-9][0-9]{0,11})(\\.[0-9]{0,3}[1-9])?$"
    },
    "TextList": {
      "type": "array",
      "maxItems": 20,
      "uniqueItems": true,
      "items": {
        "$ref": "#/$defs/Text"
      }
    },
    "Origin": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "city",
        "country",
        "confidence"
      ],
      "properties": {
        "city": {
          "$ref": "#/$defs/NullableText"
        },
        "country": {
          "$ref": "#/$defs/Country"
        },
        "confidence": {
          "$ref": "#/$defs/Confidence"
        }
      }
    },
    "Destination": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "name",
        "city",
        "country",
        "type",
        "confidence"
      ],
      "properties": {
        "id": {
          "$ref": "#/$defs/Id"
        },
        "name": {
          "$ref": "#/$defs/Text"
        },
        "city": {
          "$ref": "#/$defs/NullableText"
        },
        "country": {
          "$ref": "#/$defs/Country"
        },
        "type": {
          "enum": [
            "country",
            "province",
            "region",
            "city",
            "attraction",
            null
          ]
        },
        "confidence": {
          "$ref": "#/$defs/Confidence"
        }
      }
    },
    "DateRange": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "startDate",
        "endDate",
        "text",
        "isFlexible",
        "timezone",
        "confidence"
      ],
      "properties": {
        "startDate": {
          "$ref": "#/$defs/Date"
        },
        "endDate": {
          "$ref": "#/$defs/Date"
        },
        "text": {
          "$ref": "#/$defs/NullableText"
        },
        "isFlexible": {
          "type": "boolean"
        },
        "timezone": {
          "type": "string",
          "format": "iana-timezone",
          "maxLength": 80
        },
        "confidence": {
          "$ref": "#/$defs/Confidence"
        }
      }
    },
    "Travelers": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "totalCount",
        "adultCount",
        "childCount",
        "elderCount",
        "ageUnknownCount",
        "relationship",
        "notes",
        "hasChild",
        "hasElder",
        "isCouple",
        "isFamily",
        "confidence"
      ],
      "properties": {
        "totalCount": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 1,
          "maximum": 100
        },
        "adultCount": {
          "$ref": "#/$defs/Count"
        },
        "childCount": {
          "$ref": "#/$defs/Count"
        },
        "elderCount": {
          "$ref": "#/$defs/Count"
        },
        "ageUnknownCount": {
          "$ref": "#/$defs/Count"
        },
        "relationship": {
          "enum": [
            "solo",
            "couple",
            "family",
            "friends",
            "colleagues",
            "other",
            null
          ]
        },
        "notes": {
          "$ref": "#/$defs/TextList"
        },
        "hasChild": {
          "$ref": "#/$defs/NullableBoolean"
        },
        "hasElder": {
          "$ref": "#/$defs/NullableBoolean"
        },
        "isCouple": {
          "$ref": "#/$defs/NullableBoolean"
        },
        "isFamily": {
          "$ref": "#/$defs/NullableBoolean"
        },
        "confidence": {
          "$ref": "#/$defs/Confidence"
        }
      }
    },
    "Budget": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "amount",
        "currency",
        "level",
        "isFlexible",
        "perPerson",
        "hardLimit",
        "confidence"
      ],
      "properties": {
        "amount": {
          "$ref": "#/$defs/Amount"
        },
        "currency": {
          "$ref": "#/$defs/Currency"
        },
        "level": {
          "enum": [
            "budget",
            "standard",
            "premium",
            null
          ]
        },
        "isFlexible": {
          "$ref": "#/$defs/NullableBoolean"
        },
        "perPerson": {
          "$ref": "#/$defs/NullableBoolean"
        },
        "hardLimit": {
          "$ref": "#/$defs/NullableBoolean"
        },
        "confidence": {
          "$ref": "#/$defs/Confidence"
        }
      }
    },
    "HardConstraint": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "kind",
        "text"
      ],
      "properties": {
        "id": {
          "$ref": "#/$defs/Id"
        },
        "kind": {
          "enum": [
            "time",
            "transport",
            "dietary",
            "mobility",
            "budget",
            "other"
          ]
        },
        "text": {
          "$ref": "#/$defs/Text"
        }
      }
    },
    "Accessibility": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "stepFreeRequired",
        "maxWalkingMinutes",
        "notes"
      ],
      "properties": {
        "stepFreeRequired": {
          "$ref": "#/$defs/NullableBoolean"
        },
        "maxWalkingMinutes": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 0,
          "maximum": 1440
        },
        "notes": {
          "$ref": "#/$defs/TextList"
        }
      }
    },
    "Consent": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "sensitiveRequirementProcessing"
      ],
      "properties": {
        "sensitiveRequirementProcessing": {
          "$ref": "#/$defs/NullableBoolean"
        }
      }
    },
    "Preferences": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "pace",
        "interests",
        "avoid",
        "transport",
        "hardConstraints",
        "accessibility",
        "consent",
        "confidence"
      ],
      "properties": {
        "pace": {
          "enum": [
            "slow",
            "moderate",
            "fast",
            null
          ]
        },
        "interests": {
          "type": "array",
          "maxItems": 8,
          "uniqueItems": true,
          "items": {
            "enum": [
              "摄影",
              "美食",
              "徒步",
              "City Walk",
              "滑雪",
              "温泉",
              "博物馆",
              "自然风光"
            ]
          }
        },
        "avoid": {
          "$ref": "#/$defs/TextList"
        },
        "transport": {
          "type": "array",
          "maxItems": 6,
          "uniqueItems": true,
          "items": {
            "enum": [
              "self_driving",
              "high_speed_rail",
              "flight",
              "public_transit",
              "charter",
              "hiking"
            ]
          }
        },
        "hardConstraints": {
          "type": "array",
          "maxItems": 20,
          "items": {
            "$ref": "#/$defs/HardConstraint"
          }
        },
        "accessibility": {
          "$ref": "#/$defs/Accessibility"
        },
        "consent": {
          "$ref": "#/$defs/Consent"
        },
        "confidence": {
          "$ref": "#/$defs/Confidence"
        }
      }
    },
    "SpecialFlags": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "isSelfDriving",
        "isHiking",
        "isOverseas"
      ],
      "properties": {
        "isSelfDriving": {
          "$ref": "#/$defs/NullableBoolean"
        },
        "isHiking": {
          "$ref": "#/$defs/NullableBoolean"
        },
        "isOverseas": {
          "$ref": "#/$defs/NullableBoolean"
        }
      }
    },
    "FieldPath": {
      "enum": [
        "origin",
        "destinations",
        "dateRange",
        "durationDays",
        "travelers",
        "budget",
        "preferences.pace",
        "preferences.interests",
        "preferences.avoid",
        "preferences.transport",
        "preferences.hardConstraints",
        "preferences.accessibility",
        "preferences.consent"
      ]
    },
    "FieldSource": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "field",
        "messageId",
        "inputHash",
        "method",
        "confidence"
      ],
      "properties": {
        "field": {
          "$ref": "#/$defs/FieldPath"
        },
        "messageId": {
          "anyOf": [
            {
              "$ref": "#/$defs/Id"
            },
            {
              "type": "null"
            }
          ]
        },
        "inputHash": {
          "$ref": "#/$defs/Hash"
        },
        "method": {
          "enum": [
            "USER_TEXT",
            "USER_CONTROL",
            "DERIVED",
            "CLEAR"
          ]
        },
        "confidence": {
          "$ref": "#/$defs/Confidence"
        }
      }
    },
    "MissingField": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "field",
        "priority",
        "question",
        "reason"
      ],
      "properties": {
        "field": {
          "$ref": "#/$defs/FieldPath"
        },
        "priority": {
          "enum": [
            "blocking",
            "normal",
            "optional"
          ]
        },
        "question": {
          "type": "string",
          "minLength": 1,
          "maxLength": 300,
          "format": "nonblank-text"
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 300,
          "format": "nonblank-text"
        }
      }
    },
    "TravelRequirement": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "schemaVersion",
        "revision",
        "origin",
        "destinations",
        "dateRange",
        "durationDays",
        "travelers",
        "budget",
        "preferences",
        "specialFlags",
        "fieldSources",
        "missingFields"
      ],
      "properties": {
        "schemaVersion": {
          "const": 1
        },
        "revision": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "origin": {
          "anyOf": [
            {
              "$ref": "#/$defs/Origin"
            },
            {
              "type": "null"
            }
          ]
        },
        "destinations": {
          "type": "array",
          "maxItems": 20,
          "items": {
            "$ref": "#/$defs/Destination"
          }
        },
        "dateRange": {
          "anyOf": [
            {
              "$ref": "#/$defs/DateRange"
            },
            {
              "type": "null"
            }
          ]
        },
        "durationDays": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 1,
          "maximum": 365
        },
        "travelers": {
          "$ref": "#/$defs/Travelers"
        },
        "budget": {
          "$ref": "#/$defs/Budget"
        },
        "preferences": {
          "$ref": "#/$defs/Preferences"
        },
        "specialFlags": {
          "$ref": "#/$defs/SpecialFlags"
        },
        "fieldSources": {
          "type": "array",
          "maxItems": 13,
          "items": {
            "$ref": "#/$defs/FieldSource"
          }
        },
        "missingFields": {
          "type": "array",
          "maxItems": 13,
          "items": {
            "$ref": "#/$defs/MissingField"
          }
        }
      }
    }
  }
}
```

人数上限 100、意图目的地上限 20、需求天数上限 365 是本卡冻结的文档输入资源上界，不是 quick 默认值，也不承诺全部规模都满足后续规划资源策略。各消费者仍执行版本化 token/cost/deadline/规划上界。

## absent、unknown、empty 与 clear

完整快照不接受 absent；partial 提取/RequirementPatch.set 的 absent 表示“此轮未提及，保持旧值”。unknown 是合法数据值，不能隐式触发删除。只有 clearFields 或带明确稳定值的 arrayOps 才表达主动清除。fieldSources 按 field 唯一，所有已知用户意图必须有来源，已接受字段来源随快照保留；空数组没有来源表示未提供，有 USER_TEXT/USER_CONTROL 来源表示明确无此偏好，CLEAR 来源表示主动撤回。来源 method 由服务器从真实交互记录，不信任模型回传。

| 字段组 | unknown | empty | clear 后的 canonical 值 |
|---|---|---|---|
| origin / dateRange / durationDays | null | 空对象、空字符串、0 天均拒绝 | null；dateRange 清除时同时撤销由它 DERIVED 的 durationDays 并写 CLEAR 来源；同次显式 set durationDays 可保留独立时长 |
| destinations | [] 且无明确来源，不能规划 | [] 且明确来源，用户未选择地点，仍不能规划 | []，旧目的地 id 不转作其他地点 |
| travelers 所有计数/relationship/派生布尔 | null；confidence=0，notes=[] | {} 或字符串拒绝；明确无备注为 notes=[] | 完整 Travelers 未知对象，不填默认成人 |
| budget 所有 nullable 字段 | null；confidence=0 | 空字符串不是金额；amount="0" 是明确零预算 | 完整 Budget 未知对象，不能把未知金额转 0 |
| preferences.pace | null | "" 拒绝 | null |
| preferences.interests/avoid/transport/hardConstraints | []，无来源；不凭空肯定“无约束” | []，明确 USER_TEXT/USER_CONTROL 来源表示无此项 | [] 且 CLEAR；硬约束撤回需要显式用户意图 |
| accessibility.stepFreeRequired/maxWalkingMinutes | null | false 或 0 是明确约束值；notes=[] 可空 | nullable 成员为 null、notes=[]，重新执行安全准入 |
| preferences.consent.sensitiveRequirementProcessing | null，不授予处理许可 | false 是明确拒绝，不能当 unknown | false；按隐私撤回规则清理副本，不因 clear 变 true |
| specialFlags | null，无法确定 | 空对象拒绝 | 用户不得直接 clear/set；合并后按明确输入重算 |
| fieldSources | [] 仅空快照 | [] 合法，不伪造来源 | 不接受客户端修改；清除操作保留对应 CLEAR 来源 |
| missingFields | [] 只表示本次确定性检测结果无缺失 | [] 合法，不能据缺省推断 READY | 用户不得直接修改；每次合并后完整重算 |
| schemaVersion / revision / confidence | 版本不可 unknown；提取 confidence=0 表示无证据 | 省略/空字符串拒绝 | 不接受客户端 clear；服务端生成与校验 |

补丁 exact 外壳为 `{baseRevision,set,clearFields,arrayOps}`，set 是下列 field 白名单到完整子对象/值的映射，值复用 TravelRequirement 对应类型；禁止任意 JSONPath，禁止写派生字段或来源。`set` 中的 null 只能保留已未知字段或表达初次未知；把已知值撤回必须用 clearFields，不能以 null 兼任删除命令；此限制递归覆盖完整子对象中的成员，不能用 budget.amount=null 或 origin.city=null 包装成完整 set 来绕过。相同 field 在 set/clearFields/arrayOps 重复或相互覆盖即 VALIDATION_ERROR。来源、confidence、specialFlags 和 missingFields 由服务端重算。

arrayOps exact 为 `{field,op,values}`。field 只取 destinations、preferences.interests/avoid/transport/hardConstraints；op 为 add/remove/replace。字符串集合按 canonical 值去重，目的地与硬约束按稳定 id 去重，remove 按 id 删除且验证同快照归属，不能用数组下标或名称。add 已存在同 id 同值保持一次，异值同 id 拒绝；set/replace 同样拒绝把已存在 id 重新绑定到另一份对象内容；需要新意图时生成新 id，原 id 不复用。replace 明确替换整集合，空 values 明确清空。顺序集合 add 到尾，remove 保留其余顺序。对已由确认使用的值仍执行版本化权限/锁协议。

<!-- contract:requirement-patch-v1 -->
```json
{
  "schemaVersion": 1,
  "required": ["baseRevision", "set", "clearFields", "arrayOps"],
  "setFields": ["origin", "destinations", "dateRange", "durationDays", "travelers", "budget", "preferences.pace", "preferences.interests", "preferences.avoid", "preferences.transport", "preferences.hardConstraints", "preferences.accessibility", "preferences.consent"],
  "clearFields": ["origin", "destinations", "dateRange", "durationDays", "travelers", "budget", "preferences.pace", "preferences.interests", "preferences.avoid", "preferences.transport", "preferences.hardConstraints", "preferences.accessibility", "preferences.consent"],
  "arrayFields": ["destinations", "preferences.interests", "preferences.avoid", "preferences.transport", "preferences.hardConstraints"],
  "arrayOperationFields": ["field", "op", "values"],
  "arrayOperations": ["add", "remove", "replace"],
  "unknownClearsKnown": false,
  "expectedConflict": "VERSION_CONFLICT",
  "revisionIncrement": 1
}
```

stale baseRevision 返回 API 409 VERSION_CONFLICT、当前 revision 摘要和重新加载动作；没有部分写入。requirementJson 不存 confirmationStatus 或 MissingFieldSpec。Phase021 首次实现的 evaluateRequirementReadiness(requirement,ctx,policy,capabilities) 是唯一准入函数，输出完整 missingSpecs/assumptions/moduleDecisions/confirmationStatus。无可解析目的地和安全硬缺失始终 blocking；precise 的必需日期/人数/出发地按模块判断，quick 的普通日期/人数/时长未知可使用登记默认值，形成可见 assumption；安全能力未知仍阻断相应模块。missingFields 从全量 specs 与 fallback 单向生成，questions 仅最多三个展示文本，第四个 blocking 项依然阻断。

`RequirementState.confirmationStatus` 仅 NEEDS_INFORMATION/READY_FOR_PLANNING，是响应状态；TravelRecord 仅 DRAFT/NEEDS_INFO 在此交接，摘要成功不置 PLANNED。技术解析失败属于失败，不伪装成需要用户补充信息。

## TravelPlanSummaryDraft v1

摘要 exact 十字段如下。title/description/bestFor/overallRecommendation/recommendedReason 是有界私人候选文案；服务端确定 durationDays、destinations、schemaVersion、requirementRevision 与 requirementHash，不能信任模型重复给出的值。destinations 使用需求中同一 Destination 结构和同一 id/顺序，不能折叠成字符串。bestFor 是字符串数组，不是人群身份记录。

生成必须满足同次 readiness，requirementHash 与 revision 一致，目的地非空。durationDays 来自固定日期/明确时长或本次可见 quick assumption；没有可证明时长保持 null，不能以 0 代替。文档 fixture 的 approvedDurationDays 仅代表同次 readiness 已接受的有界时长输入，不是新 API 字段；正式消费者必须校验其来源绑定，不能把任意调用参数当作已批准假设。无 readiness 的新假设不得偷偷补入。摘要不含坐标、票价、开放时间、路线、sourceRefs、factSnapshotRefs、qualityReport 或“已核验/可保存”的正式结论；其 recommended 文案只解释偏好，不能宣称准确事实。失败返回 VALIDATION_ERROR 或统一技术错误，正式版本写入数为 0。

<!-- contract:travel-summary-v1 -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "title",
    "description",
    "durationDays",
    "destinations",
    "bestFor",
    "overallRecommendation",
    "recommendedReason",
    "requirementRevision",
    "requirementHash"
  ],
  "properties": {
    "schemaVersion": {
      "const": 1
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 80,
      "format": "nonblank-text"
    },
    "description": {
      "type": "string",
      "minLength": 1,
      "maxLength": 1200,
      "format": "nonblank-text"
    },
    "durationDays": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 365
    },
    "destinations": {
      "type": "array",
      "minItems": 1,
      "maxItems": 20,
      "items": {
        "$ref": "travel-requirement-v1#/$defs/Destination"
      }
    },
    "bestFor": {
      "type": "array",
      "minItems": 1,
      "maxItems": 8,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80,
        "format": "nonblank-text"
      }
    },
    "overallRecommendation": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500,
      "format": "nonblank-text"
    },
    "recommendedReason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500,
      "format": "nonblank-text"
    },
    "requirementRevision": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "requirementHash": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    }
  }
}
```

## 固定文档 Fixture

以下均为隔离合成文档数据，hash 占位是 fixture 值，不冒充用户或 Provider 证据。checker 用 `base` 构建合法快照，在副本执行 operations；它校验文档规则，不声称 Phase021 合并服务或 Phase017 产品解析器已经实现。

<!-- contract:schema-fixtures -->
```json
{
  "environment": "ISOLATED_SYNTHETIC",
  "base": {
    "schemaVersion": 1,
    "revision": 1,
    "origin": {
      "city": "深圳",
      "country": "CN",
      "confidence": 1
    },
    "destinations": [
      {
        "id": "dest_shangrao",
        "name": "上饶",
        "city": "上饶",
        "country": "CN",
        "type": "city",
        "confidence": 1
      },
      {
        "id": "dest_huangshan",
        "name": "黄山",
        "city": "黄山",
        "country": "CN",
        "type": "city",
        "confidence": 1
      }
    ],
    "dateRange": {
      "startDate": "2026-09-05",
      "endDate": "2026-09-06",
      "text": "这周末",
      "isFlexible": false,
      "timezone": "Asia/Shanghai",
      "confidence": 1
    },
    "durationDays": 2,
    "travelers": {
      "totalCount": 2,
      "adultCount": 1,
      "childCount": 0,
      "elderCount": 1,
      "ageUnknownCount": 0,
      "relationship": "family",
      "notes": [],
      "hasChild": false,
      "hasElder": true,
      "isCouple": false,
      "isFamily": true,
      "confidence": 1
    },
    "budget": {
      "amount": "3000",
      "currency": "CNY",
      "level": null,
      "isFlexible": false,
      "perPerson": true,
      "hardLimit": true,
      "confidence": 1
    },
    "preferences": {
      "pace": "slow",
      "interests": [
        "美食"
      ],
      "avoid": [],
      "transport": [
        "high_speed_rail"
      ],
      "hardConstraints": [],
      "accessibility": {
        "stepFreeRequired": null,
        "maxWalkingMinutes": null,
        "notes": []
      },
      "consent": {
        "sensitiveRequirementProcessing": null
      },
      "confidence": 1
    },
    "specialFlags": {
      "isSelfDriving": false,
      "isHiking": false,
      "isOverseas": false
    },
    "fieldSources": [
      {
        "field": "origin",
        "messageId": "fixture_message_a",
        "inputHash": "1111111111111111111111111111111111111111111111111111111111111111",
        "method": "USER_TEXT",
        "confidence": 1
      },
      {
        "field": "destinations",
        "messageId": "fixture_message_a",
        "inputHash": "1111111111111111111111111111111111111111111111111111111111111111",
        "method": "USER_TEXT",
        "confidence": 1
      },
      {
        "field": "dateRange",
        "messageId": "fixture_message_a",
        "inputHash": "1111111111111111111111111111111111111111111111111111111111111111",
        "method": "USER_TEXT",
        "confidence": 1
      },
      {
        "field": "durationDays",
        "messageId": null,
        "inputHash": "1111111111111111111111111111111111111111111111111111111111111111",
        "method": "DERIVED",
        "confidence": 1
      },
      {
        "field": "travelers",
        "messageId": "fixture_message_a",
        "inputHash": "1111111111111111111111111111111111111111111111111111111111111111",
        "method": "USER_TEXT",
        "confidence": 1
      },
      {
        "field": "budget",
        "messageId": "fixture_message_a",
        "inputHash": "1111111111111111111111111111111111111111111111111111111111111111",
        "method": "USER_TEXT",
        "confidence": 1
      },
      {
        "field": "preferences.pace",
        "messageId": "fixture_message_a",
        "inputHash": "1111111111111111111111111111111111111111111111111111111111111111",
        "method": "USER_TEXT",
        "confidence": 1
      },
      {
        "field": "preferences.interests",
        "messageId": "fixture_message_a",
        "inputHash": "1111111111111111111111111111111111111111111111111111111111111111",
        "method": "USER_TEXT",
        "confidence": 1
      },
      {
        "field": "preferences.transport",
        "messageId": "fixture_message_a",
        "inputHash": "1111111111111111111111111111111111111111111111111111111111111111",
        "method": "USER_TEXT",
        "confidence": 1
      }
    ],
    "missingFields": []
  },
  "cases": [
    {
      "id": "valid-ordered-destinations",
      "expected": "PASS",
      "changes": []
    },
    {
      "id": "unknown-money-not-zero",
      "expected": "PASS",
      "changes": [
        {
          "path": "budget.amount",
          "value": null
        },
        {
          "path": "budget.currency",
          "value": null
        }
      ]
    },
    {
      "id": "explicit-zero-budget",
      "expected": "PASS",
      "changes": [
        {
          "path": "budget.amount",
          "value": "0"
        }
      ]
    },
    {
      "id": "numeric-money-rejected",
      "expected": "FAIL",
      "changes": [
        {
          "path": "budget.amount",
          "value": 0
        }
      ]
    },
    {
      "id": "invalid-calendar-date",
      "expected": "FAIL",
      "changes": [
        {
          "path": "dateRange.startDate",
          "value": "2026-02-30"
        },
        {
          "path": "dateRange.endDate",
          "value": "2026-03-03"
        }
      ]
    },
    {
      "id": "invalid-zone",
      "expected": "FAIL",
      "changes": [
        {
          "path": "dateRange.timezone",
          "value": "GMT+8"
        }
      ]
    },
    {
      "id": "absent-full-field",
      "expected": "FAIL",
      "changes": [
        {
          "path": "origin",
          "remove": true
        }
      ]
    },
    {
      "id": "unknown-origin",
      "expected": "PASS",
      "changes": [
        {
          "path": "origin",
          "value": null
        },
        {
          "path": "specialFlags.isOverseas",
          "value": null
        }
      ]
    },
    {
      "id": "empty-preference",
      "expected": "PASS",
      "changes": [
        {
          "path": "preferences.interests",
          "value": []
        }
      ]
    },
    {
      "id": "empty-string-origin",
      "expected": "FAIL",
      "changes": [
        {
          "path": "origin.city",
          "value": ""
        }
      ]
    },
    {
      "id": "duplicate-stable-id",
      "expected": "FAIL",
      "changes": [
        {
          "path": "destinations.1.id",
          "value": "dest_shangrao"
        }
      ]
    },
    {
      "id": "overlapping-age-count",
      "expected": "FAIL",
      "changes": [
        {
          "path": "travelers.adultCount",
          "value": 2
        }
      ]
    },
    {
      "id": "unknown-age-not-elder",
      "expected": "PASS",
      "changes": [
        {
          "path": "travelers.adultCount",
          "value": null
        },
        {
          "path": "travelers.elderCount",
          "value": null
        },
        {
          "path": "travelers.ageUnknownCount",
          "value": null
        },
        {
          "path": "travelers.hasElder",
          "value": null
        }
      ]
    },
    {
      "id": "fractional-count",
      "expected": "FAIL",
      "changes": [
        {
          "path": "travelers.totalCount",
          "value": 2.5
        }
      ]
    },
    {
      "id": "wrong-draft-version",
      "expected": "FAIL",
      "changes": [
        {
          "path": "schemaVersion",
          "value": 2
        }
      ]
    },
    {
      "id": "undeclared-fact",
      "expected": "FAIL",
      "changes": [
        {
          "path": "coordinates",
          "value": [
            0,
            0
          ]
        }
      ]
    },
    {
      "id": "canonical-decimal-fraction",
      "expected": "PASS",
      "changes": [
        {
          "path": "budget.amount",
          "value": "12.5"
        }
      ]
    },
    {
      "id": "three-decimal-currency",
      "expected": "PASS",
      "changes": [
        {
          "path": "budget.currency",
          "value": "BHD"
        },
        {
          "path": "budget.amount",
          "value": "1.234"
        }
      ]
    },
    {
      "id": "unknown-currency-four-decimals",
      "expected": "PASS",
      "changes": [
        {
          "path": "budget.currency",
          "value": null
        },
        {
          "path": "budget.amount",
          "value": "1.2345"
        }
      ]
    },
    {
      "id": "currency-precision-rejected",
      "expected": "FAIL",
      "changes": [
        {
          "path": "budget.amount",
          "value": "1.234"
        }
      ]
    },
    {
      "id": "zero-decimal-currency-rejected",
      "expected": "FAIL",
      "changes": [
        {
          "path": "budget.currency",
          "value": "JPY"
        },
        {
          "path": "budget.amount",
          "value": "1.5"
        }
      ]
    },
    {
      "id": "negative-money-rejected",
      "expected": "FAIL",
      "changes": [
        {
          "path": "budget.amount",
          "value": "-1"
        }
      ]
    },
    {
      "id": "exponent-money-rejected",
      "expected": "FAIL",
      "changes": [
        {
          "path": "budget.amount",
          "value": "1e3"
        }
      ]
    },
    {
      "id": "leading-zero-money-rejected",
      "expected": "FAIL",
      "changes": [
        {
          "path": "budget.amount",
          "value": "01"
        }
      ]
    },
    {
      "id": "trailing-zero-money-rejected",
      "expected": "FAIL",
      "changes": [
        {
          "path": "budget.amount",
          "value": "1.00"
        }
      ]
    },
    {
      "id": "money-whitespace-rejected",
      "expected": "FAIL",
      "changes": [
        {
          "path": "budget.amount",
          "value": " 1"
        }
      ]
    },
    {
      "id": "unknown-currency-code-rejected",
      "expected": "FAIL",
      "changes": [
        {
          "path": "budget.currency",
          "value": "XXX"
        }
      ]
    },
    {
      "id": "pseudo-country-code-rejected",
      "expected": "FAIL",
      "changes": [
        {
          "path": "origin.country",
          "value": "ZZ"
        },
        {
          "path": "specialFlags.isOverseas",
          "value": true
        }
      ]
    },
    {
      "id": "valid-leap-date",
      "expected": "PASS",
      "changes": [
        {
          "path": "dateRange.startDate",
          "value": "2028-02-28"
        },
        {
          "path": "dateRange.endDate",
          "value": "2028-02-29"
        }
      ]
    },
    {
      "id": "invalid-nonleap-date",
      "expected": "FAIL",
      "changes": [
        {
          "path": "dateRange.startDate",
          "value": "2026-02-29"
        },
        {
          "path": "dateRange.endDate",
          "value": "2026-03-02"
        }
      ]
    },
    {
      "id": "date-year-zero-rejected",
      "expected": "FAIL",
      "changes": [
        {
          "path": "dateRange.startDate",
          "value": "0000-01-01"
        },
        {
          "path": "dateRange.endDate",
          "value": "0000-01-02"
        }
      ]
    },
    {
      "id": "reversed-date-window",
      "expected": "FAIL",
      "changes": [
        {
          "path": "dateRange.startDate",
          "value": "2026-09-07"
        }
      ]
    },
    {
      "id": "partial-date-window",
      "expected": "FAIL",
      "changes": [
        {
          "path": "dateRange.endDate",
          "value": null
        }
      ]
    },
    {
      "id": "date-without-zone",
      "expected": "FAIL",
      "changes": [
        {
          "path": "dateRange.timezone",
          "remove": true
        }
      ]
    },
    {
      "id": "fixed-duration-mismatch",
      "expected": "FAIL",
      "changes": [
        {
          "path": "durationDays",
          "value": 3
        }
      ]
    },
    {
      "id": "flexible-window-keeps-duration",
      "expected": "PASS",
      "changes": [
        {
          "path": "dateRange.isFlexible",
          "value": true
        },
        {
          "path": "dateRange.endDate",
          "value": "2026-09-10"
        }
      ]
    },
    {
      "id": "flexible-window-too-short",
      "expected": "FAIL",
      "changes": [
        {
          "path": "dateRange.isFlexible",
          "value": true
        },
        {
          "path": "dateRange.endDate",
          "value": "2026-09-05"
        }
      ]
    },
    {
      "id": "numeric-destination-id-rejected",
      "expected": "FAIL",
      "changes": [
        {
          "path": "destinations.0.id",
          "value": 0
        }
      ]
    },
    {
      "id": "known-fields-require-sources",
      "expected": "FAIL",
      "changes": [
        {
          "path": "fieldSources",
          "value": []
        }
      ]
    },
    {
      "id": "unsafe-revision-rejected",
      "expected": "FAIL",
      "changes": [
        {
          "path": "revision",
          "value": 9007199254740992
        }
      ]
    },
    {
      "id": "origin-null-object-rejected",
      "expected": "FAIL",
      "changes": [
        {
          "path": "origin",
          "value": {
            "city": null,
            "country": null,
            "confidence": 0
          }
        },
        {
          "path": "specialFlags.isOverseas",
          "value": null
        }
      ]
    },
    {
      "id": "date-null-object-rejected",
      "expected": "FAIL",
      "changes": [
        {
          "path": "dateRange.startDate",
          "value": null
        },
        {
          "path": "dateRange.endDate",
          "value": null
        },
        {
          "path": "dateRange.text",
          "value": null
        },
        {
          "path": "durationDays",
          "value": null
        }
      ]
    },
    {
      "id": "whitespace-location-rejected",
      "expected": "FAIL",
      "changes": [
        {
          "path": "origin.city",
          "value": "   "
        }
      ]
    }
  ],
  "patchCases": [
    {
      "id": "absent-patch-retains-origin",
      "patch": {
        "baseRevision": 1,
        "set": {},
        "clearFields": [],
        "arrayOps": []
      },
      "expected": "PASS",
      "assertPath": "origin.city",
      "assertValue": "深圳"
    },
    {
      "id": "clear-origin-to-unknown",
      "patch": {
        "baseRevision": 1,
        "set": {},
        "clearFields": [
          "origin"
        ],
        "arrayOps": []
      },
      "expected": "PASS",
      "assertPath": "origin",
      "assertValue": null
    },
    {
      "id": "null-cannot-delete-known",
      "patch": {
        "baseRevision": 1,
        "set": {
          "origin": null
        },
        "clearFields": [],
        "arrayOps": []
      },
      "expected": "FAIL"
    },
    {
      "id": "explicit-empty-array",
      "patch": {
        "baseRevision": 1,
        "set": {
          "preferences.interests": []
        },
        "clearFields": [],
        "arrayOps": []
      },
      "expected": "PASS",
      "assertPath": "preferences.interests",
      "assertValue": []
    },
    {
      "id": "array-add-dedup",
      "patch": {
        "baseRevision": 1,
        "set": {},
        "clearFields": [],
        "arrayOps": [
          {
            "field": "preferences.interests",
            "op": "add",
            "values": [
              "美食",
              "摄影"
            ]
          }
        ]
      },
      "expected": "PASS",
      "assertPath": "preferences.interests",
      "assertValue": [
        "美食",
        "摄影"
      ]
    },
    {
      "id": "array-remove-stable-id",
      "patch": {
        "baseRevision": 1,
        "set": {},
        "clearFields": [],
        "arrayOps": [
          {
            "field": "destinations",
            "op": "remove",
            "values": [
              "dest_shangrao"
            ]
          }
        ]
      },
      "expected": "PASS",
      "assertPath": "destinations.0.id",
      "assertValue": "dest_huangshan"
    },
    {
      "id": "array-remove-by-index-rejected",
      "patch": {
        "baseRevision": 1,
        "set": {},
        "clearFields": [],
        "arrayOps": [
          {
            "field": "destinations",
            "op": "remove",
            "values": [
              0
            ]
          }
        ]
      },
      "expected": "FAIL"
    },
    {
      "id": "stale-revision-rejected",
      "patch": {
        "baseRevision": 0,
        "set": {},
        "clearFields": [],
        "arrayOps": []
      },
      "expected": "VERSION_CONFLICT"
    },
    {
      "id": "overlapping-patch-rejected",
      "patch": {
        "baseRevision": 1,
        "set": {
          "origin": null
        },
        "clearFields": [
          "origin"
        ],
        "arrayOps": []
      },
      "expected": "FAIL"
    },
    {
      "id": "implicit-consent-rejected",
      "patch": {
        "baseRevision": 1,
        "set": {
          "preferences.consent": {
            "sensitiveRequirementProcessing": true
          }
        },
        "clearFields": [],
        "arrayOps": []
      },
      "expected": "FAIL"
    },
    {
      "id": "explicit-consent-control",
      "userControl": true,
      "patch": {
        "baseRevision": 1,
        "set": {
          "preferences.consent": {
            "sensitiveRequirementProcessing": true
          }
        },
        "clearFields": [],
        "arrayOps": []
      },
      "expected": "PASS",
      "assertPath": "preferences.consent.sensitiveRequirementProcessing",
      "assertValue": true
    },
    {
      "id": "clear-consent-denies",
      "patch": {
        "baseRevision": 1,
        "set": {},
        "clearFields": [
          "preferences.consent"
        ],
        "arrayOps": []
      },
      "expected": "PASS",
      "assertPath": "preferences.consent.sensitiveRequirementProcessing",
      "assertValue": false
    },
    {
      "id": "nested-null-cannot-delete-budget",
      "patch": {
        "baseRevision": 1,
        "set": {
          "budget": {
            "amount": null,
            "currency": "CNY",
            "level": null,
            "isFlexible": false,
            "perPerson": true,
            "hardLimit": true,
            "confidence": 1
          }
        },
        "clearFields": [],
        "arrayOps": []
      },
      "expected": "FAIL"
    },
    {
      "id": "nested-null-cannot-delete-origin",
      "patch": {
        "baseRevision": 1,
        "set": {
          "origin": {
            "city": null,
            "country": "CN",
            "confidence": 1
          }
        },
        "clearFields": [],
        "arrayOps": []
      },
      "expected": "FAIL"
    },
    {
      "id": "set-cannot-reassign-stable-id",
      "patch": {
        "baseRevision": 1,
        "set": {
          "destinations": [
            {
              "id": "dest_shangrao",
              "name": "合成另一城市",
              "city": "上饶",
              "country": "CN",
              "type": "city",
              "confidence": 1
            }
          ]
        },
        "clearFields": [],
        "arrayOps": []
      },
      "expected": "FAIL"
    },
    {
      "id": "replace-cannot-reassign-stable-id",
      "patch": {
        "baseRevision": 1,
        "set": {},
        "clearFields": [],
        "arrayOps": [
          {
            "field": "destinations",
            "op": "replace",
            "values": [
              {
                "id": "dest_shangrao",
                "name": "合成另一城市",
                "city": "上饶",
                "country": "CN",
                "type": "city",
                "confidence": 1
              }
            ]
          }
        ]
      },
      "expected": "FAIL"
    },
    {
      "id": "add-cannot-reassign-stable-id",
      "patch": {
        "baseRevision": 1,
        "set": {},
        "clearFields": [],
        "arrayOps": [
          {
            "field": "destinations",
            "op": "add",
            "values": [
              {
                "id": "dest_shangrao",
                "name": "合成另一城市",
                "city": "上饶",
                "country": "CN",
                "type": "city",
                "confidence": 1
              }
            ]
          }
        ]
      },
      "expected": "FAIL"
    },
    {
      "id": "array-remove-name-rejected",
      "patch": {
        "baseRevision": 1,
        "set": {},
        "clearFields": [],
        "arrayOps": [
          {
            "field": "destinations",
            "op": "remove",
            "values": [
              "上饶"
            ]
          }
        ]
      },
      "expected": "FAIL"
    },
    {
      "id": "explicit-destination-reorder",
      "patch": {
        "baseRevision": 1,
        "set": {},
        "clearFields": [],
        "arrayOps": [
          {
            "field": "destinations",
            "op": "replace",
            "values": [
              {
                "id": "dest_huangshan",
                "name": "黄山",
                "city": "黄山",
                "country": "CN",
                "type": "city",
                "confidence": 1
              },
              {
                "id": "dest_shangrao",
                "name": "上饶",
                "city": "上饶",
                "country": "CN",
                "type": "city",
                "confidence": 1
              }
            ]
          }
        ]
      },
      "expected": "PASS",
      "assertPath": "destinations.0.id",
      "assertValue": "dest_huangshan"
    },
    {
      "id": "clear-date-removes-derived-duration",
      "patch": {
        "baseRevision": 1,
        "set": {},
        "clearFields": [
          "dateRange"
        ],
        "arrayOps": []
      },
      "expected": "PASS",
      "assertPath": "durationDays",
      "assertValue": null
    },
    {
      "id": "clear-date-keeps-explicit-duration",
      "patch": {
        "baseRevision": 1,
        "set": {
          "durationDays": 3
        },
        "clearFields": [
          "dateRange"
        ],
        "arrayOps": []
      },
      "expected": "PASS",
      "assertPath": "durationDays",
      "assertValue": 3
    },
    {
      "id": "clear-budget-to-unknown",
      "patch": {
        "baseRevision": 1,
        "set": {},
        "clearFields": [
          "budget"
        ],
        "arrayOps": []
      },
      "expected": "PASS",
      "assertPath": "budget.amount",
      "assertValue": null
    },
    {
      "id": "unknown-set-field-rejected",
      "patch": {
        "baseRevision": 1,
        "set": {
          "confirmationStatus": "READY_FOR_PLANNING"
        },
        "clearFields": [],
        "arrayOps": []
      },
      "expected": "FAIL"
    },
    {
      "id": "source-write-rejected",
      "patch": {
        "baseRevision": 1,
        "set": {},
        "clearFields": [
          "fieldSources"
        ],
        "arrayOps": []
      },
      "expected": "FAIL"
    },
    {
      "id": "null-array-operation-rejected",
      "patch": {
        "baseRevision": 1,
        "set": {},
        "clearFields": [],
        "arrayOps": [
          null
        ]
      },
      "expected": "FAIL"
    },
    {
      "id": "fractional-base-revision-rejected",
      "patch": {
        "baseRevision": 1.5,
        "set": {},
        "clearFields": [],
        "arrayOps": []
      },
      "expected": "FAIL"
    }
  ]
}
```

补丁解释器只验证本页的核心类型、合并、显式清除、来源和身份约束；它不模拟尚未生产的 readiness、数据库幂等账本或权限服务。运行时在 Phase021 必须继续重算完整 missingFields 后才能持久化；这里的 core Schema 通过不表示 READY_FOR_PLANNING。

## Phase024 演进边界

Phase024 首次定义 TravelPlanDraftV2/TravelPlanV2、PlanningWorkspace、正式 Place/Fact/Route/PlanEvent/QualityReport 及其运行时 Schema；当前文档不提前生产它们。该卡以显式 `promoteSummaryV1ToDraftV2(summary, requirement, context)` 单向提升函数消费 v1，验证 revision/hash/目的地顺序后生成明确的阶段 Draft，占位只可取该卡允许的 null/[]/pending。v1 仅留在提升输入，业务生产统一 v2；不反向降级、不双写、不创建兼容字段或“择一”别名。Draft 必须经过独立完整 validator 和正式保存入口，不能因 schemaVersion=2 就取得保存资格。

文档校验命令：`node docs/phase-plans/check-phase002-schema-prompt.mjs --case schema --json`。固定 fixture 覆盖严格结构、人数、日期与 zone、金额、稳定 id、unknown/empty/clear、补丁 CAS 与 summary 绑定；删 required、放宽金额类型、删 Prompt key 的临时副本检查须失败。产品端到端验证分别由 Phase017/019-024 首次生产并记录新证据，当前不宣称已运行。

<!-- contract:schema-evolution-policy -->
```json
{
  "producerPhase": 24,
  "source": "TravelPlanSummaryDraft",
  "sourceSchemaVersion": 1,
  "target": "TravelPlanDraftV2",
  "promotionFunction": "promoteSummaryV1ToDraftV2",
  "direction": "ONE_WAY",
  "bindingChecks": [
    "requirementRevision",
    "requirementHash",
    "orderedDestinationIds"
  ],
  "reverseConversionAllowed": false,
  "dualWriteAllowed": false,
  "historyRewriteAllowed": false,
  "formalSaveFromPromotionAllowed": false
}
```

文档验收固定执行 82 个唯一 fixture（43 个完整需求、26 个补丁、13 个摘要绑定），另有 10 个隔离变异与自检：8 个普通变异只接受 CONTRACT_ASSERTION / AssertionError / ERR_ASSERTION；既有 negative-fixture-runtime-error 单列为 CHECKER_RUNTIME_REJECTION，限定 CHECKER_RUNTIME_ERROR / TypeError / null；另有 1 个外层 runner 自检，向普通变异注入相同诊断文字的 TypeError，必须使外层验收退出 1。每项精确匹配固定 diagnostic，并记录 failureClass/errorName/errorCode，恢复副本后必须退出 0；TypeError、ReferenceError、SyntaxError 等运行错误不能冒充普通变异的契约断言。fixture ID 集合在检查脚本独立冻结，重复/遗漏不能靠调总数绕过。结果仅代表本页文档规则，币种字典和 JSON Schema 的 hash 由当前 Phase 证据绑定。
