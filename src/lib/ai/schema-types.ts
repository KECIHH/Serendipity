// Generated from the named contracts in docs/travel-plan-schema.md and docs/prompt-design.md.

// Run node scripts/generate-ai-schemas.mjs; do not maintain a second field definition.

export type Id = string;

export type Hash = string;

export type Text = string;

export type NullableText = Text | null;

export type Confidence = number;

export type NullableBoolean = boolean | null;

export type Count = number | null;

export type Date = string | null;

export type Currency = string | null;

export type Country = string | null;

export type Amount = string | null;

export type TextList = ReadonlyArray<Text>;

export type Origin = {
  readonly city: NullableText;
  readonly country: Country;
  readonly confidence: Confidence;
};

export type Destination = {
  readonly id: Id;
  readonly name: Text;
  readonly city: NullableText;
  readonly country: Country;
  readonly type: "country" | "province" | "region" | "city" | "attraction" | null;
  readonly confidence: Confidence;
};

export type DateRange = {
  readonly startDate: Date;
  readonly endDate: Date;
  readonly text: NullableText;
  readonly isFlexible: boolean;
  readonly timezone: string;
  readonly confidence: Confidence;
};

export type Travelers = {
  readonly totalCount: number | null;
  readonly adultCount: Count;
  readonly childCount: Count;
  readonly elderCount: Count;
  readonly ageUnknownCount: Count;
  readonly relationship: "solo" | "couple" | "family" | "friends" | "colleagues" | "other" | null;
  readonly notes: TextList;
  readonly hasChild: NullableBoolean;
  readonly hasElder: NullableBoolean;
  readonly isCouple: NullableBoolean;
  readonly isFamily: NullableBoolean;
  readonly confidence: Confidence;
};

export type Budget = {
  readonly amount: Amount;
  readonly currency: Currency;
  readonly level: "budget" | "standard" | "premium" | null;
  readonly isFlexible: NullableBoolean;
  readonly perPerson: NullableBoolean;
  readonly hardLimit: NullableBoolean;
  readonly confidence: Confidence;
};

export type HardConstraint = {
  readonly id: Id;
  readonly kind: "time" | "transport" | "dietary" | "mobility" | "budget" | "other";
  readonly text: Text;
};

export type Accessibility = {
  readonly stepFreeRequired: NullableBoolean;
  readonly maxWalkingMinutes: number | null;
  readonly notes: TextList;
};

export type Consent = { readonly sensitiveRequirementProcessing: NullableBoolean };

export type Preferences = {
  readonly pace: "slow" | "moderate" | "fast" | null;
  readonly interests: ReadonlyArray<
    "摄影" | "美食" | "徒步" | "City Walk" | "滑雪" | "温泉" | "博物馆" | "自然风光"
  >;
  readonly avoid: TextList;
  readonly transport: ReadonlyArray<
    "self_driving" | "high_speed_rail" | "flight" | "public_transit" | "charter" | "hiking"
  >;
  readonly hardConstraints: ReadonlyArray<HardConstraint>;
  readonly accessibility: Accessibility;
  readonly consent: Consent;
  readonly confidence: Confidence;
};

export type SpecialFlags = {
  readonly isSelfDriving: NullableBoolean;
  readonly isHiking: NullableBoolean;
  readonly isOverseas: NullableBoolean;
};

export type FieldPath =
  | "origin"
  | "destinations"
  | "dateRange"
  | "durationDays"
  | "travelers"
  | "budget"
  | "preferences.pace"
  | "preferences.interests"
  | "preferences.avoid"
  | "preferences.transport"
  | "preferences.hardConstraints"
  | "preferences.accessibility"
  | "preferences.consent";

export type FieldSource = {
  readonly field: FieldPath;
  readonly messageId: Id | null;
  readonly inputHash: Hash;
  readonly method: "USER_TEXT" | "USER_CONTROL" | "DERIVED" | "CLEAR";
  readonly confidence: Confidence;
};

export type MissingField = {
  readonly field: FieldPath;
  readonly priority: "blocking" | "normal" | "optional";
  readonly question: string;
  readonly reason: string;
};

