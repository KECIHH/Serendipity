// @vitest-environment node
import { createHash, randomBytes } from "node:crypto";
import * as dns from "node:dns/promises";
import https from "node:https";
import { describe, expect, it, vi } from "vitest";
import {
  ApiKeyInputError,
  parseApiKeyCreate,
  parseApiKeyPatch,
  parseApiKeyQuery,
  parseApiKeyRotateRequest,
  parseKeyRotationReceipt,
  type KeyRotationReceipt,
} from "@/lib/admin-api-keys";
import { makeAdminCommandIdentity } from "@/server/admin/command-receipt";
import {
  createKeyCandidateClient,
  isPublicKeyClientAddress,
} from "@/server/admin/key-candidate-client";

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});

describe("admin/api-keys receipt boundaries", () => {
  const receipt: KeyRotationReceipt = {
    key: {
      id: "fixture-key",
      name: "合成密钥",
      provider: "fixture-provider",
      keyFingerprintDisplay: "aaaaaaaaaaaa…",
      status: "ACTIVE",
      revision: 1,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z",
    },
    stage: "ACTIVATED",
    affectedConfigCount: 2,
    errorCode: null,
    replayed: false,
  };

  it("accepts the exact string stage and error enums including a null error", () => {
    for (const stage of ["PREPARING", "TESTING", "READY", "ACTIVATED", "ABORTED"])
      expect(parseKeyRotationReceipt({ ...receipt, stage }).stage).toBe(stage);
    for (const errorCode of [
      null,
      "CONFIG_ERROR",
      "PROVIDER_UNAVAILABLE",
      "PROVIDER_TIMEOUT",
      "VERSION_CONFLICT",
      "INTERNAL_ERROR",
    ])
      expect(parseKeyRotationReceipt({ ...receipt, stage: "TESTING", errorCode }).errorCode).toBe(
        errorCode,
      );
  });

  it.each([
    ["stage", "ACTIVATED"],
    ["errorCode", "CONFIG_ERROR"],
  ] as const)("rejects non-string %s without calling coercion hooks", (field, member) => {
    const toString = vi.fn(() => member),
      toPrimitive = vi.fn(() => member);
    const boxed: unknown = Object(member);
    const invalid: unknown[] = [
      undefined,
      false,
      true,
      0,
      1,
      {},
      [],
      [member],
      [[member]],
      boxed,
      { toString },
      { [Symbol.toPrimitive]: toPrimitive },
      "UNKNOWN",
      `${member} `,
      ...(field === "stage" ? [null] : []),
    ];
    for (const value of invalid)
      expect(() => parseKeyRotationReceipt({ ...receipt, [field]: value })).toThrow(
        ApiKeyInputError,
      );
    expect(toString).not.toHaveBeenCalled();
    expect(toPrimitive).not.toHaveBeenCalled();
  });
});

