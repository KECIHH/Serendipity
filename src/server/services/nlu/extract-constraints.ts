import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";
import type { NluExtractOutput } from "@/lib/ai/schema-types";
import { NLU_EXTRACT_PROMPT_KEY, NLU_EXTRACT_VARIABLES } from "@/lib/ai/prompts/nlu-extract";
import { guardedJsonChat, type GuardedAiClientOptions } from "@/server/ai/guarded-client";
import { canonicalHash } from "@/server/ai/canonical-hash";
import type { NluContext } from "@/server/ai/nlu-context";
import { db } from "@/server/db";
import { activatePromptModelTuple } from "@/server/services/prompt-service";
import { mapConstraints, type ConstraintExtraction } from "./constraint-mapping";
import { nluCommandBinding } from "./command-binding";

export const NLU_CONSTRAINT_PROMPT_VERSION = 3;
export const NLU_CONSTRAINT_PROMPT_VERSION_ID = "prompt-nlu-extract-v3";
export const NLU_CONSTRAINT_STAGE = "\nStage: CONSTRAINTS";
type Options = Omit<GuardedAiClientOptions, "db" | "owner" | "nluContext"> & {
  readonly db?: PrismaClient;
  readonly attemptNo?: number;
  readonly travelRecordId?: string;
};

function sameVariables(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === NLU_EXTRACT_VARIABLES.length &&
    NLU_EXTRACT_VARIABLES.every((expected, index) => {
      const actual = value[index] as Record<string, unknown> | undefined;
      return (
        !!actual &&
        actual.name === expected.name &&
        actual.required === expected.required &&
        actual.nullable === expected.nullable &&
        actual.maxLength === expected.maxLength &&
        actual.delivery === expected.delivery &&
        actual.sensitivity === expected.sensitivity
      );
    })
  );
}

/** Append an immutable constraint stage without replacing the core or parameter versions. */
async function ensureConstraintPrompt(database: PrismaClient, ctx: NluContext) {
  await database.$transaction(async (tx) => {
    const definition = await tx.promptDefinition.findUnique({
      where: { key: NLU_EXTRACT_PROMPT_KEY },
      include: { activation: { include: { championVersion: true } }, modelActivation: true },
    });
    const active = definition?.activation?.championVersion;
    if (!definition || !active || !definition.modelActivation) throw new Error("CONFIG_ERROR");
    if (active.version === NLU_CONSTRAINT_PROMPT_VERSION) {
      if (!active.content.endsWith(NLU_CONSTRAINT_STAGE) || !sameVariables(active.variablesJson))
        throw new Error("CONFIG_ERROR");
      return;
    }
    if (active.version > NLU_CONSTRAINT_PROMPT_VERSION) throw new Error("CONFIG_ERROR");
    const content = `${active.content}${NLU_CONSTRAINT_STAGE}`;
    const contentHash = canonicalHash(content);
    const byId = await tx.promptVersion.findUnique({
      where: { id: NLU_CONSTRAINT_PROMPT_VERSION_ID },
    });
    const byHash = await tx.promptVersion.findUnique({
      where: { definitionId_contentHash: { definitionId: definition.id, contentHash } },
    });
    const existing = byId ?? byHash;
    if (
      (byId && byHash && byId.id !== byHash.id) ||
      (existing &&
        (existing.definitionId !== definition.id ||
          existing.version !== NLU_CONSTRAINT_PROMPT_VERSION ||
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
            id: NLU_CONSTRAINT_PROMPT_VERSION_ID,
            definitionId: definition.id,
            version: NLU_CONSTRAINT_PROMPT_VERSION,
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
          where: { id: NLU_CONSTRAINT_PROMPT_VERSION_ID },
        });
      }
    }
    if (!version || version.contentHash !== contentHash) throw new Error("CONFIG_ERROR");
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

export async function extractConstraints(
  userInput: string,
  ctx: NluContext,
  options: Options = {},
): Promise<ConstraintExtraction> {
  const { db: callerDb, attemptNo, travelRecordId, ...guarded } = options;
  const database = callerDb ?? db;
  await ensureConstraintPrompt(database, ctx);
  const result = await guardedJsonChat(
    {
      promptKey: NLU_EXTRACT_PROMPT_KEY,
      variables: {
        userText: userInput,
        locale: ctx.locale,
        serverDate: ctx.serverDate,
        timezone: ctx.timezone,
        stage: "CONSTRAINTS",
      },
      userMessage: userInput,
      context: ctx,
      ...(attemptNo ? { attemptNo } : {}),
      ...nluCommandBinding(ctx, travelRecordId),
    },
    { ...guarded, db: database },
  );
  if (!result.ok) throw new Error(result.errorCode);
  return mapConstraints(userInput, result.output as NluExtractOutput);
}
