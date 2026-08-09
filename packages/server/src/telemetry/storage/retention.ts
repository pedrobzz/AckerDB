/**
 * The clocks observable data expires on.
 *
 * **Retention is retroactive.** A row never stamps a deadline at write; a
 * maintenance pass deletes by the cutoff the *current* configuration implies.
 * Changing a clock therefore applies to data already stored, which is what an
 * operator means by editing it. The columnar platforms stamp retention at
 * write because rewriting a TTL there costs a file rewrite; SQLite has no such
 * cost, so the simpler model is also the cheaper one here.
 *
 * **The class list is a registry, not a union to widen.** Every clock is one
 * key of `DEFAULT_TELEMETRY_RETENTION` and the type derives from it, so a later
 * ticket adds a clock by adding one entry: no union edit, no stored-schema
 * change, no configuration break. A kind naming a clock the registry does not
 * carry is refused at registration rather than silently never expiring.
 *
 * **Time is the control; bytes are the guard; whichever fires first.** Sixteen
 * products were surveyed and nobody partitions bytes per signal: outside four
 * single-node stores nobody has a byte budget at all, and the closest structural
 * analog — Netdata — runs bytes and time together, deleting on whichever fires
 * first, and documents the byte limit as a soft target rather than a hard cap.
 * Netdata also shipped size-only first and had operators demand time back
 * (netdata#13424), because bytes alone make retention unpredictable exactly when
 * volume varies. What stops one signal eating another is a limit at ingest, not
 * a partition in storage — Loki, Datadog and Sentry all place it there.
 *
 * Defaults are generous on purpose. At the 316 bytes a log row measures, seven
 * days at a hundred operations a second is about nineteen gigabytes; a one-gibibyte
 * budget would promise a week and deliver hours. Disk is the cheap resource here.
 *
 * Error groups deliberately have no clock. They are the index of every failure
 * the application has ever seen, and an index that forgets is not one.
 *
 * The aggregate is kept at two resolutions on purpose. Minute buckets answer the
 * short windows an operator actually stares at during an incident; hourly
 * buckets, merged from them, answer the long horizons at a fraction of the rows.
 * A clock shorter than the bucket it governs would expire the bucket a
 * measurement just landed in, so `minutes` and `rollups` are both far longer
 * than their bucket widths.
 */

/** One day of milliseconds — the bucket every daily accounting shares. */
export const DAY_MS = 86_400_000;

/**
 * The registry. Adding a clock is adding a line here; `TelemetryRetentionClass`
 * and every validation below follow from it.
 */
export const DEFAULT_TELEMETRY_RETENTION = Object.freeze({
  debug: 3 * DAY_MS,
  info: 7 * DAY_MS,
  warn: 7 * DAY_MS,
  error: 30 * DAY_MS,
  /** Retained trace exemplars — a tail-sampled minority, not every trace. */
  traces: 7 * DAY_MS,
  analytics: 365 * DAY_MS,
  /** Minute-resolution aggregate buckets: what a 15-minute window reads. */
  minutes: 7 * DAY_MS,
  /** Hourly merged aggregate buckets and the analytics day rollup. */
  rollups: 730 * DAY_MS,
});

/**
 * The most recent window eviction may never take, whatever the byte guard says.
 *
 * A store that is over its ceiling and keeps deleting until it is under can
 * delete the hour an operator is currently looking at — and the incident that
 * blew the budget is exactly when that hour matters. VictoriaLogs keeps the last
 * two days regardless of its retention size; this is the same floor. Over budget
 * with the floor holding, the store grows and says so rather than erasing the
 * evidence.
 */
export const DEFAULT_MIN_RETAINED_MS = 2 * DAY_MS;

export type TelemetryRetentionClass = keyof typeof DEFAULT_TELEMETRY_RETENTION;

/** Milliseconds each class of stored telemetry stays before write-path expiry. */
export type TelemetryRetentionTtls = Readonly<Record<TelemetryRetentionClass, number>>;

export const TELEMETRY_RETENTION_CLASSES: readonly TelemetryRetentionClass[] = Object.freeze(
  Object.keys(DEFAULT_TELEMETRY_RETENTION) as TelemetryRetentionClass[],
);

export function isTelemetryRetentionClass(value: unknown): value is TelemetryRetentionClass {
  return typeof value === "string" && Object.hasOwn(DEFAULT_TELEMETRY_RETENTION, value);
}

export function resolveTelemetryRetention(
  overrides?: Readonly<Record<string, number>>,
): TelemetryRetentionTtls {
  const resolved: Record<string, number> = { ...DEFAULT_TELEMETRY_RETENTION };
  for (const [name, override] of Object.entries(overrides ?? {})) {
    if (!isTelemetryRetentionClass(name)) {
      throw new TypeError(
        `unknown telemetry retention class ${JSON.stringify(name)} — expected one of ${
          TELEMETRY_RETENTION_CLASSES.join(", ")
        }`,
      );
    }
    resolved[name] = override;
  }
  for (const name of TELEMETRY_RETENTION_CLASSES) {
    const ttl = resolved[name]!;
    if (!Number.isSafeInteger(ttl) || ttl <= 0) {
      throw new RangeError(
        `telemetry retention ${name} must be a positive integer of milliseconds`,
      );
    }
  }
  return Object.freeze(resolved) as TelemetryRetentionTtls;
}
