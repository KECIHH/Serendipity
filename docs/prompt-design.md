# Serendipity · 际遇 Prompt 契约

Owner: AI 治理与受控调用；producerPhase: 2；生产正文/版本/激活首次生产: Phase015；运行时输出 Schema: Phase017；业务消费者见八 key 注册表。本文唯一冻结允许变量、响应结构、边界与失败行为，不保存可执行生产 Prompt 正文。Phase015 根据这些规则创建受审模板、记录 contentHash 并持久化；此后每次正文或模板变量变化必须产生新的不可变 PromptVersion。

规范化路线输入绝对路径与 SHA-256 见 [Phase002 输入清单](phase-plans/Phase002-inputs.json)。[数据库规范](database.md) 唯一拥有治理表字段，[旅行 Schema](travel-plan-schema.md) 唯一拥有需求与摘要结构，[API](api.md) 唯一拥有公开错误映射，[隐私规范](privacy-and-user-data.md) 拥有数据最小化/日志/保留边界；这些文档不复制生产模板。

## 正文、版本与激活

生产正文只能来自 PromptDefinition + 不可变 PromptVersion + PromptActivation。definition.key 唯一；version/contentHash/variablesJson/responseSchemaVersion 与 createdAt 不可变。反向禁止项：PromptConfig、源码 system prompt、enabled/status 筛选正文、从 SystemConfig 或客户端选择 Prompt/模型/baseUrl，都不能成为生产读取路径。

PromptActivation 与 PromptModelActivation 通过 activatePromptModelTuple 在同一事务更新，同一 definition、同一 PromptVersion、同一 revision；数据库拒绝单侧切换。一次调用冻结 PromptVersion、ModelDeployment(id,configVersion)、ProviderConfigVersion(providerId,configVersion)、activationRevision 与 PlanningPolicyVersion。关闭开关优先，失效/缺配置/变量或响应版本不兼容即零外呼。

Phase015 bootstrap 为全部八 key 创建 version 1 和完整 MOCK 元组，PromptModelActivation=DISABLED，ai.calls.enabled=false。第一次启用通过正式受控服务完成评测、完整元组激活与显式开启。Phase019-023 的模板改进也新增不可变版本，不重置既有版本。Phase090 的 champion/challenger、回滚与评测复用同一激活服务；评测失败不能换指针。

## 注入与数据边界

用户原文始终是独立 `role=user` message，不拼进 system message。结构化 requirement、候选、错误、来源文字和 rawText 同样视为不可信数据，以独立 user data message 的 JSON 载荷传递；系统规则只来自冻结模板。只有已校验为 canonical BCP47 的 locale、真实日期 serverDate、IANA timezone 和封闭枚举 stage/targetSchemaId 可作 system 规则的受限标量替换，不允许动态模板表达式、HTML 执行或任意对象字符串替换。渲染前后都验证 exact 结构、字符数、UTF-8 总字节、模型 context window 和输出上限；缺变量、未知变量、undefined、额外键和长度溢出均 CONFIG_ERROR、零外呼。

所有变量默认 private。传给模型前裁除账号、密码、Cookie、token、密钥、完整历史、内部配置、私人地址/坐标与未授权健康信息；preferences.consent.sensitiveRequirementProcessing 未明确 true 时，敏感需求原文不能外发。最小行动约束能以无身份的结构化布尔/界限表达时仍须按实际授权和 Provider 区域策略检查，不用标注 publicSafe 绕过投影。Prompt 不授予任何权限，不接受模型回传 consent、owner、状态、revision、hash、坐标或保存资格。

Phase017 NluContext exact 为 serverDate/timezone/locale/planningMode/ownerContext/traceId/requestId/signal/deadlineAt/tokenBudget/costBudget，全部由服务端注入；Phase019-023 每个子函数必须接收同一个 ctx。它是服务控制上下文，不是完整模型变量；ownerContext、signal、trace/request id 和预算不发给模型。所有尝试共享取消信号、总 deadline 和剩余预算；取消后零下游调用。AI 原文只在有界请求内存中解析，production AiOutputRecord.rawOutput=null；显式 mock/debug capturePolicy 才可保存裁剪合成内容。日志/evidence 仅留 hash、版本、类别、token 与时延，不留 raw output、Prompt 或秘密。

## 八个 key

下表解释消费关系，下一具名 JSON 块是变量/响应/长度与版本的机器权威。所有变量均必填；可空变量仅 planner.final_summary.budgetSummary，null 表示尚无可叙述预算，不可用空字符串代替。字符串上限按 Unicode code point，maxBytes 按 UTF-8 序列化整体；集合/对象变量的 maxLength 表示序列化字符上限，各成员另有 Schema 上限。

