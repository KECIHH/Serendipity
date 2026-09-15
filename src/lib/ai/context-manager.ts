export interface Message {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}
export interface HistoryMessage {
  readonly role: "SYSTEM" | "USER" | "ASSISTANT";
  readonly content: string;
  readonly sequence: number;
}
export interface ContextLimits {
  readonly maxMessages: number;
  readonly maxChars: number;
}
export type ContextResult =
  | {
      readonly ok: true;
      readonly messages: readonly Message[];
      readonly truncated: boolean;
      readonly chars: number;
    }
  | { readonly ok: false; readonly errorCode: "CONFIG_ERROR" };

const invalid = (): ContextResult => ({ ok: false, errorCode: "CONFIG_ERROR" });

export function truncateContext(
  messages: readonly Message[],
  limits: ContextLimits,
): ContextResult {
  if (
    !Number.isSafeInteger(limits.maxMessages) ||
    limits.maxMessages < 1 ||
    limits.maxMessages > 1000 ||
    !Number.isSafeInteger(limits.maxChars) ||
    limits.maxChars < 1 ||
    limits.maxChars > 1_000_000 ||
    !Array.isArray(messages) ||
    messages.length > 10000
  )
    return invalid();
  if (
    messages.some(
      (message) =>
        !message ||
        !["system", "user", "assistant"].includes(message.role) ||
        typeof message.content !== "string" ||
        !message.content.trim() ||
        !message.content.isWellFormed(),
    )
  )
    return invalid();
  const required = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "system");
  if (!required.length) return invalid();
  let chars = required.reduce(
    (total, { message }) => total + Array.from(message.content).length,
    0,
  );
  if (required.length > limits.maxMessages || chars > limits.maxChars) return invalid();
  const selected = new Set(required.map(({ index }) => index));
  for (let index = messages.length - 1; index >= 0 && selected.size < limits.maxMessages; index--) {
    if (selected.has(index)) continue;
    const size = Array.from(messages[index].content).length;
    // Retain a contiguous recent suffix: never substitute an older turn for an oversized latest turn.
    if (chars + size > limits.maxChars) break;
    selected.add(index);
    chars += size;
  }
  const result = messages
    .filter((_, index) => selected.has(index))
    .map((message) => Object.freeze({ role: message.role, content: message.content }));
  return {
    ok: true,
    messages: Object.freeze(result),
    truncated: result.length !== messages.length,
    chars,
  };
}

export function buildContext(
  history: readonly HistoryMessage[],
  system: string,
  limits: ContextLimits,
): ContextResult {
  if (
    !Array.isArray(history) ||
    history.length > 10000 ||
    history.some(
      (row) =>
        !Number.isSafeInteger(row.sequence) ||
        row.sequence < 1 ||
        !["SYSTEM", "USER", "ASSISTANT"].includes(row.role),
    ) ||
    new Set(history.map((row) => row.sequence)).size !== history.length
  )
    return invalid();
  const ordered: HistoryMessage[] = [...history].sort((a, b) => a.sequence - b.sequence);
  const roles = { SYSTEM: "system", USER: "user", ASSISTANT: "assistant" } as const;
  return truncateContext(
    [
      { role: "system", content: system },
      ...ordered.map((row) => ({ role: roles[row.role], content: row.content })),
    ],
    limits,
  );
}
