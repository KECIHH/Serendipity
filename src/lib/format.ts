export type MoneyCurrency = "CNY" | "USD";

export type CostStatus = "free" | "verified_estimate" | "estimated" | "unknown" | "stale";

export type FactFreshness = {
  status: "fresh" | "aging" | "stale" | "expired" | "unknown";
  checkedAt: string;
  freshnessPolicyVersion: string;
};

export type CostEstimate = {
  amount: string | null;
  currency: MoneyCurrency;
  costStatus: CostStatus;
  costBasis: string | null;
  sourceRefs: readonly string[];
  fetchedAt: string | null;
  confidence: number;
  freshness: FactFreshness;
};

const decimalPattern = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

function localDateParts(value: string): [number, number, number] {
  const match = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError("Expected a local date in YYYY-MM-DD format.");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
    throw new RangeError("Expected a real Gregorian calendar date.");
  }
  return [year, month, day];
}

export function formatDateRange(startDate: string, endDate: string): string {
  const start = localDateParts(startDate);
  const end = localDateParts(endDate);
  if (startDate > endDate) throw new RangeError("The end date must not precede the start date.");

  const display = ([year, month, day]: [number, number, number]) =>
    `${String(year).padStart(4, "0")}年${month}月${day}日`;
  return startDate === endDate ? display(start) : `${display(start)} ～ ${display(end)}`;
}

export function formatDuration(durationMinutes: number): string {
  if (!Number.isSafeInteger(durationMinutes) || durationMinutes < 0) {
    throw new RangeError("durationMinutes must be a nonnegative safe integer.");
  }
  const hours = Math.floor(durationMinutes / 60);
  const remainingMinutes = durationMinutes % 60;
  if (hours === 0) return `${remainingMinutes}分钟`;
  return `${hours}小时${remainingMinutes === 0 ? "" : `${remainingMinutes}分钟`}`;
}

function currencySymbol(currency: MoneyCurrency): string {
  if (currency === "CNY") return "¥";
  if (currency === "USD") return "$";
  throw new RangeError("Only CNY and USD are supported.");
}

function decimalParts(amount: string): [string, string] {
  const match = typeof amount === "string" && decimalPattern.exec(amount);
  if (!match) throw new RangeError("Amount must be a nonnegative decimal string.");
  return [match[1], match[2] ?? ""];
}

/** Display rounding is half-even; the original decimal string is never changed. */
export function formatMoney(amount: string, currency: MoneyCurrency): string {
  const symbol = currencySymbol(currency);
  const [integer, fraction] = decimalParts(amount);
  const retainedFraction = fraction.padEnd(2, "0").slice(0, 2);
  let minorUnits = BigInt(`${integer}${retainedFraction}`);
  const firstDiscardedDigit = fraction[2] ?? "0";
  const hasLaterNonzeroDigit = /[1-9]/.test(fraction.slice(3));
  if (
    firstDiscardedDigit > "5" ||
    (firstDiscardedDigit === "5" && (hasLaterNonzeroDigit || minorUnits % BigInt(2) !== BigInt(0)))
  ) {
    minorUnits += BigInt(1);
  }

  const rounded = minorUnits.toString().padStart(3, "0");
  const groupedInteger = rounded.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${symbol}${groupedInteger}.${rounded.slice(-2)}`;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isNonblankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  try {
    localDateParts(match[1]);
  } catch {
    return false;
  }
  return (
    Number(match[2]) <= 23 &&
    Number(match[3]) <= 59 &&
    Number(match[4]) <= 59 &&
    (match[5] === "Z" || (Number(match[7]) <= 23 && Number(match[8]) <= 59))
  );
}

function validateCostEstimate(costEstimate: CostEstimate): void {
  if (
    !hasExactKeys(costEstimate, [
      "amount",
      "currency",
      "costStatus",
      "costBasis",
      "sourceRefs",
      "fetchedAt",
      "confidence",
      "freshness",
    ]) ||
    !["free", "verified_estimate", "estimated", "unknown", "stale"].includes(
      costEstimate.costStatus,
    ) ||
    (costEstimate.costBasis !== null && !isNonblankString(costEstimate.costBasis)) ||
    !Array.isArray(costEstimate.sourceRefs) ||
    !Array.from(costEstimate.sourceRefs).every(isNonblankString) ||
    new Set(costEstimate.sourceRefs).size !== costEstimate.sourceRefs.length ||
    !Number.isFinite(costEstimate.confidence) ||
    costEstimate.confidence < 0 ||
    costEstimate.confidence > 1 ||
    !hasExactKeys(costEstimate.freshness, ["status", "checkedAt", "freshnessPolicyVersion"]) ||
    !["fresh", "aging", "stale", "expired", "unknown"].includes(costEstimate.freshness.status) ||
    !isInstant(costEstimate.freshness.checkedAt) ||
    !isNonblankString(costEstimate.freshness.freshnessPolicyVersion)
  ) {
    throw new RangeError("Expected a complete canonical costEstimate.");
  }
  currencySymbol(costEstimate.currency);

  if (costEstimate.costStatus === "unknown") {
    if (
      costEstimate.amount !== null ||
      costEstimate.sourceRefs.length !== 0 ||
      costEstimate.fetchedAt !== null ||
      costEstimate.confidence !== 0 ||
      costEstimate.freshness.status !== "unknown"
    ) {
      throw new RangeError("Unknown cost must not imply a known amount or source.");
    }
    return;
  }

  if (
    costEstimate.amount === null ||
    costEstimate.sourceRefs.length === 0 ||
    !isInstant(costEstimate.fetchedAt) ||
    costEstimate.freshness.status === "unknown"
  ) {
    throw new RangeError("Known costs require an amount, source and freshness evidence.");
  }
  const [integer, fraction] = decimalParts(costEstimate.amount);
  const isZero = !/[1-9]/.test(integer + fraction);
  if (
    (costEstimate.costStatus === "free" && costEstimate.amount !== "0") ||
    (costEstimate.costStatus !== "free" && isZero)
  ) {
    throw new RangeError('Only an explicit free cost may have amount "0".');
  }
}

export function formatCostEstimate(costEstimate: CostEstimate): string {
  validateCostEstimate(costEstimate);
  if (costEstimate.costStatus === "unknown") return "未知";

  const needsVerification =
    costEstimate.costStatus === "stale" ||
    costEstimate.freshness.status === "stale" ||
    costEstimate.freshness.status === "expired";
  if (costEstimate.costStatus === "free") {
    return needsVerification ? "免费（已过期/待核验）" : "免费";
  }

  const amount = formatMoney(costEstimate.amount as string, costEstimate.currency);
  const labels: string[] = [];
  if (costEstimate.costStatus === "estimated") labels.push("估算");
  if (costEstimate.costStatus === "verified_estimate") labels.push("已核验估算");
  if (needsVerification) labels.push("已过期/待核验");
  return `${amount}（${labels.join("；")}）`;
}

export function truncate(text: string, maxLength: number): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 0) {
    throw new RangeError("maxLength must be a nonnegative safe integer.");
  }
  if (maxLength === 0) return "";
  const codePoints = Array.from(text);
  return codePoints.length <= maxLength ? text : `${codePoints.slice(0, maxLength - 1).join("")}…`;
}
