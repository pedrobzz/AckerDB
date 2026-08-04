/**
 * Minimal five-field cron (minute hour day-of-month month day-of-week) with
 * IANA-timezone evaluation. Field syntax: `*`, lists `a,b`, ranges `a-b`, and
 * steps `*\/n` or `a-b/n`. Names are not supported; day-of-week is 0-6 with 0
 * as Sunday (7 normalizes to 0).
 *
 * The search walks wall-clock minutes in the target timezone using a
 * date-component increment, so DST transitions cannot skip or double an
 * occurrence: a wall-clock time that does not exist on a transition day simply
 * never matches that day, matching every mainstream cron daemon.
 */

interface CronField {
  readonly values: ReadonlySet<number>;
  readonly any: boolean;
}

export interface CronExpression {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

const FIELD_RANGES: readonly (readonly [number, number, string])[] = [
  [0, 59, "minute"],
  [0, 23, "hour"],
  [1, 31, "day-of-month"],
  [1, 12, "month"],
  [0, 7, "day-of-week"],
];

function parseField(spec: string, min: number, max: number, label: string): CronField {
  if (spec === "*") return { values: new Set(), any: true };
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    const [rangeSpec, stepSpec, ...rest] = part.split("/");
    if (rest.length > 0 || rangeSpec === undefined || rangeSpec.length === 0) {
      throw new TypeError(`cron ${label} "${part}" is malformed`);
    }
    const step = stepSpec === undefined ? 1 : Number(stepSpec);
    if (!Number.isInteger(step) || step < 1) {
      throw new TypeError(`cron ${label} step "${stepSpec}" must be a positive integer`);
    }
    let low: number;
    let high: number;
    if (rangeSpec === "*") {
      low = min;
      high = max;
    } else {
      const bounds = rangeSpec.split("-");
      if (bounds.length > 2) throw new TypeError(`cron ${label} "${part}" is malformed`);
      low = Number(bounds[0]);
      high = bounds.length === 2 ? Number(bounds[1]) : low;
      if (!Number.isInteger(low) || !Number.isInteger(high)) {
        throw new TypeError(`cron ${label} "${part}" must use integers`);
      }
      if (low < min || high > max || low > high) {
        throw new TypeError(`cron ${label} "${part}" is outside ${min}-${max}`);
      }
      if (stepSpec !== undefined && bounds.length === 1) {
        // `a/n` means `a-max/n`, matching Vixie cron.
        high = max;
      }
    }
    for (let value = low; value <= high; value += step) {
      values.add(value === 7 && max === 7 ? 0 : value);
    }
  }
  return { values, any: false };
}

export function parseCronExpression(expression: string): CronExpression {
  if (typeof expression !== "string") throw new TypeError("cron expression must be a string");
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new TypeError(
      `cron expression "${expression}" must have exactly 5 fields (minute hour day-of-month month day-of-week)`,
    );
  }
  const parsed = fields.map((field, position) => {
    const [min, max, label] = FIELD_RANGES[position]!;
    return parseField(field, min, max, label);
  });
  return {
    minute: parsed[0]!,
    hour: parsed[1]!,
    dayOfMonth: parsed[2]!,
    month: parsed[3]!,
    dayOfWeek: parsed[4]!,
  };
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const wallClockFormats = new Map<string, Intl.DateTimeFormat>();

function wallClockFormat(tz: string): Intl.DateTimeFormat {
  let format = wallClockFormats.get(tz);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
      hour12: false,
    });
    wallClockFormats.set(tz, format);
  }
  return format;
}

const WEEKDAYS: Readonly<Record<string, number>> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function wallClockAt(timestamp: number, tz: string): WallClock {
  const clock: WallClock = { year: 0, month: 0, day: 0, hour: 0, minute: 0, weekday: 0 };
  for (const part of wallClockFormat(tz).formatToParts(timestamp)) {
    switch (part.type) {
      case "year": clock.year = Number(part.value); break;
      case "month": clock.month = Number(part.value); break;
      case "day": clock.day = Number(part.value); break;
      // Intl emits hour 24 for midnight with hour12: false in some engines.
      case "hour": clock.hour = Number(part.value) % 24; break;
      case "minute": clock.minute = Number(part.value); break;
      case "weekday": clock.weekday = WEEKDAYS[part.value]!; break;
      default: break;
    }
  }
  return clock;
}

function matchesDay(expression: CronExpression, clock: WallClock): boolean {
  // Vixie cron: when both day fields are restricted, either may match.
  const domRestricted = !expression.dayOfMonth.any;
  const dowRestricted = !expression.dayOfWeek.any;
  const domMatches = !domRestricted || expression.dayOfMonth.values.has(clock.day);
  const dowMatches = !dowRestricted || expression.dayOfWeek.values.has(clock.weekday);
  if (domRestricted && dowRestricted) return domMatches || dowMatches;
  return domMatches && dowMatches;
}

function matches(expression: CronExpression, clock: WallClock): boolean {
  return (
    (expression.minute.any || expression.minute.values.has(clock.minute)) &&
    (expression.hour.any || expression.hour.values.has(clock.hour)) &&
    (expression.month.any || expression.month.values.has(clock.month)) &&
    matchesDay(expression, clock)
  );
}

const MINUTE_MS = 60_000;
/** Cron's own guarantee: every expression matches within any 4-year window. */
const SEARCH_LIMIT_MS = 4 * 366 * 24 * 60 * MINUTE_MS;

/**
 * The first occurrence strictly after `after`, evaluated on the timezone's
 * wall clock, or null when the expression cannot match within four years
 * (impossible dates like `0 0 31 2 *`).
 */
export function cronNext(expression: string, tz: string, after: number): number | null {
  const parsed = parseCronExpression(expression);
  // Start at the next whole minute strictly after `after`.
  let timestamp = (Math.floor(after / MINUTE_MS) + 1) * MINUTE_MS;
  const limit = timestamp + SEARCH_LIMIT_MS;
  while (timestamp < limit) {
    const clock = wallClockAt(timestamp, tz);
    if (matches(parsed, clock)) return timestamp;
    // Skip ahead by whole hours/days when the coarse fields cannot match, so
    // sparse expressions (first of month) do not walk half a million minutes.
    if (!parsed.month.any && !parsed.month.values.has(clock.month)) {
      timestamp += 24 * 60 * MINUTE_MS;
      continue;
    }
    if (!matchesDay(parsed, clock)) {
      // Jump to the next day's first minute in this timezone.
      timestamp += (24 * 60 - (clock.hour * 60 + clock.minute)) * MINUTE_MS;
      continue;
    }
    if (!parsed.hour.any && !parsed.hour.values.has(clock.hour)) {
      timestamp += (60 - clock.minute) * MINUTE_MS;
      continue;
    }
    timestamp += MINUTE_MS;
  }
  return null;
}
