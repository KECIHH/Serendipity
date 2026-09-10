import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { fail, isApiError, ok, type ApiErrorCode, type ApiResponse } from "@/lib/api-response";

describe("API response constructors", () => {
  it("creates the exact success envelope and preserves data and caller requestId", () => {
    const data = { id: "p1" };
    const result = ok(data, "req-1");
    expect(result).toEqual({ success: true, data: { id: "p1" }, requestId: "req-1" });
    expect(result).not.toHaveProperty("error");
    if (result.success) expect(result.data).toBe(data);
  });

  it("creates the exact error envelope without a data field", () => {
    const result = fail("VALIDATION_ERROR", "x", "req-2");
    expect(result).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "x" },
      requestId: "req-2",
    });
    expect(result).not.toHaveProperty("data");
  });

  it("preserves explicitly supplied safe details by reference", () => {
    const details = { fields: [{ path: "title", rule: "REQUIRED" }] };
    const result = fail("VALIDATION_ERROR", "字段无效", "req-3", details);
    if (result.success) throw new Error("Expected a failure response.");
    expect(result.error.details).toBe(details);
    expect(fail("NOT_FOUND", "内容不可用", "req-null", null)).toHaveProperty("error.details", null);
  });

  it("omits undefined details and rejects an undefined success payload", () => {
    for (const response of [
      ok(null, "req-ok"),
      fail("NOT_FOUND", "内容不可用", "req-fail", undefined),
    ]) {
      expect(Object.values(response)).not.toContain(undefined);
      expect(response.requestId).toBeTruthy();
      if (!response.success) {
        expect(response.error).not.toHaveProperty("details");
        expect(Object.values(response.error)).not.toContain(undefined);
      }
    }
    expect(() => ok(undefined, "req-empty")).toThrow(TypeError);
  });

  it("requires caller-provided requestIds without generating a fallback", () => {
    for (const requestId of ["", "  ", undefined]) {
      expect(() => ok(null, requestId as string)).toThrow(TypeError);
      expect(() => fail("INTERNAL_ERROR", "操作失败", requestId as string)).toThrow(TypeError);
    }
  });

  it("allows success and failure values to narrow by the success discriminant", () => {
    const display = (response: ApiResponse<{ id: string }>) =>
      response.success ? response.data.id : response.error.code;
    expect(display(ok({ id: "p1" }, "req-1"))).toBe("p1");
    expect(display(fail("NOT_FOUND", "内容不可用", "req-2"))).toBe("NOT_FOUND");
  });
});

describe("isApiError", () => {
  it("recognizes the error produced by fail", () => {
    const result = fail("VALIDATION_ERROR", "x", "req-2");
    if (result.success) throw new Error("Expected a failure response.");
    expect(isApiError(result.error)).toBe(true);
    expect(isApiError(result)).toBe(false);
  });

  it("accepts every public error code declared by the single API contract", () => {
    const document = readFileSync(resolve(process.cwd(), "docs/api.md"), "utf8");
    const match = document.match(/"errors":\s*(\{[^\n]+\})/);
    if (!match) throw new Error("The public API error inventory is missing.");
    const codes = Object.keys(JSON.parse(match[1]) as Record<string, number>);
    expect(codes).toHaveLength(21);
    for (const code of codes) {
      expect(isApiError({ code, message: "安全错误文案" })).toBe(true);
      expect(fail(code as ApiErrorCode, "安全错误文案", "req-inventory").success).toBe(false);
    }
  });

  it("rejects missing or mistyped fields, arrays, inherited fields and extra keys", () => {
    const inherited = Object.create({ code: "NOT_FOUND", message: "内容不可用" }) as unknown;
    for (const value of [
      null,
      undefined,
      { code: 1 },
      { code: "NOT_FOUND" },
      { code: "NOT_FOUND", message: 1 },
      [{ code: "NOT_FOUND", message: "内容不可用" }],
      { code: "NOT_FOUND", message: "内容不可用", stack: "private" },
      inherited,
    ]) {
      expect(isApiError(value)).toBe(false);
    }
  });

  it("rejects unknown codes and internal diagnostics at the public boundary", () => {
    for (const code of [
      "UNKNOWN_ERROR",
      "INVALID_JSON",
      "SCHEMA_MISMATCH",
      "SECRET_DECRYPT_FAILED",
    ]) {
      expect(isApiError({ code, message: "x" })).toBe(false);
      expect(() => fail(code as ApiErrorCode, "x", "req-1")).toThrow(TypeError);
    }
  });
});
