import "server-only";

const messages = {
  VALIDATION_ERROR: "Data input is invalid.",
  NOT_FOUND: "The requested record was not found.",
  IDEMPOTENCY_KEY_REUSED: "The message key was already used for different content.",
  INTERNAL_ERROR: "The data operation could not be completed.",
} as const;

export type DataLayerErrorCode = keyof typeof messages;

export class DataLayerError extends Error {
  readonly code: DataLayerErrorCode;

  constructor(code: DataLayerErrorCode) {
    super(messages[code]);
    this.name = "DataLayerError";
    this.code = code;
  }
}

export function readDataLayerObject(
  value: unknown,
  allowedFields: readonly string[],
  requiredFields: readonly string[],
): Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new DataLayerError("VALIDATION_ERROR");
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DataLayerError("VALIDATION_ERROR");
    }
    const fields: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !allowedFields.includes(key)) {
        throw new DataLayerError("VALIDATION_ERROR");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new DataLayerError("VALIDATION_ERROR");
      }
      fields[key] = descriptor.value as unknown;
    }
    if (requiredFields.some((key) => !Object.hasOwn(fields, key))) {
      throw new DataLayerError("VALIDATION_ERROR");
    }
    return fields;
  } catch {
    throw new DataLayerError("VALIDATION_ERROR");
  }
}

export function parseDataIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    /[^A-Za-z0-9_-]/.test(value)
  ) {
    throw new DataLayerError("VALIDATION_ERROR");
  }
  return value;
}

export function parsePositiveSequence(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new DataLayerError("VALIDATION_ERROR");
  }
  return value;
}

export function requireAbsentJson(value: unknown): void {
  if (value !== undefined && value !== null) {
    throw new DataLayerError("VALIDATION_ERROR");
  }
}

export async function runDataLayerOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof DataLayerError) throw error;
    throw new DataLayerError("INTERNAL_ERROR");
  }
}
