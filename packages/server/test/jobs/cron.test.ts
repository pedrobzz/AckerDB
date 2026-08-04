/** The in-repo cron engine: field parsing and timezone-anchored next-occurrence math. */
import { describe, expect, test } from "bun:test";
import { cronNext, parseCronExpression, validateCronExpression } from "../../src/jobs/cron.ts";

const utc = (iso: string): number => Date.parse(iso);

describe("cron parsing", () => {
  test("accepts the five-field syntax with lists, ranges, and steps", () => {
    expect(() => validateCronExpression("*/5 0-6 1,15 * 1-5")).not.toThrow();
    expect(() => validateCronExpression("0 12 * * 7")).not.toThrow(); // 7 → Sunday
  });

  test("rejects malformed expressions with the field named", () => {
    expect(() => validateCronExpression("* * * *")).toThrow("exactly 5 fields");
    expect(() => validateCronExpression("60 * * * *")).toThrow("minute");
    expect(() => validateCronExpression("* 24 * * *")).toThrow("hour");
    expect(() => validateCronExpression("* * 0 * *")).toThrow("day-of-month");
    expect(() => validateCronExpression("* * * 13 *")).toThrow("month");
    expect(() => validateCronExpression("* * * * a")).toThrow("day-of-week");
    expect(() => validateCronExpression("*/0 * * * *")).toThrow("step");
    expect(() => validateCronExpression("5-1 * * * *")).toThrow("minute");
  });

  test("normalizes Sunday-as-7 into Sunday-as-0", () => {
    expect(parseCronExpression("0 0 * * 7").dayOfWeek.values.has(0)).toBe(true);
  });
});

describe("cron next occurrence", () => {
  test("daily noon is calendar-anchored in the declared timezone", () => {
    // 2026-01-15 10:00 UTC = 07:00 in São Paulo (UTC-3, no DST since 2019).
    const from = utc("2026-01-15T10:00:00Z");
    const next = cronNext("0 12 * * *", "America/Sao_Paulo", from);
    expect(next).toBe(utc("2026-01-15T15:00:00Z")); // noon São Paulo
    // Asking from one minute later lands on the next day, no drift.
    const after = cronNext("0 12 * * *", "America/Sao_Paulo", next!);
    expect(after).toBe(utc("2026-01-16T15:00:00Z"));
  });

  test("first of the month at midnight crosses month lengths correctly", () => {
    const from = utc("2026-02-02T00:00:00Z");
    const next = cronNext("0 0 1 * *", "UTC", from);
    expect(next).toBe(utc("2026-03-01T00:00:00Z"));
    expect(cronNext("0 0 1 * *", "UTC", next!)).toBe(utc("2026-04-01T00:00:00Z"));
  });

  test("a wall-clock time skipped by DST does not fire that day", () => {
    // America/New_York springs forward on 2026-03-08: 02:30 does not exist.
    const from = utc("2026-03-08T00:00:00Z");
    const next = cronNext("30 2 * * *", "America/New_York", from);
    // 2026-03-09 02:30 EDT = 06:30 UTC.
    expect(next).toBe(utc("2026-03-09T06:30:00Z"));
  });

  test("restricted day-of-month OR day-of-week matches either (Vixie rule)", () => {
    // Friday the 13th of Feb 2026; the 1st is also a Sunday.
    const from = utc("2026-02-02T00:00:00Z");
    // dom=13 OR dow=Sunday: next match is Sunday Feb 8.
    expect(cronNext("0 0 13 * 0", "UTC", from)).toBe(utc("2026-02-08T00:00:00Z"));
  });

  test("an impossible date returns null instead of searching forever", () => {
    expect(cronNext("0 0 31 2 *", "UTC", utc("2026-01-01T00:00:00Z"))).toBeNull();
  });

  test("sparse expressions resolve without walking every minute", () => {
    const started = performance.now();
    const next = cronNext("0 0 29 2 *", "UTC", utc("2025-03-01T00:00:00Z"));
    expect(next).toBe(utc("2028-02-29T00:00:00Z")); // next leap-year Feb 29
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
