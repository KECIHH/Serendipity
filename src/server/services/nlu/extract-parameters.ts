import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";
import type { Budget, NluExtractOutput, Preferences, Travelers } from "@/lib/ai/schema-types";
import { NluExtractOutputSchema } from "@/lib/ai/schemas";
import type { GuardedAiClientOptions } from "@/server/ai/guarded-client";
import { NLU_EXTRACT_PROMPT_KEY, NLU_EXTRACT_VARIABLES } from "@/lib/ai/prompts/nlu-extract";
import { db } from "@/server/db";
import { guardedJsonChat } from "@/server/ai/guarded-client";
import type { NluContext } from "@/server/ai/nlu-context";
import { canonicalHash } from "@/server/ai/canonical-hash";
import { activatePromptModelTuple } from "@/server/services/prompt-service";
import { parseCnAmount, parseExplicitCurrency } from "./amount-parser";
import { nluCommandBinding } from "./command-binding";

export const NLU_PARAMETER_PROMPT_VERSION = 2;
export const NLU_PARAMETER_PROMPT_VERSION_ID = "prompt-nlu-extract-v2";

export interface TravelParameters {
  readonly travelers: Travelers;
  readonly budget: Budget;
  readonly preferences: Preferences;
}

type GuardedCallOptions = Omit<GuardedAiClientOptions, "db" | "owner" | "nluContext">;
export interface ExtractTravelParametersOptions extends GuardedCallOptions {
  readonly db?: PrismaClient;
  readonly attemptNo?: number;
  readonly travelRecordId?: string;
}

type Interest = "摄影" | "美食" | "徒步" | "City Walk" | "滑雪" | "温泉" | "博物馆" | "自然风光";
const interestAliases: Readonly<Record<string, Interest>> = {
  拍照: "摄影",
  摄影: "摄影",
  日出: "摄影",
  美食: "美食",
  徒步: "徒步",
  "City Walk": "City Walk",
  citywalk: "City Walk",
  滑雪: "滑雪",
  温泉: "温泉",
  博物馆: "博物馆",
  自然风光: "自然风光",
};
const numbers: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function confidence(values: readonly number[]): number {
  return values.length ? Math.max(...values.map((value) => Math.max(0, Math.min(1, value)))) : 0;
}
function count(value: string): number | null {
  const parsed = /^\d+$/.test(value) ? Number(value) : numbers[value];
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}
function spans(output: NluExtractOutput, field: NluExtractOutput["candidates"][number]["field"]) {
  return output.candidates.filter((item) => item.field === field);
}
function visible(
  userInput: string,
  items: NluExtractOutput["candidates"],
): NluExtractOutput["candidates"] {
  return items.filter((item) => userInput.includes(item.text));
}

function travelersFrom(userInput: string, output: NluExtractOutput): Travelers {
  const items = visible(userInput, spans(output, "travelers"));
  const text = items.map((item) => item.text).join(" ");
  const relationship = /情侣|夫妻|对象/.test(text)
    ? "couple"
    : /一家|家庭|亲子|爸妈|父母/.test(text)
      ? "family"
      : /毕业旅行|朋友|同学/.test(text)
        ? "friends"
        : /同事/.test(text)
          ? "colleagues"
          : /一个人|独自|单人/.test(text)
            ? "solo"
            : null;
  const explicit = text.match(/([0-9]+|[一二两三四五六七八九十])\s*(?:个|人|口)/u);
  const family = text.match(/一家([一二两三四五六七八九十])/u);
  const totalCount = explicit
    ? count(explicit[1])
    : family
      ? count(family[1])
      : relationship === "couple"
        ? 2
        : null;
  const elderExplicit = text.match(/([0-9]+|[一二两三四五六七八九])\s*(?:位|个)?老人/u);
  const totalFromGroups = text.includes("两成人含一老人");
  const adultExplicit = text.match(/([0-9]+|[一二两三四五六七八九])\s*(?:位|个)?成人/u);
  const childExplicit = text.match(/([0-9]+|[一二两三四五六七八九])\s*(?:位|个)?(?:孩子|儿童)/u);
  const unknownExplicit = text.match(
    /([0-9]+|[一二两三四五六七八九])\s*(?:位|个)?(?:人)?年龄未知/u,
  );
  let adultCount = adultExplicit ? count(adultExplicit[1]) : null;
  let elderCount = elderExplicit ? count(elderExplicit[1]) : null;
  let childCount = childExplicit ? count(childExplicit[1]) : null;
  let ageUnknownCount = unknownExplicit ? count(unknownExplicit[1]) : null;
  if (text.includes("两成人含一老人")) {
    adultCount = 1;
    elderCount = 1;
    childCount = 0;
    ageUnknownCount = 0;
  }
  const groups = [adultCount, childCount, elderCount, ageUnknownCount];
  if (groups.every((value) => value === null) && totalCount !== null) {
    ageUnknownCount = relationship === "couple" || totalFromGroups ? 0 : null;
    adultCount = relationship === "couple" ? totalCount : null;
    childCount = relationship === "couple" ? 0 : null;
    elderCount = relationship === "couple" ? 0 : null;
  }
  const ageGroups = [adultCount, childCount, elderCount, ageUnknownCount];
  const known = ageGroups.filter((value): value is number => value !== null);
  const groupSum = known.reduce((sum, value) => sum + value, 0);
  const resolvedTotal = totalCount ?? (totalFromGroups && known.length === 4 ? groupSum : null);
  const consistent =
    resolvedTotal === null ||
    (known.length === ageGroups.length ? groupSum === resolvedTotal : groupSum <= resolvedTotal);
  if (!consistent) throw new Error("VALIDATION_ERROR");
  return {
    totalCount: resolvedTotal,
    adultCount,
    childCount,
    elderCount,
    ageUnknownCount,
    relationship,
    notes: [],
    hasChild: childCount === null ? null : childCount > 0,
    hasElder: elderCount === null ? null : elderCount > 0,
    isCouple: relationship === null ? null : relationship === "couple",
    isFamily: relationship === null ? null : relationship === "family",
    confidence: confidence(items.map((item) => item.confidence)),
  };
}

