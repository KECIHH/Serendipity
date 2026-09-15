import { canonicalJson } from "./canonical-json";
import type { TravelRequirement } from "./schema-types";
import type { SchemaIssue } from "./schema-validation";
import travel from "./travel-contract.json";

/** Cross-field rules from the frozen v1 contract; this does not grant planning readiness. */
export function requirementIssues(value: TravelRequirement): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const add = (path: string) => issues.push({ path, summary: "CONSTRAINT" });
  const ids = [...value.destinations, ...value.preferences.hardConstraints].map((item) => item.id);
  if (new Set(ids).size !== ids.length) add("$.destinations");
  for (const field of ["fieldSources", "missingFields"] as const)
    if (new Set(value[field].map((item) => item.field)).size !== value[field].length)
      add(`$.${field}`);
  const people = value.travelers;
  const groups = [people.adultCount, people.childCount, people.elderCount, people.ageUnknownCount];
  const sum = groups.reduce<number>((total, count) => total + (count ?? 0), 0);
  if (
    (groups.every((count) => count !== null) && people.totalCount !== sum) ||
    (people.totalCount !== null && sum > people.totalCount)
  )
    add("$.travelers.totalCount");
  for (const [count, flag] of [
    ["childCount", "hasChild"],
    ["elderCount", "hasElder"],
  ] as const)
    if (people[flag] !== (people[count] === null ? null : people[count] > 0))
      add(`$.travelers.${flag}`);
  for (const [relationship, flag] of [
    ["couple", "isCouple"],
    ["family", "isFamily"],
  ] as const)
    if (
      people[flag] !== (people.relationship === null ? null : people.relationship === relationship)
    )
      add(`$.travelers.${flag}`);
  const transport = value.preferences.transport;
  const explicit =
    transport.length > 0 ||
    value.fieldSources.some(
      (source) =>
        source.field === "preferences.transport" &&
        ["USER_TEXT", "USER_CONTROL"].includes(source.method),
    );
  const countriesKnown =
    !!value.origin?.country &&
    value.destinations.length > 0 &&
    value.destinations.every((destination) => destination.country !== null);
  const flags = {
    isSelfDriving: explicit ? transport.includes("self_driving") : null,
    isHiking: explicit ? transport.includes("hiking") : null,
    isOverseas: countriesKnown
      ? value.destinations.some((destination) => destination.country !== value.origin?.country)
      : null,
  };
  if (canonicalJson(flags) !== canonicalJson(value.specialFlags)) add("$.specialFlags");
  if (
    value.preferences.consent.sensitiveRequirementProcessing === true &&
    !value.fieldSources.some(
      (source) => source.field === "preferences.consent" && source.method === "USER_CONTROL",
    )
  )
    add("$.preferences.consent");
  if (value.origin && value.origin.city === null && value.origin.country === null) add("$.origin");
  const range = value.dateRange;
  if (range) {
    if (
      (range.startDate === null && range.endDate === null && range.text === null) ||
      (range.startDate === null) !== (range.endDate === null)
    )
      add("$.dateRange");
    if (range.startDate && range.endDate) {
      const days =
        (Date.parse(`${range.endDate}T00:00:00Z`) - Date.parse(`${range.startDate}T00:00:00Z`)) /
          86400000 +
        1;
      if (
        days < 1 ||
        (!range.isFlexible && value.durationDays !== days) ||
        (range.isFlexible && value.durationDays !== null && value.durationDays > days)
      )
        add("$.durationDays");
    }
  }
  const { amount, currency } = value.budget;
  const minorUnits: Readonly<Record<string, number>> = travel.scalars.currencyMinorUnits;
  if (
    amount !== null &&
    currency !== null &&
    (amount.split(".")[1]?.length ?? 0) > minorUnits[currency]
  )
    add("$.budget.amount");
  function meaningful(item: unknown, name = ""): boolean {
    if (["confidence", "hasChild", "hasElder", "isCouple", "isFamily"].includes(name)) return false;
    if (Array.isArray(item)) return item.length > 0;
    if (item && typeof item === "object")
      return Object.entries(item).some(([key, child]) => meaningful(child, key));
    return item !== null;
  }
  for (const field of travel.requirement.$defs.FieldPath.enum) {
    const fieldValue = field
      .split(".")
      .reduce<unknown>((item, name) => (item as Record<string, unknown>)[name], value);
    if (meaningful(fieldValue) && !value.fieldSources.some((source) => source.field === field))
      add(`$.${field}`);
  }
  return issues;
}
