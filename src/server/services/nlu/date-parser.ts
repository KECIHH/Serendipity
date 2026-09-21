import { validScalarFormat } from "@/lib/ai/schema-validation";
import type { DateRange } from "@/lib/ai/schema-types";

export interface DateParserContext {
  readonly serverDate: string;
  readonly timezone: string;
  readonly locale: string;
}

const DAY = 86_400_000;
function dateAtUtc(value: string): Date {
  if (!validScalarFormat(value, "date")) throw new Error("CONFIG_ERROR");
  return new Date(`${value}T00:00:00Z`);
}
function iso(value: Date): string {
  return value.toISOString().slice(0, 10);
}
function endOfMonth(year: number, month: number): Date {
  return calendarDate(year, month + 1, 0);
}
function calendarDate(year: number, month: number, day: number): Date {
  const value = new Date(0);
  value.setUTCFullYear(year, month, day);
  return value;
}
function durationDays(text: string): number | null {
  const match = text.match(/([0-9]+|[一二两三四五六七八九十]+)\s*天/u);
  if (!match) return null;
  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const raw = match[1];
  const value = /^\d+$/.test(raw)
    ? Number(raw)
    : /^[一二三四五六七八九]?十[一二三四五六七八九]?$/.test(raw)
      ? (digits[raw.split("十")[0]] ?? 1) * 10 + (digits[raw.split("十")[1]] ?? 0)
      : digits[raw];
  return Number.isInteger(value) && value > 0 && value <= 365 ? value : 0;
}
function range(
  startDate: string,
  endDate: string,
  text: string,
  timezone: string,
  isFlexible = false,
): DateRange | null {
  if (
    !validScalarFormat(startDate, "date") ||
    !validScalarFormat(endDate, "date") ||
    startDate > endDate
  )
    return null;
  return { startDate, endDate, text, isFlexible, timezone, confidence: 1 };
}

/** Resolve relative Chinese date phrases using only the certified server context. */
export function parseRelativeDate(text: string, context: DateParserContext): DateRange | null {
  const value = text.trim();
  if (!value) return null;
  if (
    !validScalarFormat(context.timezone, "iana-timezone") ||
    !validScalarFormat(context.locale, "bcp47-locale")
  )
    throw new Error("CONFIG_ERROR");
  const base = dateAtUtc(context.serverDate);
  const timezone = context.timezone;
  const exact = [...value.matchAll(/(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)/g)].map((match) => match[1]);
  if (exact.length) {
    if (exact.length > 2 || exact.some((date) => !validScalarFormat(date, "date"))) return null;
    return range(exact[0], exact.at(-1)!, value, timezone);
  }

  const duration = durationDays(value);
  if (/国庆/.test(value)) {
    const year =
      context.serverDate.slice(5) > "10-07" ? base.getUTCFullYear() + 1 : base.getUTCFullYear();
    const start = calendarDate(year, 9, 1);
    const days = duration ?? 7;
    if (!days) return null;
    return range(iso(start), iso(new Date(start.getTime() + (days - 1) * DAY)), value, timezone);
  }
  if (/这周末|本周末/.test(value)) {
    const weekday = base.getUTCDay(); // Sunday=0; Monday is the first day of the natural week.
    const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
    const monday = new Date(base.getTime() + mondayOffset * DAY);
    const saturday = new Date(monday.getTime() + 5 * DAY);
    const sunday = new Date(monday.getTime() + 6 * DAY);
    const start = base >= saturday ? base : saturday;
    return range(iso(start), iso(sunday), value, timezone);
  }
  if (/下个月/.test(value)) {
    const start = calendarDate(base.getUTCFullYear(), base.getUTCMonth() + 1, 1);
    return range(
      iso(start),
      iso(endOfMonth(start.getUTCFullYear(), start.getUTCMonth())),
      value,
      timezone,
      true,
    );
  }
  // A duration alone supplies no departure date; later stages handle durationDays.
  return null;
}