function budgetFrom(userInput: string, output: NluExtractOutput): Budget {
  const items = visible(userInput, spans(output, "budget"));
  const text = items.map((item) => item.text).join(" ");
  const level = /低一点|穷游|节省|经济/.test(text)
    ? "budget"
    : /豪华|高端/.test(text)
      ? "premium"
      : /舒适|标准/.test(text)
        ? "standard"
        : null;
  return {
    amount: text ? parseCnAmount(text) : null,
    currency: parseExplicitCurrency(text),
    level,
    isFlexible: text ? /左右|上下|低一点|大约|约/.test(text) : null,
    perPerson: text ? /人均|每人/.test(text) : null,
    hardLimit: text
      ? /不超过|最多|上限/.test(text)
        ? true
        : /左右|低一点/.test(text)
          ? false
          : null
      : null,
    confidence: confidence(items.map((item) => item.confidence)),
  };
}

function preferencesFrom(userInput: string, output: NluExtractOutput): Preferences {
  const interestItems = visible(userInput, spans(output, "preferences.interests"));
  const avoidItems = visible(userInput, spans(output, "preferences.avoid"));
  const paceItems = visible(userInput, spans(output, "preferences.pace"));
  const selected = interestItems.flatMap((item) =>
    Object.entries(interestAliases)
      .filter(([alias]) => item.text.toLowerCase().includes(alias.toLowerCase()))
      .map(([, interest]) => interest),
  );
  const paceText = paceItems.map((item) => item.text).join(" ");
  return {
    pace: /太累|轻松|慢/.test(paceText)
      ? "slow"
      : /紧凑|快/.test(paceText)
        ? "fast"
        : paceText
          ? "moderate"
          : null,
    interests: [...new Set(selected)],
    avoid: [...new Set(avoidItems.map((item) => item.text))],
    transport: [],
    hardConstraints: [],
    accessibility: { stepFreeRequired: null, maxWalkingMinutes: null, notes: [] },
    consent: { sensitiveRequirementProcessing: null },
    confidence: confidence(
      [...interestItems, ...avoidItems, ...paceItems].map((item) => item.confidence),
    ),
  };
}

/** Deterministically map validated parameter spans; this does not merge a requirement snapshot. */
export function mapTravelParameters(userInput: string, output: NluExtractOutput): TravelParameters {
  const parsed = NluExtractOutputSchema.parse(output);
  return {
    travelers: travelersFrom(userInput, parsed),
    budget: budgetFrom(userInput, parsed),
    preferences: preferencesFrom(userInput, parsed),
  };
}

function sameVariables(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== NLU_EXTRACT_VARIABLES.length) return false;
  return NLU_EXTRACT_VARIABLES.every((expected, index) => {
    const actual = value[index];
    return (
      !!actual &&
      typeof actual === "object" &&
      (actual as { name?: unknown }).name === expected.name &&
      (actual as { required?: unknown }).required === expected.required &&
      (actual as { nullable?: unknown }).nullable === expected.nullable &&
      (actual as { maxLength?: unknown }).maxLength === expected.maxLength &&
      (actual as { delivery?: unknown }).delivery === expected.delivery &&
      (actual as { sensitivity?: unknown }).sensitivity === expected.sensitivity
    );
  });
}

