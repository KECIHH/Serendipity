import { describe, expect, it, vi } from "vitest";

import { safeJsonParse, stableStringify } from "@/lib/json";

describe("safeJsonParse", () => {
  it("returns a discriminated success result with the parsed value", () => {
    const result = safeJsonParse<{ title: string; days: number[] }>(
      '{"title":"际遇","days":[1,2]}',
    );
    expect(result).toEqual({ ok: true, value: { title: "际遇", days: [1, 2] } });
    if (result.ok) expect(result.value.title).toBe("际遇");
  });

  it("returns a nonempty error for invalid JSON", () => {
    const result = safeJsonParse("{");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("value");
  });

  it("distinguishes valid JSON null from a parse failure", () => {
    expect(safeJsonParse<null>("null")).toEqual({ ok: true, value: null });
    expect(safeJsonParse("").ok).toBe(false);
    expect(safeJsonParse(undefined as unknown as string).ok).toBe(false);
  });
});

describe("stableStringify", () => {
  it("serializes object keys in a stable order regardless of insertion order", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it("sorts nested objects while preserving array order", () => {
    const first = { outer: [{ b: 1, a: 2 }, { z: { b: 3, a: 4 } }] };
    const second = { outer: [{ a: 2, b: 1 }, { z: { a: 4, b: 3 } }] };
    expect(stableStringify(first)).toBe(stableStringify(second));
    expect(stableStringify(first)).toBe('{"outer":[{"a":2,"b":1},{"z":{"a":4,"b":3}}]}');
    expect(stableStringify([2, 1])).toBe("[2,1]");
  });

  it("uses ordinal UTF-16 ordering for numeric, accented and surrogate keys", () => {
    const fixture = { "2": 2, "10": 10, a: 4, Z: 3, ä: 5, "😀": 6, "\uE000": 7 };
    expect(stableStringify(fixture)).toBe('{"10":10,"2":2,"Z":3,"a":4,"ä":5,"😀":6,"":7}');
  });

  it("never invokes a locale comparator", () => {
    const comparator = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("Locale-dependent comparison is forbidden.");
    });
    try {
      expect(stableStringify({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
      expect(comparator).not.toHaveBeenCalled();
    } finally {
      comparator.mockRestore();
    }
  });

  it("supports JSON primitives and escapes strings with JSON syntax", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(true)).toBe("true");
    expect(stableStringify(-0)).toBe("0");
    expect(stableStringify('际遇\n"旅行"')).toBe('"际遇\\n\\"旅行\\""');
  });

  it("allows shared references that do not form a cycle", () => {
    const shared = { value: 1 };
    expect(stableStringify({ b: shared, a: shared })).toBe('{"a":{"value":1},"b":{"value":1}}');
  });

  it("rejects direct and indirect cycles", () => {
    const self: Record<string, unknown> = {};
    self.self = self;
    expect(() => stableStringify(self)).toThrow(TypeError);
    const array: unknown[] = [];
    array.push({ array });
    expect(() => stableStringify(array)).toThrow(TypeError);
  });

  it("rejects undefined, BigInt, functions, symbols and nonfinite values at every depth", () => {
    for (const value of [
      undefined,
      BigInt(1),
      () => 1,
      Symbol("fixture"),
      NaN,
      Infinity,
      -Infinity,
    ]) {
      expect(() => stableStringify(value)).toThrow(TypeError);
      expect(() => stableStringify({ value })).toThrow(TypeError);
      expect(() => stableStringify([value])).toThrow(TypeError);
    }
  });

  it("rejects nonplain objects instead of applying toJSON or silently emitting an empty object", () => {
    for (const value of [
      new Date("2026-09-10T00:00:00Z"),
      new Map(),
      new Set(),
      /fixture/,
      new Uint8Array(1),
    ]) {
      expect(() => stableStringify(value)).toThrow(TypeError);
    }
    const toJSON = vi.fn(() => "hidden");
    expect(() => stableStringify({ toJSON })).toThrow(TypeError);
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("rejects sparse arrays and array properties that JSON would silently lose", () => {
    expect(() => stableStringify(new Array(2))).toThrow(TypeError);
    const extra = Object.assign([1], { metadata: true });
    expect(() => stableStringify(extra)).toThrow(TypeError);
    const compensatedHole = Object.assign(new Array(1), { metadata: true });
    expect(() => stableStringify(compensatedHole)).toThrow(TypeError);
  });

  it("rejects symbol keys and nonenumerable data", () => {
    expect(() => stableStringify({ [Symbol("hidden")]: 1 })).toThrow(TypeError);
    expect(() => stableStringify(Object.defineProperty({}, "hidden", { value: 1 }))).toThrow(
      TypeError,
    );
  });

  it("rejects accessors without evaluating them", () => {
    const getter = vi.fn(() => 1);
    const object = Object.defineProperty({}, "value", { enumerable: true, get: getter });
    expect(() => stableStringify(object)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });

  it("handles null-prototype objects and prototype-looking keys as ordinary data", () => {
    const object = Object.create(null) as Record<string, unknown>;
    object.b = 1;
    object.a = 2;
    expect(stableStringify(object)).toBe('{"a":2,"b":1}');
    expect(stableStringify(JSON.parse('{"__proto__":{"safe":true},"a":1}'))).toBe(
      '{"__proto__":{"safe":true},"a":1}',
    );
  });

  it("does not reorder or change input data", () => {
    const nested = Object.freeze({ b: 1, a: 2 });
    const input = Object.freeze({ z: Object.freeze([nested]), a: 0 });
    expect(stableStringify(input)).toBe('{"a":0,"z":[{"a":2,"b":1}]}');
    expect(Object.keys(input)).toEqual(["z", "a"]);
    expect(Object.keys(nested)).toEqual(["b", "a"]);
  });
});