| key | 用途 | 首次消费者与输出边界 |
|---|---|---|
| nlu.extract | 识别用户原文跨度、语义候选与 confidence | Phase019 核心实体，020 参数，021 约束；输出仍是原文候选。确定性层生成日期/金额/id/派生标记并合并为 TravelRequirement |
| nlu.ask_missing | 将已有 MissingFieldSpec 润色为最多三个问题 | Phase021；不能新增/删除缺失项或改变 priority，未润色的完整清单由确定性 fallback 补足 |
| planner.generate | 根据需求与明确假设生成五项概要文案 | Phase022；服务端加入时长、同序目的地和 revision/hash，得到十字段 TravelPlanSummaryDraft v1；不是完整计划生成器 |
| planner.repair_json | 仅修可证明保持全部值/字段绑定的语法、括号与成对 code fence | Phase017；修复最多 2 次，共享原预算。不得补缺失事实/id/日期/价格；修复结果重过原目标 Schema |
| conversation.modify | 把用户意图匹配到服务端给定候选操作/目标 | Phase053；v1 输出解释性 Mutation 草案，不能执行。该卡将 requestedText 通过既定 operation/requestedChange 封闭联合解析，做真实 TargetRef、锁、范围、确认与 CAS 校验 |
| planner.score | 为已计算的分数与理由生成 explanation | Phase045；不产出 score/weight/overall/evidenceRefs，AI 文案变化不能改变分数或执行 hash |
| planner.final_summary | 根据已验证计划摘要生成最后说明 | Phase048；只读摘要、每日亮点、预算、风险、assumptions 和 limitations，不新增事实或覆盖 qualityReport |
| export.markdown | 隔离合成文案实验 | Phase015 mock/debug 首次消费；Phase104 明确禁止用于正式导出，正式 Markdown 始终从授权 PlanViewModel 确定性渲染 |

planner.generate 的 requirement 变量是 SummaryRequirementInput 私人最小投影，不能直接序列化 TravelRequirement：只投影地点意图、日期窗口、人数、预算以及枚举 pace/interests/transport，排除 id/revision/fieldSources/missingFields/confidence/notes/consent 和自由 hardConstraints/avoid/accessibility 原文。完整需求和已授权约束仍由服务端规划器消费；投影不会替代持久需求，最终绑定使用原快照的 revision/hash。所有其他自由文本变量仍须按隐私规范裁剪和授权；投影不构成全局脱敏判据。

注册表的 templateRules 是需要评测的规则标识，不是另一份正文。candidateId 仅是调用前冻结的候选表身份，不能让模型新建正式 id。nlu.extract.text 必须是 userText 的连续原文片段；confidence 仅表示模型识别信心，不代表事实可信度。