async function ensureParameterPrompt(database: PrismaClient, ctx: NluContext): Promise<void> {
  await database.$transaction(async (tx) => {
    const definition = await tx.promptDefinition.findUnique({
      where: { key: NLU_EXTRACT_PROMPT_KEY },
      include: { activation: { include: { championVersion: true } }, modelActivation: true },
    });
    const active = definition?.activation?.championVersion;
    if (!definition || !active || !definition.modelActivation) throw new Error("CONFIG_ERROR");
    if (active.version === NLU_PARAMETER_PROMPT_VERSION) {
      if (!active.content.endsWith("\nStage: PARAMETERS") || !sameVariables(active.variablesJson))
        throw new Error("CONFIG_ERROR");
      return;
    }
    if (active.version > NLU_PARAMETER_PROMPT_VERSION) {
      if (!active.content.includes("\nStage: PARAMETERS") || !sameVariables(active.variablesJson))
        throw new Error("CONFIG_ERROR");
      return;
    }
    const content = `${active.content}\nStage: PARAMETERS`;
    const contentHash = canonicalHash(content);
    const byId = await tx.promptVersion.findUnique({
      where: { id: NLU_PARAMETER_PROMPT_VERSION_ID },
    });
    const byHash = await tx.promptVersion.findUnique({
      where: { definitionId_contentHash: { definitionId: definition.id, contentHash } },
    });
    const existing = byId ?? byHash;
    if (
      (byId && byHash && byId.id !== byHash.id) ||
      (existing &&
        (existing.definitionId !== definition.id ||
          existing.version !== NLU_PARAMETER_PROMPT_VERSION ||
          existing.content !== content ||
          existing.contentHash !== contentHash ||
          !sameVariables(existing.variablesJson)))
    )
      throw new Error("CONFIG_ERROR");
    let version = existing;
    if (!version) {
      try {
        version = await tx.promptVersion.create({
          data: {
            id: NLU_PARAMETER_PROMPT_VERSION_ID,
            definitionId: definition.id,
            version: NLU_PARAMETER_PROMPT_VERSION,
            content,
            contentHash,
            variablesJson: NLU_EXTRACT_VARIABLES,
            responseSchemaVersion: active.responseSchemaVersion,
            ...(ctx.ownerContext.kind === "USER" ? { createdById: ctx.ownerContext.userId } : {}),
          },
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002")
          throw error;
        version = await tx.promptVersion.findUnique({
          where: { id: NLU_PARAMETER_PROMPT_VERSION_ID },
        });
      }
    }
    if (
      !version ||
      version.definitionId !== definition.id ||
      version.version !== NLU_PARAMETER_PROMPT_VERSION ||
      version.contentHash !== contentHash
    )
      throw new Error("CONFIG_ERROR");
    const activation = await tx.promptActivation.findUniqueOrThrow({
      where: { definitionId: definition.id },
    });
    if (activation.championVersionId === version.id) return;
    await activatePromptModelTuple(tx, {
      definitionId: definition.id,
      promptVersionId: version.id,
      deploymentId: definition.modelActivation.deploymentId,
      deploymentConfigVersion: definition.modelActivation.deploymentConfigVersion,
      providerId: definition.modelActivation.providerId,
      providerConfigVersion: definition.modelActivation.providerConfigVersion,
      ...(ctx.ownerContext.kind === "USER" ? { updatedById: ctx.ownerContext.userId } : {}),
      expectedRevision: activation.revision,
    });
  });
}

export async function extractTravelParameters(
  userInput: string,
  ctx: NluContext,
  options: ExtractTravelParametersOptions = {},
): Promise<TravelParameters> {
  const { db: callerDb, attemptNo, travelRecordId, ...guardedOptions } = options;
  const database = callerDb ?? db;
  try {
    await ensureParameterPrompt(database, ctx);
  } catch (error) {
    if (
      error instanceof Error &&
      ["CONFIG_ERROR", "CANCELLED", "PROVIDER_TIMEOUT"].includes(error.message)
    )
      throw error;
    throw new Error("CONFIG_ERROR");
  }
  const result = await guardedJsonChat(
    {
      promptKey: NLU_EXTRACT_PROMPT_KEY,
      variables: {
        userText: userInput,
        locale: ctx.locale,
        serverDate: ctx.serverDate,
        timezone: ctx.timezone,
        stage: "PARAMETERS",
      },
      userMessage: userInput,
      context: ctx,
      ...(attemptNo ? { attemptNo } : {}),
      ...nluCommandBinding(ctx, travelRecordId),
    },
    { ...guardedOptions, db: database },
  );
  if (!result.ok) throw new Error(result.errorCode);
  return mapTravelParameters(userInput, result.output as NluExtractOutput);
}
