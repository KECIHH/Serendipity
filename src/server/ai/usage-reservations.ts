import "server-only";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { PromptModelSnapshot } from "@/server/services/prompt-service";

export function estimateUsage(snapshot: PromptModelSnapshot, requestBytes: number) {
  // Each UTF-8 byte can consume at most one byte-level token; 128 covers message/control tokens.
  const inputTokens = requestBytes + 128;
  const outputTokens = snapshot.model.maxOutputTokens;
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens + outputTokens > snapshot.model.contextWindowTokens
  )
    throw new Error("CONFIG_ERROR");
  const { pricing } = snapshot.model;
  const cost = new Prisma.Decimal(inputTokens)
    .mul(pricing.inputPerToken)
    .add(new Prisma.Decimal(outputTokens).mul(pricing.outputPerToken))
    .add(pricing.fixedPerRequest)
    .toDecimalPlaces(8, Prisma.Decimal.ROUND_CEIL);
  return {
    inputTokens,
    outputTokens,
    estimatedTokens: inputTokens + outputTokens,
    estimatedCost: cost,
  };
}
export function actualUsageCost(
  snapshot: PromptModelSnapshot,
  inputTokens: number,
  outputTokens: number,
) {
  return new Prisma.Decimal(inputTokens)
    .mul(snapshot.model.pricing.inputPerToken)
    .add(new Prisma.Decimal(outputTokens).mul(snapshot.model.pricing.outputPerToken))
    .add(snapshot.model.pricing.fixedPerRequest)
    .toDecimalPlaces(8, Prisma.Decimal.ROUND_CEIL);
}
export async function reserveUsage(
  db: PrismaClient,
  snapshot: PromptModelSnapshot,
  input: {
    traceId: string;
    attemptNo: number;
    requestBytes: number;
    now: number;
    costCap: string;
    signal: AbortSignal;
    authorize?: (tx: Prisma.TransactionClient) => Promise<void>;
  },
) {
  const prefix = `daily:${snapshot.provider.providerId}:`;
  const bucketKey = prefix + new Date(input.now).toISOString().slice(0, 10);
  const estimate = estimateUsage(snapshot, input.requestBytes);
  const costCap = Prisma.Decimal.min(snapshot.provider.costLimitPerDay, input.costCap);
  return db.$transaction(
    async (tx) => {
      await input.authorize?.(tx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${prefix},0::bigint))`;
      if (input.signal.aborted) throw new Error("CANCELLED");
      const enabled = await tx.systemConfig.findUnique({ where: { key: "ai.calls.enabled" } });
      if (enabled?.valueJson !== true) throw new Error("FEATURE_DISABLED");
      const rows = await tx.aiUsageReservation.findMany({
        where: {
          OR: [
            { bucketKey, status: "SETTLED" },
            { bucketKey: { startsWith: prefix }, status: { in: ["RESERVED", "RECONCILING"] } },
          ],
        },
        select: {
          status: true,
          estimatedTokens: true,
          estimatedCost: true,
          actualTokens: true,
          actualCost: true,
        },
      });
      let tokens = estimate.estimatedTokens,
        cost = estimate.estimatedCost;
      for (const row of rows) {
        tokens +=
          row.status === "SETTLED"
            ? (row.actualTokens ?? row.estimatedTokens)
            : row.estimatedTokens;
        cost = cost.add(
          row.status === "SETTLED" ? (row.actualCost ?? row.estimatedCost) : row.estimatedCost,
        );
      }
      if (tokens > snapshot.provider.quotaTokensPerDay) throw new Error("RATE_LIMITED");
      if (cost.gt(costCap)) throw new Error("COST_LIMIT");
      return tx.aiUsageReservation.create({
        data: {
          bucketKey,
          traceId: input.traceId,
          attemptNo: input.attemptNo,
          estimatedTokens: estimate.estimatedTokens,
          estimatedCost: estimate.estimatedCost,
          status: "RESERVED",
          submissionState: "NOT_SENT",
          expiresAt: new Date(input.now + snapshot.provider.timeoutMs + 60000),
        },
      });
    },
    { maxWait: 15000, timeout: 15000 },
  );
}
export async function releaseUnsentReservation(
  db: PrismaClient,
  id: string,
  now = new Date(),
): Promise<void> {
  const updated = await db.aiUsageReservation.updateMany({
    where: { id, status: "RESERVED", submissionState: "NOT_SENT" },
    data: { status: "RELEASED", settledAt: now },
  });
  if (
    !updated.count &&
    (await db.aiUsageReservation.findUnique({ where: { id } }))?.status !== "RELEASED"
  )
    throw new Error("CONFIG_ERROR");
}
export async function reconcileReservation(
  db: PrismaClient,
  id: string,
  proof:
    | { mode: "UPPER_BOUND"; now: Date }
    | {
        mode: "PROVIDER_PROOF";
        now: Date;
        providerRequestId: string;
        actualTokens: number;
        actualCost: string;
      },
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "AiUsageReservation" WHERE id=${id} FOR UPDATE`;
    const row = await tx.aiUsageReservation.findUnique({ where: { id } });
    if (!row) throw new Error("CONFIG_ERROR");
    if (
      proof.mode === "PROVIDER_PROOF" &&
      (!row.providerRequestId ||
        proof.providerRequestId !== row.providerRequestId ||
        !/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(proof.actualCost))
    )
      throw new Error("CONFIG_ERROR");
    if (row.status === "SETTLED") {
      if (
        proof.mode === "PROVIDER_PROOF" &&
        (row.actualTokens !== proof.actualTokens || !row.actualCost?.equals(proof.actualCost))
      )
        throw new Error("CONFIG_ERROR");
      return;
    }
    if (row.submissionState === "NOT_SENT" || row.status === "RELEASED")
      throw new Error("CONFIG_ERROR");
    if (proof.mode === "UPPER_BOUND" && row.expiresAt > proof.now) throw new Error("CONFIG_ERROR");
    const tokens = proof.mode === "UPPER_BOUND" ? row.estimatedTokens : proof.actualTokens;
    const cost =
      proof.mode === "UPPER_BOUND" ? row.estimatedCost : new Prisma.Decimal(proof.actualCost);
    if (
      !Number.isSafeInteger(tokens) ||
      tokens < 0 ||
      tokens > row.estimatedTokens ||
      cost.isNegative() ||
      cost.gt(row.estimatedCost) ||
      (proof.mode === "PROVIDER_PROOF" &&
        (!row.providerRequestId || proof.providerRequestId !== row.providerRequestId))
    )
      throw new Error("CONFIG_ERROR");
    await tx.aiUsageReservation.update({
      where: { id },
      data: { status: "SETTLED", actualTokens: tokens, actualCost: cost, settledAt: proof.now },
    });
  });
}