<!-- contract:prompt-keys -->
```json
{
  "schemaVersion": 1,
  "governanceProducerPhase": 15,
  "runtimeSchemaProducerPhase": 17,
  "bodyAuthority": [
    "PromptDefinition",
    "PromptVersion",
    "PromptActivation"
  ],
  "activationService": "activatePromptModelTuple",
  "defaultActivationStatus": "DISABLED",
  "productionRawOutput": null,
  "maxRepairAttempts": 2,
  "$defs": {
    "Locale": {
      "type": "string",
      "minLength": 2,
      "maxLength": 35,
      "format": "bcp47-locale"
    },
    "Text": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500,
      "format": "nonblank-text"
    },
    "TextList": {
      "type": "array",
      "maxItems": 30,
      "items": {
        "$ref": "#/$defs/Text"
      }
    },
    "Dimension": {
      "enum": [
        "comfort",
        "budgetFit",
        "routeEfficiency",
        "scheduleFeasibility",
        "attractionFit",
        "foodFit",
        "photographyFit",
        "accessibility",
        "weatherResilience",
        "sourceReliability"
      ]
    },
    "Operation": {
      "enum": [
        "ADD",
        "REMOVE",
        "REPLACE",
        "MOVE_EVENT",
        "CHANGE_TRANSPORT",
        "UPDATE_CONSTRAINT",
        "LOCK",
        "UNLOCK",
        "REPLAN_SCOPE"
      ]
    },
    "Candidate": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "candidateId",
        "label",
        "allowedOperations"
      ],
      "properties": {
        "candidateId": {
          "$ref": "travel-requirement-v1#/$defs/Id"
        },
        "label": {
          "$ref": "#/$defs/Text"
        },
        "allowedOperations": {
          "type": "array",
          "minItems": 1,
          "maxItems": 9,
          "uniqueItems": true,
          "items": {
            "$ref": "#/$defs/Operation"
          }
        }
      }
    },
    "MissingFieldSpec": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "field",
        "priority",
        "reasonCode"
      ],
      "properties": {
        "field": {
          "$ref": "travel-requirement-v1#/$defs/FieldPath"
        },
        "priority": {
          "enum": [
            "blocking",
            "normal",
            "optional"
          ]
        },
        "reasonCode": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80,
          "pattern": "^[A-Z][A-Z0-9_]+$",
          "format": "nonblank-text"
        }
      }
    },
    "SummaryRequirementInput": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "origin",
        "destinations",
        "dateRange",
        "durationDays",
        "travelers",
        "budget",
        "preferences"
      ],
      "properties": {
        "origin": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "city",
                "country"
              ],
              "properties": {
                "city": {
                  "$ref": "travel-requirement-v1#/$defs/NullableText"
                },
                "country": {
                  "$ref": "travel-requirement-v1#/$defs/Country"
                }
              }
            },
            {
              "type": "null"
            }
          ]
        },
        "destinations": {
          "type": "array",
          "minItems": 1,
          "maxItems": 20,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "name",
              "city",
              "country",
              "type"
            ],
            "properties": {
              "name": {
                "$ref": "travel-requirement-v1#/$defs/Text"
              },
              "city": {
                "$ref": "travel-requirement-v1#/$defs/NullableText"
              },
              "country": {
                "$ref": "travel-requirement-v1#/$defs/Country"
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
              }
            }
          }
        },
        "dateRange": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "startDate",
                "endDate",
                "isFlexible",
                "timezone"
              ],
              "properties": {
                "startDate": {
                  "$ref": "travel-requirement-v1#/$defs/Date"
                },
                "endDate": {
                  "$ref": "travel-requirement-v1#/$defs/Date"
                },
                "isFlexible": {
                  "type": "boolean"
                },
                "timezone": {
                  "type": "string",
                  "format": "iana-timezone",
                  "maxLength": 80
                }
              }
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
          "type": "object",
          "additionalProperties": false,
          "required": [
            "totalCount",
            "adultCount",
            "childCount",
            "elderCount",
            "ageUnknownCount",
            "relationship"
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
              "$ref": "travel-requirement-v1#/$defs/Count"
            },
            "childCount": {
              "$ref": "travel-requirement-v1#/$defs/Count"
            },
            "elderCount": {
              "$ref": "travel-requirement-v1#/$defs/Count"
            },
            "ageUnknownCount": {
              "$ref": "travel-requirement-v1#/$defs/Count"
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
            }
          }
        },
        "budget": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "amount",
            "currency",
            "level",
            "isFlexible",
            "perPerson",
            "hardLimit"
          ],
          "properties": {
            "amount": {
              "$ref": "travel-requirement-v1#/$defs/Amount"
            },
            "currency": {
              "$ref": "travel-requirement-v1#/$defs/Currency"
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
              "$ref": "travel-requirement-v1#/$defs/NullableBoolean"
            },
            "perPerson": {
              "$ref": "travel-requirement-v1#/$defs/NullableBoolean"
            },
            "hardLimit": {
              "$ref": "travel-requirement-v1#/$defs/NullableBoolean"
            }
          }
        },
        "preferences": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "pace",
            "interests",
            "transport"
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
            }
          }
        }
      }
    }
  },
  "keys": [
    {
      "key": "nlu.extract",
      "purpose": "USER_TEXT_ENTITY_CANDIDATES",
      "firstConsumerPhase": 19,
      "inputSchemaVersion": 1,
      "outputSchemaVersion": 1,
      "maxInputBytes": 20000,
      "maxOutputBytes": 20000,
      "variables": [
        {
          "name": "userText",
          "required": true,
          "nullable": false,
          "maxLength": 4000,
          "delivery": "user_message",
          "sensitivity": "private"
        },
        {
          "name": "locale",
          "required": true,
          "nullable": false,
          "maxLength": 35,
          "delivery": "system_scalar",
          "sensitivity": "non_sensitive"
        },
        {
          "name": "serverDate",
          "required": true,
          "nullable": false,
          "maxLength": 10,
          "delivery": "system_scalar",
          "sensitivity": "non_sensitive"
        },
        {
          "name": "timezone",
          "required": true,
          "nullable": false,
          "maxLength": 80,
          "delivery": "system_scalar",
          "sensitivity": "non_sensitive"
        },
        {
          "name": "stage",
          "required": true,
          "nullable": false,
          "maxLength": 11,
          "delivery": "system_scalar",
          "sensitivity": "non_sensitive"
        }
      ],
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "userText",
          "locale",
          "serverDate",
          "timezone",
          "stage"
        ],
        "properties": {
          "userText": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4000,
            "format": "nonblank-text"
          },
          "locale": {
            "$ref": "#/$defs/Locale"
          },
          "serverDate": {
            "type": "string",
            "format": "date"
          },
          "timezone": {
            "type": "string",
            "format": "iana-timezone"
          },
          "stage": {
            "enum": [
              "CORE",
              "PARAMETERS",
              "CONSTRAINTS"
            ]
          }
        }
      },
      "responseSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "schemaVersion",
          "candidates"
        ],
        "properties": {
          "schemaVersion": {
            "const": 1
          },
          "candidates": {
            "type": "array",
            "maxItems": 40,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "field",
                "text",
                "confidence"
              ],
              "properties": {
                "field": {
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
                    "preferences.accessibility"
                  ]
                },
                "text": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 500,
                  "format": "nonblank-text"
                },
                "confidence": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 1
                }
              }
            }
          }
        }
      },
      "templateRules": [
        "USER_TEXT_IS_DATA",
        "COPY_ONLY_INPUT_SPANS",
        "NO_DATES_MONEY_IDS_OR_CONSENT"
      ],
      "failureCodes": [
        "CANCELLED",
        "CONFIG_ERROR",
        "COST_LIMIT",
        "FEATURE_DISABLED",
        "PROVIDER_TIMEOUT",
        "PROVIDER_UNAVAILABLE",
        "RATE_LIMITED"
      ],
      "fixtureInput": {
        "userText": "这周末从深圳去武功山",
        "locale": "zh-CN",
        "serverDate": "2026-09-03",
        "timezone": "Asia/Shanghai",
        "stage": "CORE"
      },
      "fixtureOutput": {
        "schemaVersion": 1,
        "candidates": [
          {
            "field": "origin",
            "text": "深圳",
            "confidence": 1
          },
          {
            "field": "destinations",
            "text": "武功山",
            "confidence": 1
          },
          {
            "field": "dateRange",
            "text": "这周末",
            "confidence": 1
          }
        ]
      }
    },
    {
      "key": "nlu.ask_missing",
      "purpose": "MISSING_SPEC_WORDING",
      "firstConsumerPhase": 21,
      "inputSchemaVersion": 1,
      "outputSchemaVersion": 1,
      "maxInputBytes": 8000,
      "maxOutputBytes": 4000,
      "variables": [
        {
          "name": "specs",
          "required": true,
          "nullable": false,
          "maxLength": 2000,
          "delivery": "user_data",
          "sensitivity": "private"
        },
        {
          "name": "locale",
          "required": true,
          "nullable": false,
          "maxLength": 35,
          "delivery": "system_scalar",
          "sensitivity": "non_sensitive"
        }
      ],
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "specs",
          "locale"
        ],
        "properties": {
          "specs": {
            "type": "array",
            "minItems": 1,
            "maxItems": 3,
            "items": {
              "$ref": "#/$defs/MissingFieldSpec"
            }
          },
          "locale": {
            "$ref": "#/$defs/Locale"
          }
        }
      },
      "responseSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "schemaVersion",
          "questions"
        ],
        "properties": {
          "schemaVersion": {
            "const": 1
          },
          "questions": {
            "type": "array",
            "minItems": 1,
            "maxItems": 3,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "field",
                "question"
              ],
              "properties": {
                "field": {
                  "$ref": "travel-requirement-v1#/$defs/FieldPath"
                },
                "question": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 300,
                  "format": "nonblank-text"
                }
              }
            }
          }
        }
      },
      "templateRules": [
        "WORD_ONLY_SELECTED_SPECS",
        "NO_PRIORITY_OR_READINESS_CHANGE",
        "DETERMINISTIC_FALLBACK_FOR_ALL_SPECS"
      ],
      "failureCodes": [
        "CANCELLED",
        "CONFIG_ERROR",
        "COST_LIMIT",
        "FEATURE_DISABLED",
        "PROVIDER_TIMEOUT",
        "PROVIDER_UNAVAILABLE",
        "RATE_LIMITED"
      ],
      "failureFallback": "DETERMINISTIC_QUESTION_FOR_EACH_SPEC",
      "fixtureInput": {
        "specs": [
          {
            "field": "destinations",
            "priority": "blocking",
            "reasonCode": "DESTINATION_UNRESOLVED"
          }
        ],
        "locale": "zh-CN"
      },
      "fixtureOutput": {
        "schemaVersion": 1,
        "questions": [
          {
            "field": "destinations",
            "question": "这次想去哪个城市或地区？"
          }
        ]
      }
    },
    {
      "key": "planner.generate",
      "purpose": "REQUIREMENT_SUMMARY_WORDING",
      "firstConsumerPhase": 22,
      "inputSchemaVersion": 1,
      "outputSchemaVersion": 1,
      "maxInputBytes": 65536,
      "maxOutputBytes": 12000,
      "variables": [
        {
          "name": "requirement",
          "required": true,
          "nullable": false,
          "maxLength": 32768,
          "delivery": "user_data",
          "sensitivity": "private_minimized"
        },
        {
          "name": "assumptionSummaries",
          "required": true,
          "nullable": false,
          "maxLength": 4000,
          "delivery": "user_data",
          "sensitivity": "private_minimized"
        },
        {
          "name": "locale",
          "required": true,
          "nullable": false,
          "maxLength": 35,
          "delivery": "system_scalar",
          "sensitivity": "non_sensitive"
        }
      ],
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "requirement",
          "assumptionSummaries",
          "locale"
        ],
        "properties": {
          "requirement": {
            "$ref": "#/$defs/SummaryRequirementInput"
          },
          "assumptionSummaries": {
            "$ref": "#/$defs/TextList"
          },
          "locale": {
            "$ref": "#/$defs/Locale"
          }
        }
      },
      "responseSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "schemaVersion",
          "title",
          "description",
          "bestFor",
          "overallRecommendation",
          "recommendedReason"
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
          }
        }
      },
      "templateRules": [
        "SUMMARY_WORDING_ONLY",
        "NO_FACTS_OR_SOURCE_REFS",
        "SERVER_ASSEMBLES_V1_BINDING"
      ],
      "failureCodes": [
        "CANCELLED",
        "CONFIG_ERROR",
        "COST_LIMIT",
        "FEATURE_DISABLED",
        "PROVIDER_TIMEOUT",
        "PROVIDER_UNAVAILABLE",
        "RATE_LIMITED",
        "VALIDATION_ERROR"
      ],
      "fixtureInputFrom": "schema-fixtures.base:summary-projection",
      "fixtureInput": {
        "assumptionSummaries": [],
        "locale": "zh-CN"
      },
      "fixtureOutput": {
        "schemaVersion": 1,
        "title": "上饶与黄山两日意向",
        "description": "围绕两处目的地安排较慢节奏，具体安排仍需核验。",
        "bestFor": [
          "偏好美食与慢节奏的旅行者"
        ],
        "overallRecommendation": "先核验跨城交通再确定每日安排。",
        "recommendedReason": "保留原有目的地顺序与慢节奏偏好。"
      }
    },
    {
      "key": "planner.repair_json",
      "purpose": "SYNTAX_ONLY_REPAIR",
      "firstConsumerPhase": 17,
      "inputSchemaVersion": 1,
      "outputSchemaVersion": 1,
      "maxInputBytes": 80000,
      "maxOutputBytes": 80000,
      "variables": [
        {
          "name": "rawText",
          "required": true,
          "nullable": false,
          "maxLength": 16384,
          "delivery": "user_data",
          "sensitivity": "private_ephemeral"
        },
        {
          "name": "errors",
          "required": true,
          "nullable": false,
          "maxLength": 4000,
          "delivery": "user_data",
          "sensitivity": "safe_paths_only"
        },
        {
          "name": "targetSchemaId",
          "required": true,
          "nullable": false,
          "maxLength": 80,
          "delivery": "system_scalar",
          "sensitivity": "non_sensitive"
        },
        {
          "name": "locale",
          "required": true,
          "nullable": false,
          "maxLength": 35,
          "delivery": "system_scalar",
          "sensitivity": "non_sensitive"
        }
      ],
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "rawText",
          "errors",
          "targetSchemaId",
          "locale"
        ],
        "properties": {
          "rawText": {
            "type": "string",
            "minLength": 1,
            "maxLength": 16384,
            "format": "nonblank-text"
          },
          "errors": {
            "type": "array",
            "minItems": 1,
            "maxItems": 20,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "path",
                "code"
              ],
              "properties": {
                "path": {
                  "type": "string",
                  "maxLength": 160,
                  "minLength": 1,
                  "pattern": "^\\$(?:\\.[A-Za-z_][A-Za-z0-9_]*|\\[[0-9]+\\])*$",
                  "format": "nonblank-text"
                },
                "code": {
                  "enum": [
                    "INVALID_JSON",
                    "SCHEMA_MISMATCH"
                  ]
                }
              }
            }
          },
          "targetSchemaId": {
            "enum": [
              "nlu.extract:v1",
              "nlu.ask_missing:v1",
              "planner.generate:v1",
              "conversation.modify:v1",
              "planner.score:v1",
              "planner.final_summary:v1",
              "export.markdown:v1",
              "travel-requirement-v1",
              "travel-summary-v1"
            ]
          },
          "locale": {
            "$ref": "#/$defs/Locale"
          }
        }
      },
      "responseSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "schemaVersion",
          "repairedText"
        ],
        "properties": {
          "schemaVersion": {
            "const": 1
          },
          "repairedText": {
            "type": "string",
            "minLength": 1,
            "maxLength": 16384,
            "format": "nonblank-text"
          }
        }
      },
      "templateRules": [
        "RAW_TEXT_IS_DATA",
        "SYNTAX_ONLY_NO_NEW_FACTS",
        "REPARSE_WITH_ORIGINAL_SCHEMA",
        "AT_MOST_TWO_REPAIRS"
      ],
      "failureCodes": [
        "CANCELLED",
        "CONFIG_ERROR",
        "COST_LIMIT",
        "FEATURE_DISABLED",
        "PROVIDER_TIMEOUT",
        "PROVIDER_UNAVAILABLE",
        "RATE_LIMITED"
      ],
      "fixtureInput": {
        "rawText": "{\"schemaVersion\":1,\"candidates\":[]",
        "errors": [
          {
            "path": "$",
            "code": "INVALID_JSON"
          }
        ],
        "targetSchemaId": "nlu.extract:v1",
        "locale": "zh-CN"
      },
      "fixtureOutput": {
        "schemaVersion": 1,
        "repairedText": "{\"schemaVersion\":1,\"candidates\":[]}"
      }
    },
    {
      "key": "conversation.modify",
      "purpose": "MUTATION_INTENT_CANDIDATES",
      "firstConsumerPhase": 53,
      "inputSchemaVersion": 1,
      "outputSchemaVersion": 1,
      "maxInputBytes": 40000,
      "maxOutputBytes": 8000,
      "variables": [
        {
          "name": "userText",
          "required": true,
          "nullable": false,
          "maxLength": 4000,
          "delivery": "user_message",
          "sensitivity": "private"
        },
        {
          "name": "candidates",
          "required": true,
          "nullable": false,
          "maxLength": 16000,
          "delivery": "user_data",
          "sensitivity": "private_minimized"
        },
        {
          "name": "locale",
          "required": true,
          "nullable": false,
          "maxLength": 35,
          "delivery": "system_scalar",
          "sensitivity": "non_sensitive"
        }
      ],
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "userText",
          "candidates",
          "locale"
        ],
        "properties": {
          "userText": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4000,
            "format": "nonblank-text"
          },
          "candidates": {
            "type": "array",
            "maxItems": 30,
            "items": {
              "$ref": "#/$defs/Candidate"
            }
          },
          "locale": {
            "$ref": "#/$defs/Locale"
          }
        }
      },
      "responseSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "schemaVersion",
          "operation",
          "targetCandidateIds",
          "requestedText",
          "explanation"
        ],
        "properties": {
          "schemaVersion": {
            "const": 1
          },
          "operation": {
            "$ref": "#/$defs/Operation"
          },
          "targetCandidateIds": {
            "type": "array",
            "maxItems": 30,
            "uniqueItems": true,
            "items": {
              "$ref": "travel-requirement-v1#/$defs/Id"
            }
          },
          "requestedText": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2000,
            "format": "nonblank-text"
          },
          "explanation": {
            "$ref": "#/$defs/Text"
          }
        }
      },
      "templateRules": [
        "NO_EXECUTION_OR_PERMISSION",
        "ONLY_SUPPLIED_TARGET_CANDIDATES",
        "AMBIGUITY_REQUIRES_EXPLICIT_CONFIRMATION"
      ],
      "failureCodes": [
        "CANCELLED",
        "CONFIG_ERROR",
        "COST_LIMIT",
        "FEATURE_DISABLED",
        "PROVIDER_TIMEOUT",
        "PROVIDER_UNAVAILABLE",
        "RATE_LIMITED",
        "VALIDATION_ERROR"
      ],
      "fixtureInput": {
        "userText": "删除这项安排",
        "candidates": [
          {
            "candidateId": "candidate_event_a",
            "label": "已选安排",
            "allowedOperations": [
              "REMOVE"
            ]
          }
        ],
        "locale": "zh-CN"
      },
      "fixtureOutput": {
        "schemaVersion": 1,
        "operation": "REMOVE",
        "targetCandidateIds": [
          "candidate_event_a"
        ],
        "requestedText": "删除这项安排",
        "explanation": "请求删除已选安排，提交前仍需验证影响范围。"
      }
    },
    {
      "key": "planner.score",
      "purpose": "DETERMINISTIC_SCORE_EXPLANATION",
      "firstConsumerPhase": 45,
      "inputSchemaVersion": 1,
      "outputSchemaVersion": 1,
      "maxInputBytes": 20000,
      "maxOutputBytes": 20000,
      "variables": [
        {
          "name": "scoreReasons",
          "required": true,
          "nullable": false,
          "maxLength": 8000,
          "delivery": "user_data",
          "sensitivity": "private_minimized"
        },
        {
          "name": "locale",
          "required": true,
          "nullable": false,
          "maxLength": 35,
          "delivery": "system_scalar",
          "sensitivity": "non_sensitive"
        }
      ],
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "scoreReasons",
          "locale"
        ],
        "properties": {
          "scoreReasons": {
            "type": "array",
            "minItems": 1,
            "maxItems": 10,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "dimension",
                "score",
                "reasonCodes"
              ],
              "properties": {
                "dimension": {
                  "$ref": "#/$defs/Dimension"
                },
                "score": {
                  "type": [
                    "number",
                    "null"
                  ],
                  "minimum": 0,
                  "maximum": 100
                },
                "reasonCodes": {
                  "$ref": "#/$defs/TextList"
                }
              }
            }
          },
          "locale": {
            "$ref": "#/$defs/Locale"
          }
        }
      },
      "responseSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "schemaVersion",
          "explanations",
          "overallExplanation"
        ],
        "properties": {
          "schemaVersion": {
            "const": 1
          },
          "explanations": {
            "type": "array",
            "minItems": 1,
            "maxItems": 10,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "dimension",
                "text"
              ],
              "properties": {
                "dimension": {
                  "$ref": "#/$defs/Dimension"
                },
                "text": {
                  "$ref": "#/$defs/Text"
                }
              }
            }
          },
          "overallExplanation": {
            "$ref": "#/$defs/Text"
          }
        }
      },
      "templateRules": [
        "NO_NUMERIC_SCORE_OUTPUT",
        "NO_NEW_EVIDENCE",
        "EXPLAIN_ONLY_DETERMINISTIC_REASONS"
      ],
      "failureCodes": [
        "CANCELLED",
        "CONFIG_ERROR",
        "COST_LIMIT",
        "FEATURE_DISABLED",
        "PROVIDER_TIMEOUT",
        "PROVIDER_UNAVAILABLE",
        "RATE_LIMITED"
      ],
      "failureFallback": "DETERMINISTIC_REASON_TEMPLATES",
      "fixtureInput": {
        "scoreReasons": [
          {
            "dimension": "comfort",
            "score": 80,
            "reasonCodes": [
              "REST_INTERVAL_SATISFIED"
            ]
          }
        ],
        "locale": "zh-CN"
      },
      "fixtureOutput": {
        "schemaVersion": 1,
        "explanations": [
          {
            "dimension": "comfort",
            "text": "已按规则保留休息间隔。"
          }
        ],
        "overallExplanation": "说明仅解释当前确定性评分。"
      }
    },
    {
      "key": "planner.final_summary",
      "purpose": "VERIFIED_PLAN_FINAL_WORDING",
      "firstConsumerPhase": 48,
      "inputSchemaVersion": 1,
      "outputSchemaVersion": 1,
      "maxInputBytes": 65536,
      "maxOutputBytes": 12000,
      "variables": [
        {
          "name": "summary",
          "required": true,
          "nullable": false,
          "maxLength": 1200,
          "delivery": "user_data",
          "sensitivity": "private_minimized"
        },
        {
          "name": "dailyHighlights",
          "required": true,
          "nullable": false,
          "maxLength": 16000,
          "delivery": "user_data",
          "sensitivity": "private_minimized"
        },
        {
          "name": "budgetSummary",
          "required": true,
          "nullable": true,
          "maxLength": 500,
          "delivery": "user_data",
          "sensitivity": "private_minimized"
        },
        {
          "name": "riskSummaries",
          "required": true,
          "nullable": false,
          "maxLength": 8000,
          "delivery": "user_data",
          "sensitivity": "private_minimized"
        },
        {
          "name": "assumptionSummaries",
          "required": true,
          "nullable": false,
          "maxLength": 8000,
          "delivery": "user_data",
          "sensitivity": "private_minimized"
        },
        {
          "name": "limitations",
          "required": true,
          "nullable": false,
          "maxLength": 8000,
          "delivery": "user_data",
          "sensitivity": "private_minimized"
        },
        {
          "name": "locale",
          "required": true,
          "nullable": false,
          "maxLength": 35,
          "delivery": "system_scalar",
          "sensitivity": "non_sensitive"
        }
      ],
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "summary",
          "dailyHighlights",
          "budgetSummary",
          "riskSummaries",
          "assumptionSummaries",
          "limitations",
          "locale"
        ],
        "properties": {
          "summary": {
            "type": "string",
            "minLength": 1,
            "maxLength": 1200,
            "format": "nonblank-text"
          },
          "dailyHighlights": {
            "$ref": "#/$defs/TextList"
          },
          "budgetSummary": {
            "anyOf": [
              {
                "$ref": "#/$defs/Text"
              },
              {
                "type": "null"
              }
            ]
          },
          "riskSummaries": {
            "$ref": "#/$defs/TextList"
          },
          "assumptionSummaries": {
            "$ref": "#/$defs/TextList"
          },
          "limitations": {
            "$ref": "#/$defs/TextList"
          },
          "locale": {
            "$ref": "#/$defs/Locale"
          }
        }
      },
      "responseSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "schemaVersion",
          "finalSummary"
        ],
        "properties": {
          "schemaVersion": {
            "const": 1
          },
          "finalSummary": {
            "type": "string",
            "minLength": 1,
            "maxLength": 3000,
            "format": "nonblank-text"
          }
        }
      },
      "templateRules": [
        "ONLY_VERIFIED_INPUT",
        "PRESERVE_UNKNOWN_AND_LIMITATIONS",
        "NO_FACT_SCORE_QUALITY_OR_EXECUTION_WRITES"
      ],
      "failureCodes": [
        "CANCELLED",
        "CONFIG_ERROR",
        "COST_LIMIT",
        "FEATURE_DISABLED",
        "PROVIDER_TIMEOUT",
        "PROVIDER_UNAVAILABLE",
        "RATE_LIMITED",
        "VALIDATION_ERROR"
      ],
      "fixtureInput": {
        "summary": "已验证的行程摘要",
        "dailyHighlights": [
          "按已验证顺序游览"
        ],
        "budgetSummary": null,
        "riskSummaries": [],
        "assumptionSummaries": [],
        "limitations": [
          "费用仍有未知项"
        ],
        "locale": "zh-CN"
      },
      "fixtureOutput": {
        "schemaVersion": 1,
        "finalSummary": "按已验证顺序游览，费用仍有未知项。"
      }
    },
    {
      "key": "export.markdown",
      "purpose": "ISOLATED_NONCANONICAL_WORDING_EXPERIMENT",
      "firstConsumerPhase": 15,
      "formalExportAllowed": false,
      "formalExportBoundaryPhase": 104,
      "inputSchemaVersion": 1,
      "outputSchemaVersion": 1,
      "maxInputBytes": 20000,
      "maxOutputBytes": 20000,
      "variables": [
        {
          "name": "publicTextBlocks",
          "required": true,
          "nullable": false,
          "maxLength": 8000,
          "delivery": "user_data",
          "sensitivity": "synthetic_public_projection"
        },
        {
          "name": "locale",
          "required": true,
          "nullable": false,
          "maxLength": 35,
          "delivery": "system_scalar",
          "sensitivity": "non_sensitive"
        }
      ],
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "publicTextBlocks",
          "locale"
        ],
        "properties": {
          "publicTextBlocks": {
            "$ref": "#/$defs/TextList"
          },
          "locale": {
            "$ref": "#/$defs/Locale"
          }
        }
      },
      "responseSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "schemaVersion",
          "markdown"
        ],
        "properties": {
          "schemaVersion": {
            "const": 1
          },
          "markdown": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4000,
            "format": "nonblank-text"
          }
        }
      },
      "templateRules": [
        "SYNTHETIC_EXPERIMENT_ONLY",
        "NEVER_CANONICAL_EXPORT",
        "NO_NEW_FACTS_OR_HTML"
      ],
      "failureCodes": [
        "CANCELLED",
        "CONFIG_ERROR",
        "COST_LIMIT",
        "FEATURE_DISABLED",
        "PROVIDER_TIMEOUT",
        "PROVIDER_UNAVAILABLE",
        "RATE_LIMITED"
      ],
      "fixtureInput": {
        "publicTextBlocks": [
          "合成旅行说明"
        ],
        "locale": "zh-CN"
      },
      "fixtureOutput": {
        "schemaVersion": 1,
        "markdown": "# 合成旅行说明"
      }
    }
  ],
  "governancePolicy": {
    "versionContentMutable": false,
    "directActivationAllowed": false,
    "tupleRevisionMustMatch": true,
    "globalCallsEnabledByDefault": false,
    "perAttemptImmutableSnapshot": [
      "PromptVersion",
      "ModelDeployment",
      "ProviderConfigVersion",
      "PlanningPolicyVersion"
    ],
    "zeroCallCodes": [
      "FEATURE_DISABLED",
      "CONFIG_ERROR",
      "RATE_LIMITED",
      "COST_LIMIT",
      "CANCELLED"
    ],
    "internalParseCodes": [
      "INVALID_JSON",
      "SCHEMA_MISMATCH"
    ],
    "publicParseError": "PROVIDER_UNAVAILABLE",
    "publicSecretError": "CONFIG_ERROR",
    "fallbackKeys": [
      "nlu.ask_missing",
      "planner.score"
    ],
    "fallbackProhibitedCodes": [
      "FEATURE_DISABLED",
      "CONFIG_ERROR",
      "CANCELLED"
    ],
    "maxNetworkRetriesBeforeFirstByte": 1
  }
}
```

