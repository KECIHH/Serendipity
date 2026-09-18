import { validScalarFormat } from "@/lib/ai/schema-validation";
import type { NluContext } from "@/server/ai/nlu-context";

export interface DateParserContext {
  readonly serverDate: string;
  readonly timezone: string;
  readonly locale: string;
}

export interface ParsedDateRange {
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly text: string | null;
  readonly isFlexible: boolean;
  readonly timezone: string;
  readonly confidence: number;
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
  return new Date(Date.UTC(year, month + 1, 0));
}
function range(
  startDate: string,
  endDate: string,
  text: string,
  timezone: string,
  isFlexible = false,
): ParsedDateRange {
  return { startDate, endDate, text, isFlexible, timezone, confidence: 1 };
}

/** Resolve relative Chinese date phrases using only the certified server context. */
export function parseRelativeDate(
  text: string,
  context: DateParserContext | Pick<NluContext, "serverDate" | "timezone" | "locale">,
): ParsedDateRange | null {
  const value = text.trim();
  if (!value) return null;
  const base = dateAtUtc(context.serverDate);
  const timezone = context.timezone;
  const exact = value.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (exact) return range(exact[1], exact[1], value, timezone);

  const duration = value.match(/(?:玩|旅行|游玩)?\s*(\d{1,3})\s*天/);
  if (/国庆/.test(value)) {
    const year = base.getUTCFullYear();
    const start = new Date(Date.UTC(year, 9, 1));
    const days = duration ? Number(duration[1]) : 7;
    return range(iso(start), iso(new Date(start.getTime() + (days - 1) * DAY)), value, timezone);
  }
  if (/这周末|本周末/.test(value)) {
    const weekday = base.getUTCDay(); // Sunday=0; Monday is the first day of the natural week.
    const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
    const monday = new Date(base.getTime() + mondayOffset * DAY);
    const saturday = new Date(monday.getTime() + 5 * DAY);
    const sunday = new Date(monday.getTime() + 6 * DAY);
    // Sunday is treated as the just-finished weekend for planning, so the next
    // weekend is selected; Saturday remains the current weekend start.
    const start =
      base > sunday ? new Date(saturday.getTime() + 7 * DAY) : base >= saturday ? base : saturday;
    const end = new Date(start.getTime() + DAY);
    return range(iso(start), iso(end), value, timezone);
  }
  if (/下个月/.test(value)) {
    const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1));
    return range(
      iso(start),
      iso(endOfMonth(start.getUTCFullYear(), start.getUTCMonth())),
      value,
      timezone,
      true,
    );
  }
  if (duration) {
    return range(
      iso(base),
      iso(new Date(base.getTime() + (Number(duration[1]) - 1) * DAY)),
      value,
      timezone,
      true,
    );
  }
  return null;
}
