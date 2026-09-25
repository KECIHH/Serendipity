import type { NluContext } from "@/server/ai/nlu-context";

/** Bind a running command without putting the anonymous cookie or user text into the owner key. */
export function nluCommandBinding(ctx: NluContext, travelRecordId?: string) {
  if (ctx.ownerContext.kind !== "COMMAND") return {};
  return {
    commandId: ctx.ownerContext.commandId,
    ...(travelRecordId ? { travelRecordId } : {}),
  };
}