## 失败与语义验收

结构校验只是第一层。模型任何额外字段、越界长度、全空白文本、错误版本均拒绝；Markdown 实验输出同时拒绝 HTML 和 javascript/data/vbscript 活跃链接。候选/问句/解释中的引用只能来自本次输入，不能接受凭名称猜出的新目标。nlu.ask_missing 输出必须与选中的 specs 一一对应；不完整、重复或未知 field 一律用原 spec fallback，完整 missingFields 和 blocking 结论保持。planner.score 的维度必须与输入一一对应且不重复，确定性分数/原因/证据保持原值。conversation.modify 必须只选择允许该 operation 的本次候选，targetCandidateIds 为空或含歧义时只能进入 Phase053 显式澄清，不执行默认目标；服务端不因该候选结构通过就授予 Mutation 权限。

parser 的 INVALID_JSON/SCHEMA_MISMATCH 只记录在 attempt 或授权 ADMIN mock/debug 分类，对普通 API 映射为 503 PROVIDER_UNAVAILABLE。解析/修复耗尽是技术失败；存在 PlannerRun 时只能 FAILED，不能标成 BLOCKED。仅独立业务准入证实需要信息/决策时才产生相应需求/规划阻断。SECRET_DECRYPT_FAILED 仅服务端安全分类，对外 CONFIG_ERROR。公开响应不含原文、Prompt 或底层异常，requestId/traceId 全程一致。