export type TravelRequirement = {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly origin: Origin | null;
  readonly destinations: ReadonlyArray<Destination>;
  readonly dateRange: DateRange | null;
  readonly durationDays: number | null;
  readonly travelers: Travelers;
  readonly budget: Budget;
  readonly preferences: Preferences;
  readonly specialFlags: SpecialFlags;
  readonly fieldSources: ReadonlyArray<FieldSource>;
  readonly missingFields: ReadonlyArray<MissingField>;
};

export type PromptLocale = string;

export type PromptText = string;

export type PromptTextList = ReadonlyArray<PromptText>;

export type PromptDimension =
  | "comfort"
  | "budgetFit"
  | "routeEfficiency"
  | "scheduleFeasibility"
  | "attractionFit"
  | "foodFit"
  | "photographyFit"
  | "accessibility"
  | "weatherResilience"
  | "sourceReliability";

export type PromptOperation =
  | "ADD"
  | "REMOVE"
  | "REPLACE"
  | "MOVE_EVENT"
  | "CHANGE_TRANSPORT"
  | "UPDATE_CONSTRAINT"
  | "LOCK"
  | "UNLOCK"
  | "REPLAN_SCOPE";

export type PromptCandidate = {
  readonly candidateId: Id;
  readonly label: PromptText;
  readonly allowedOperations: ReadonlyArray<PromptOperation>;
};

export type PromptMissingFieldSpec = {
  readonly field: FieldPath;
  readonly priority: "blocking" | "normal" | "optional";
  readonly reasonCode: string;
};

export type PromptSummaryRequirementInput = {
  readonly origin: { readonly city: NullableText; readonly country: Country } | null;
  readonly destinations: ReadonlyArray<{
    readonly name: Text;
    readonly city: NullableText;
    readonly country: Country;
    readonly type: "country" | "province" | "region" | "city" | "attraction" | null;
  }>;
  readonly dateRange: {
    readonly startDate: Date;
    readonly endDate: Date;
    readonly isFlexible: boolean;
    readonly timezone: string;
  } | null;
  readonly durationDays: number | null;
  readonly travelers: {
    readonly totalCount: number | null;
    readonly adultCount: Count;
    readonly childCount: Count;
    readonly elderCount: Count;
    readonly ageUnknownCount: Count;
    readonly relationship: "solo" | "couple" | "family" | "friends" | "colleagues" | "other" | null;
  };
  readonly budget: {
    readonly amount: Amount;
    readonly currency: Currency;
    readonly level: "budget" | "standard" | "premium" | null;
    readonly isFlexible: NullableBoolean;
    readonly perPerson: NullableBoolean;
    readonly hardLimit: NullableBoolean;
  };
  readonly preferences: {
    readonly pace: "slow" | "moderate" | "fast" | null;
    readonly interests: ReadonlyArray<
      "摄影" | "美食" | "徒步" | "City Walk" | "滑雪" | "温泉" | "博物馆" | "自然风光"
    >;
    readonly transport: ReadonlyArray<
      "self_driving" | "high_speed_rail" | "flight" | "public_transit" | "charter" | "hiking"
    >;
  };
};

export type TravelPlanSummaryDraft = {
  readonly schemaVersion: 1;
  readonly title: string;
  readonly description: string;
  readonly durationDays: number | null;
  readonly destinations: ReadonlyArray<Destination>;
  readonly bestFor: ReadonlyArray<string>;
  readonly overallRecommendation: string;
  readonly recommendedReason: string;
  readonly requirementRevision: number;
  readonly requirementHash: string;
};

export type NluExtractOutput = {
  readonly schemaVersion: 1;
  readonly candidates: ReadonlyArray<{
    readonly field:
      | "origin"
      | "destinations"
      | "dateRange"
      | "durationDays"
      | "travelers"
      | "budget"
      | "preferences.pace"
      | "preferences.interests"
      | "preferences.avoid"
      | "preferences.transport"
      | "preferences.hardConstraints"
      | "preferences.accessibility";
    readonly text: string;
    readonly confidence: number;
  }>;
};

export type NluAskMissingOutput = {
  readonly schemaVersion: 1;
  readonly questions: ReadonlyArray<{ readonly field: FieldPath; readonly question: string }>;
};

