import "server-only";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { canonicalHash } from "@/lib/ai/schemas";
import { KeyLifecycleError } from "@/server/admin/key-reference";
import type { KeyCandidateClient } from "@/server/admin/key-candidate-client";
import { callGuardedKeyCandidate } from "./guarded-client";
import type { ProviderRegistryOptions } from "./provider-registry";
import probes from "./bootstrap-probes.json";

/** Candidate calls share all normal call guards; only the exact leased DISABLED key is exceptional. */
export function createProviderKeyCandidateClient(
  db: PrismaClient,
  options: ProviderRegistryOptions = {},
): KeyCandidateClient {
  return {
    async verify() {
      throw new KeyLifecycleError(503, "CONFIG_ERROR");
    },
    async verifyRecord(target, record, resolver, authorization) {
      try {
        if (!authorization) throw new Error("CONFIG_ERROR");
        const definition = await db.promptDefinition.findUnique({
          where: { id: target.candidate.referenceId },
        });
        if (!definition) throw new Error("CONFIG_ERROR");
        const probe = probes[definition.key as keyof typeof probes];
        if (!probe) throw new Error("CONFIG_ERROR");
        const [identity] = await db.$queryRaw<
          Array<{ name: string }>
        >`SELECT current_database() AS name`;
        const result = await callGuardedKeyCandidate(
          {
            promptKey: definition.key,
            variables: probe.input,
            userMessage: JSON.stringify(probe.output),
            traceId: "key-candidate:" + randomUUID(),
          },
          {
            ...options,
            db,
            owner: { kind: "SYNTHETIC", runId: identity.name },
            liveEgressAllowed: true,
          },
          { target, record, resolver, authorization },
        );
        if (!result.ok) {
          // The Phase013 rotation receipt has a closed connection-error vocabulary.
          const code =
            result.errorCode === "PROVIDER_TIMEOUT" || result.errorCode === "PROVIDER_UNAVAILABLE"
              ? result.errorCode
              : "CONFIG_ERROR";
          throw new KeyLifecycleError(503, code);
        }
        return canonicalHash({
          candidate: target.candidate,
          traceId: result.traceId,
          outputHash: canonicalHash(result.output),
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });
      } catch (error) {
        if (error instanceof KeyLifecycleError) throw error;
        throw new KeyLifecycleError(503, "CONFIG_ERROR");
      }
    },
  };
}