零调用护栏统一为 FEATURE_DISABLED/CONFIG_ERROR/RATE_LIMITED/COST_LIMIT/CANCELLED；已外呼的 timeout 映射 PROVIDER_TIMEOUT，其他不可用为 PROVIDER_UNAVAILABLE。nlu.ask_missing/planner.score 的可选措辞失败使用确定性 fallback，但显式 CANCELLED 立即停止，不能借 fallback 继续提交已取消命令；CONFIG_ERROR 仍作为配置错误暴露给安全运维，不静默掩盖错误配置。fallback 不重试外呼，也不改变需求准入、数值或质量。

repair 每次经 guardedJsonChat 与唯一 active planner.repair_json；最大两次，原始/修复各自追加 AiOutputRecord，共享原 deadline/预算，不重新预留整套用户预算。repairedText 先按目标 Schema 重解析，再比较输入中可识别的全部键值 token 和容器边界，禁止新增事实、键值重排、改变嵌套归属或数组/对象类型。v1 只允许去除外层成对 code fence 和不改变 token/已有容器边界的标点修正；字符串/数字强转或无法证明的引号、结构改写一律失败，不能把语义变化伪装成类型格式修复。不能修复缺来源、未知目的地、权限、金额或稳定 id；无法证明仅语法变化即失败。网络 before-byte 可按 Phase015 最多一次受限 retry，首 byte 后/取消/Schema/配置/成本错误不网络重试，不能与两次 repair 相乘失控。