export type PlannerGenerateOutput = {
  readonly schemaVersion: 1;
  readonly title: string;
  readonly description: string;
  readonly bestFor: ReadonlyArray<string>;
  readonly overallRecommendation: string;
  readonly recommendedReason: string;
};

export type PlannerRepairJsonOutput = { readonly schemaVersion: 1; readonly repairedText: string };

export type ConversationModifyOutput = {
  readonly schemaVersion: 1;
  readonly operation: PromptOperation;
  readonly targetCandidateIds: ReadonlyArray<Id>;
  readonly requestedText: string;
  readonly explanation: PromptText;
};

export type PlannerScoreOutput = {
  readonly schemaVersion: 1;
  readonly explanations: ReadonlyArray<{
    readonly dimension: PromptDimension;
    readonly text: PromptText;
  }>;
  readonly overallExplanation: PromptText;
};

export type PlannerFinalSummaryOutput = {
  readonly schemaVersion: 1;
  readonly finalSummary: string;
};

export type ExportMarkdownOutput = { readonly schemaVersion: 1; readonly markdown: string };

export type NluExtractInput = {
  readonly userText: string;
  readonly locale: PromptLocale;
  readonly serverDate: string;
  readonly timezone: string;
  readonly stage: "CORE" | "PARAMETERS" | "CONSTRAINTS";
};

export type NluAskMissingInput = {
  readonly specs: ReadonlyArray<PromptMissingFieldSpec>;
  readonly locale: PromptLocale;
};

export type PlannerGenerateInput = {
  readonly requirement: PromptSummaryRequirementInput;
  readonly assumptionSummaries: PromptTextList;
  readonly locale: PromptLocale;
};

export type PlannerRepairJsonInput = {
  readonly rawText: string;
  readonly errors: ReadonlyArray<{
    readonly path: string;
    readonly code: "INVALID_JSON" | "SCHEMA_MISMATCH";
  }>;
  readonly targetSchemaId:
    | "nlu.extract:v1"
    | "nlu.ask_missing:v1"
    | "planner.generate:v1"
    | "conversation.modify:v1"
    | "planner.score:v1"
    | "planner.final_summary:v1"
    | "export.markdown:v1"
    | "travel-requirement-v1"
    | "travel-summary-v1";
  readonly locale: PromptLocale;
};

export type ConversationModifyInput = {
  readonly userText: string;
  readonly candidates: ReadonlyArray<PromptCandidate>;
  readonly locale: PromptLocale;
};

export type PlannerScoreInput = {
  readonly scoreReasons: ReadonlyArray<{
    readonly dimension: PromptDimension;
    readonly score: number | null;
    readonly reasonCodes: PromptTextList;
  }>;
  readonly locale: PromptLocale;
};

export type PlannerFinalSummaryInput = {
  readonly summary: string;
  readonly dailyHighlights: PromptTextList;
  readonly budgetSummary: PromptText | null;
  readonly riskSummaries: PromptTextList;
  readonly assumptionSummaries: PromptTextList;
  readonly limitations: PromptTextList;
  readonly locale: PromptLocale;
};

export type ExportMarkdownInput = {
  readonly publicTextBlocks: PromptTextList;
  readonly locale: PromptLocale;
};

export interface PromptOutputMap {
  readonly "nlu.extract": NluExtractOutput;
  readonly "nlu.ask_missing": NluAskMissingOutput;
  readonly "planner.generate": PlannerGenerateOutput;
  readonly "planner.repair_json": PlannerRepairJsonOutput;
  readonly "conversation.modify": ConversationModifyOutput;
  readonly "planner.score": PlannerScoreOutput;
  readonly "planner.final_summary": PlannerFinalSummaryOutput;
  readonly "export.markdown": ExportMarkdownOutput;
}

export interface PromptInputMap {
  readonly "nlu.extract": NluExtractInput;
  readonly "nlu.ask_missing": NluAskMissingInput;
  readonly "planner.generate": PlannerGenerateInput;
  readonly "planner.repair_json": PlannerRepairJsonInput;
  readonly "conversation.modify": ConversationModifyInput;
  readonly "planner.score": PlannerScoreInput;
  readonly "planner.final_summary": PlannerFinalSummaryInput;
  readonly "export.markdown": ExportMarkdownInput;
}