describe("admin/api-keys request boundaries", () => {
  it("normalizes reserved IPv6 CIDRs and rejects every unsafe DNS result before HTTPS transport", async () => {
    const unsafe = [
      "2001:2::1",
      "3fff::1",
      "2002:7f00:1::",
      "2001:0db8::1",
      "2001:0002:0000:0000:0000:0000:0000:1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
      "ff02::1",
      "3ffe::1",
    ];
    expect(isPublicKeyClientAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicKeyClientAddress("2606:4700:4700:0000:0000:0000:0000:1111")).toBe(true);
    expect(isPublicKeyClientAddress("8.8.8.8")).toBe(true);
    for (const address of [
      ...unsafe,
      "192.88.99.1",
      "192.0.2.1",
      "198.51.100.1",
      "203.0.113.1",
      "100.64.0.1",
    ])
      expect(isPublicKeyClientAddress(address)).toBe(false);
    const transport = vi.spyOn(https, "request").mockImplementation(() => {
      throw new Error("Unexpected network boundary");
    });
    const target = {
      url: "https://candidate.fixture.invalid/candidate/fixture",
      keyId: "fixture-key",
      candidate: {
        adapterId: "fixture",
        referenceId: "fixture",
        candidateId: "fixture",
        configVersion: 1,
        referenceRevision: 0,
        contentHash: "a".repeat(64),
      },
    };
    const client = createKeyCandidateClient({
      inventory: [{ origin: "https://candidate.fixture.invalid", pathPrefix: "/candidate/" }],
    });
    const credential = randomBytes(24).toString("hex");
    try {
      for (const address of unsafe) {
        vi.mocked(dns.lookup).mockResolvedValue([{ address, family: 6 }] as never);
        await expect(client.verify(target, credential)).rejects.toMatchObject({
          publicCode: "CONFIG_ERROR",
        });
      }
      vi.mocked(dns.lookup).mockResolvedValue([
        { address: "2606:4700:4700::1111", family: 6 },
        { address: "2001:0db8::1", family: 6 },
      ] as never);
      await expect(client.verify(target, credential)).rejects.toMatchObject({
        publicCode: "CONFIG_ERROR",
      });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      transport.mockRestore();
      vi.mocked(dns.lookup).mockReset();
    }
  });

  it("normalizes only the secret boundary and keeps exact create, patch and rotate fields", () => {
    const plainKey = randomBytes(24).toString("hex"),
      created = parseApiKeyCreate({
        name: " 名称 ",
        provider: "fixture-provider",
        plainKey: ` ${plainKey} `,
      });
    expect(created.plainKey === plainKey).toBe(true);
    expect(created.name).toBe("名称");
    expect(() => parseApiKeyPatch({ expectedVersion: 0 })).toThrow(ApiKeyInputError);
    expect(() => parseApiKeyPatch({ name: "名称", expectedVersion: "0" })).toThrow(
      ApiKeyInputError,
    );
    expect(() => parseApiKeyPatch({ plainKey, expectedVersion: 0 })).toThrow(ApiKeyInputError);
    expect(() =>
      parseApiKeyRotateRequest({ ...created, expectedVersion: 0, replacesId: "old" }),
    ).toThrow(ApiKeyInputError);
    expect(
      parseApiKeyCreate({ name: "名".repeat(200), provider: "fixture-provider", plainKey }).name
        .length,
    ).toBe(200);
    expect(() =>
      parseApiKeyCreate({ name: "名".repeat(201), provider: "fixture-provider", plainKey }),
    ).toThrow(ApiKeyInputError);
  });
  it("hashes every validated nonsecret field in each registered write operation", () => {
    const keyFingerprint = createHash("sha256").update(randomBytes(32)).digest("hex"),
      base = {
        ownerUserId: "fixture-admin",
        resourceId: "global",
        idempotencyKey: "fixture-idempotency",
      };
    const identity = (name: string, provider: string) =>
      makeAdminCommandIdentity({
        ...base,
        operationId: "post.admin.api-keys",
        payload: { name, provider, keyFingerprint },
      });
    expect(
      identity("one", "provider-a").requestHash === identity("two", "provider-a").requestHash,
    ).toBe(false);
    expect(
      identity("one", "provider-a").requestHash === identity("one", "provider-b").requestHash,
    ).toBe(false);
    const changed = makeAdminCommandIdentity({
      ...base,
      operationId: "patch.admin.api-keys.id",
      payload: { status: "DISABLED", expectedVersion: 0 },
    });
    expect(
      changed.requestHash ===
        makeAdminCommandIdentity({
          ...base,
          operationId: "patch.admin.api-keys.id",
          payload: { status: "ACTIVE", expectedVersion: 0 },
        }).requestHash,
    ).toBe(false);
  });
  it("rejects duplicate filters and enforces the stable cursor and page bounds", () => {
    for (const query of [
      "limit=101",
      "limit=-1",
      "limit=2&limit=2",
      "status=enabled",
      "userId=fixture",
      "provider=" + "x".repeat(129),
    ])
      expect(() => parseApiKeyQuery(new URLSearchParams(query))).toThrow(ApiKeyInputError);
    expect(parseApiKeyQuery(new URLSearchParams()).limit).toBe(20);
  });
  it("fails closed for production loopback, unbound targets and unsafe credential headers without any request", async () => {
    const target = {
      url: "http://127.0.0.1:1/candidate/fixture",
      keyId: "fixture-key",
      candidate: {
        adapterId: "fixture",
        referenceId: "fixture",
        candidateId: "fixture",
        configVersion: 1,
        referenceRevision: 0,
        contentHash: "a".repeat(64),
      },
    };
    const secret = randomBytes(24).toString("hex");
    await expect(
      createKeyCandidateClient({
        mode: "LIVE",
        inventory: [{ origin: "http://127.0.0.1:1", pathPrefix: "/candidate/" }],
      }).verify(target, secret),
    ).rejects.toMatchObject({ publicCode: "CONFIG_ERROR" });
    await expect(
      createKeyCandidateClient({ mode: "ISOLATED_SYNTHETIC" }).verify(target, secret),
    ).rejects.toMatchObject({ publicCode: "CONFIG_ERROR" });
    await expect(
      createKeyCandidateClient({
        mode: "ISOLATED_SYNTHETIC",
        inventory: [{ origin: "http://127.0.0.1:1", pathPrefix: "/candidate/" }],
      }).verify(target, `${secret}\r\nheader:value`),
    ).rejects.toMatchObject({ publicCode: "CONFIG_ERROR" });
  });
});