Phase017/019-023 的运行时测试会验证完整 parser/guarded client；Phase045/048/053/104 在自己的首次生产阶段补齐语义与事务测试。后期 output schema 若增加 canonical requestedChange 或 v2 映射，先在本文增加明确的新 schemaVersion，发布新不可变 PromptVersion 并整体激活，旧版本只供历史追溯，禁止双写或宽松 optional 兼容分支。

当前文档检查命令：`node docs/phase-plans/check-phase002-schema-prompt.mjs --case prompt --json`。每个 key 固定覆盖合法 input/output、缺变量、未知变量、超长、nullable、额外响应键、错误版本；另测注入字符串仅在 user message、新候选/问句/分数拒绝、repair 不新增值、八 key 缺失/重复/激活规则变异。文档 fixture 的通过不宣称生产 Prompt 效果、真实模型、安全外呼或正式 Markdown 已实现。

文档验收固定执行 186 个唯一 fixture，另有 9 个隔离变异与自检：原有 8 个普通变异只接受 CONTRACT_ASSERTION / AssertionError / ERR_ASSERTION（包含 outcomeCheck 保留断言类型并附加的 fixture 上下文），另有 1 个同诊断 TypeError 外层 runner 自检。每项精确匹配固定 diagnostic，记录 failureClass/errorName/errorCode，观察退出 1，恢复后必须退出 0；运行错误不能因诊断文字相同而冒充普通变异的契约断言。原有 112 项 fixture 保留，新增逐变量长度、输出空缺/超长、locale 注入、重复身份、敏感投影、repair 容器绑定和 UTF-8 字节等约束。validator 把非预期运行异常报告为检查失败，只接受显式 ContractRejection 作为预期负例；fixture ID 集合独立冻结，不能以重复条目凑分母。
