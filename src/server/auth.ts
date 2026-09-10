import "server-only";

import { toASCII } from "tr46";

const LOCAL_PART_PATTERN =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class EmailNormalizationError extends Error {
  constructor() {
    super("Email address is invalid");
    this.name = "EmailNormalizationError";
  }
}

function invalidEmail(): never {
  throw new EmailNormalizationError();
}

/** Canonical V1 email identity shared by registration, login, and seed consumers. */
export function normalizeEmailV1(input: string): string {
  if (typeof input !== "string") invalidEmail();

  const trimmed = input.trim();
  const atIndex = trimmed.indexOf("@");
  if (atIndex <= 0 || atIndex !== trimmed.lastIndexOf("@") || atIndex === trimmed.length - 1) {
    invalidEmail();
  }

  const localPart = trimmed.slice(0, atIndex);
  const domainPart = trimmed.slice(atIndex + 1);
  if (
    Buffer.byteLength(localPart, "utf8") > 64 ||
    !LOCAL_PART_PATTERN.test(localPart) ||
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..")
  ) {
    invalidEmail();
  }

  const asciiDomain = toASCII(domainPart, {
    checkHyphens: true,
    checkBidi: true,
    checkJoiners: true,
    useSTD3ASCIIRules: true,
    transitionalProcessing: false,
    verifyDNSLength: true,
    ignoreInvalidPunycode: false,
  });
  if (!asciiDomain || asciiDomain.endsWith(".")) invalidEmail();

  const labels = asciiDomain.split(".");
  if (labels.some((label) => !DNS_LABEL_PATTERN.test(label))) invalidEmail();

  const canonical = `${localPart.toLowerCase()}@${asciiDomain.toLowerCase()}`;
  if (Buffer.byteLength(canonical, "ascii") > 254) invalidEmail();
  return canonical;
}
