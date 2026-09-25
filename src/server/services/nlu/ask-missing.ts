import type { PrismaClient } from "@prisma/client";
import type { FieldPath, MissingField, NluAskMissingOutput } from "@/lib/ai/schema-types";
import { NLU_ASK_MISSING_PROMPT_KEY } from "@/lib/ai/prompts/nlu-ask-missing";
import { guardedJsonChat, type GuardedAiClientOptions } from "@/server/ai/guarded-client";
import type { NluContext } from "@/server/ai/nlu-context";
import { db } from "@/server/db";
import { nluCommandBinding } from "./command-binding";
import { fieldOrder } from "./constraint-mapping";
import type { MissingFieldSpec } from "./detect-missing";

const fallbacks: Partial<Record<FieldPath, readonly [string, string]>> = {
  destinations: ["想去哪里？", "还没有可解析的目的地。"],
  dateRange: ["想什么时候出发？", "精确规划还缺少出发日期。"],
  durationDays: ["计划玩几天？", "精确规划还缺少出行时长。"],
  travelers: ["几位同行？", "精确规划还缺少同行人数。"],
  origin: ["从哪里出发？", "精确规划还缺少出发地。"],
  budget: ["预算大概是多少？", "预算尚未说明，不影响先确认行程范围。"],
  "preferences.interests": ["更想安排哪类体验？", "偏好还是空的。"],
  "preferences.transport": ["这次交通方式需要再确认吗？", "相关交通模块的安全能力尚未确认。"],
};

function fallback(spec: MissingFieldSpec): MissingField {
  const [question, reason] = fallbacks[spec.field] ?? [
    "还需要补充这项信息吗？",
    "这项信息尚未确定。",
  ];
  return { field: spec.field, priority: spec.priority, question, reason };
}

function ordered(specs: readonly MissingFieldSpec[]): MissingFieldSpec[] {
  const rank = { blocking: 0, normal: 1, optional: 2 } as const;
  return [...specs].sort(
    (left, right) =>
      rank[left.priority] - rank[right.priority] ||
      fieldOrder.indexOf(left.field) - fieldOrder.indexOf(right.field),
  );
}

/** Keep every spec. AI wording may replace at most three selected questions. */
export async function askMissingFields(
  specs: readonly MissingFieldSpec[],
  ctx: NluContext,
  options: Omit<GuardedAiClientOptions, "db" | "owner" | "nluContext"> & {
    readonly db?: PrismaClient;
    readonly attemptNo?: number;
    readonly travelRecordId?: string;
    readonly failClosed?: boolean;
  } = {},
): Promise<{
  readonly missingFields: readonly MissingField[];
  readonly questions: readonly string[];
}> {
  const all = ordered(specs).map(fallback);
  const selected = ordered(specs).slice(0, 3);
  if (!selected.length) return { missingFields: all, questions: [] };
  const { db: callerDb, attemptNo, travelRecordId, failClosed, ...guarded } = options;
  const fatal = ["RATE_LIMITED", "COST_LIMIT", "PROVIDER_TIMEOUT", "CANCELLED"];
  let polished = new Map<FieldPath, string>();
  if (!ctx.signal.aborted) {
    try {
      const result = await guardedJsonChat(
        {
          promptKey: NLU_ASK_MISSING_PROMPT_KEY,
          variables: { specs: selected, locale: ctx.locale },
          userMessage: JSON.stringify({ specs: selected }),
          context: ctx,
          ...(attemptNo ? { attemptNo } : {}),
          ...nluCommandBinding(ctx, travelRecordId),
        },
        { ...guarded, db: callerDb ?? db },
      );
      if (!result.ok && fatal.includes(result.errorCode)) throw new Error(result.errorCode);
      if (!result.ok && failClosed && result.internalCode === "INVALID_JSON")
        throw new Error(result.errorCode);
      if (result.ok) {
        const output = result.output as NluAskMissingOutput;
        polished = new Map(output.questions.map((item) => [item.field, item.question.trim()]));
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (fatal.includes(code) || (failClosed && code === "PROVIDER_UNAVAILABLE")) throw error;
      polished = new Map();
    }
  }
  const missingFields = all.map((item) =>
    selected.some((spec) => spec.field === item.field) && polished.get(item.field)
      ? { ...item, question: polished.get(item.field)! }
      : item,
  );
  return {
    missingFields,
    questions: missingFields
      .filter((item) => selected.some((spec) => spec.field === item.field))
      .map((item) => item.question),
  };
}
