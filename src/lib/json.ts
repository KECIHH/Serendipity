export function safeJsonParse<T>(
  text: string,
): { ok: true; value: T } | { ok: false; error: string } {
  if (typeof text !== "string") return { ok: false, error: "JSON input must be a string." };
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error && error.message.length > 0 ? error.message : "Invalid JSON.",
    };
  }
}

/** Serialize JSON data without locale ordering, implicit omission or toJSON hooks. */
export function stableStringify(value: unknown): string {
  const ancestors = new Set<object>();

  const ownValue = (object: object, key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("JSON data must contain only enumerable data properties.");
    }
    return descriptor.value as unknown;
  };

  const serialize = (current: unknown): string => {
    if (current === null) return "null";
    switch (typeof current) {
      case "string":
      case "boolean":
        return JSON.stringify(current);
      case "number":
        if (!Number.isFinite(current)) throw new TypeError("JSON numbers must be finite.");
        return JSON.stringify(current);
      case "object": {
        if (ancestors.has(current))
          throw new TypeError("JSON data must not contain circular references.");
        if (Object.getOwnPropertySymbols(current).length > 0) {
          throw new TypeError("JSON data must not contain symbol keys.");
        }
        const isArray = Array.isArray(current);
        const prototype = Object.getPrototypeOf(current);
        if (!isArray && prototype !== Object.prototype && prototype !== null) {
          throw new TypeError("JSON objects must be plain objects.");
        }
        ancestors.add(current);
        try {
          if (isArray) {
            if (Object.getOwnPropertyNames(current).length !== current.length + 1) {
              throw new TypeError("JSON arrays must be dense and have no extra properties.");
            }
            const items: string[] = [];
            for (let index = 0; index < current.length; index += 1) {
              items.push(serialize(ownValue(current, String(index))));
            }
            return `[${items.join(",")}]`;
          }

          const keys = Object.getOwnPropertyNames(current).sort((a, b) =>
            a < b ? -1 : a > b ? 1 : 0,
          );
          return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(ownValue(current, key))}`).join(",")}}`;
        } finally {
          ancestors.delete(current);
        }
      }
      default:
        throw new TypeError("Value is not JSON-compatible.");
    }
  };

  return serialize(value);
}
