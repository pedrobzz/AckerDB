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
  info: 14 * DAY_MS,
  warn: 14 * DAY_MS,
  error: 30 * DAY_MS,
  /** Retained trace exemplars — a tail-sampled minority, not every trace. */
  traces: 7 * DAY_MS,
  analytics: 90 * DAY_MS,
  /** Minute-resolution aggregate buckets: what a 15-minute window reads. */
  minutes: 7 * DAY_MS,
  /** Hourly merged aggregate buckets and the analytics day rollup. */
  rollups: 365 * DAY_MS,
});

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
