const DAY_MS = 86_400_000;

/**
 * The retention clocks observable data expires on. Error groups are
 * deliberately not a class: they are the index of every error the
 * application has ever seen and never expire.
 */
export const TELEMETRY_RETENTION_CLASSES = Object.freeze([
  "debug",
  "info",
  "warn",
  "error",
  "spans",
  "analytics",
  "rollups",
] as const);

export type TelemetryRetentionClass = (typeof TELEMETRY_RETENTION_CLASSES)[number];

/** Milliseconds each class of stored telemetry stays before write-path expiry. */
export type TelemetryRetentionTtls = Readonly<Record<TelemetryRetentionClass, number>>;

export const DEFAULT_TELEMETRY_RETENTION: TelemetryRetentionTtls = Object.freeze({
  debug: 3 * DAY_MS,
  info: 14 * DAY_MS,
  warn: 14 * DAY_MS,
  error: 30 * DAY_MS,
  spans: 7 * DAY_MS,
  analytics: 90 * DAY_MS,
  rollups: 365 * DAY_MS,
});

/**
 * Retention is retroactive: rows never stamp a clock at write, so the
 * resolved configuration is the one every maintenance pass deletes by,
 * including for rows stored under an older configuration.
 */
export function resolveTelemetryRetention(
  overrides?: Partial<TelemetryRetentionTtls>,
): TelemetryRetentionTtls {
  const resolved: Record<TelemetryRetentionClass, number> = {
    ...DEFAULT_TELEMETRY_RETENTION,
  };
  for (const retentionClass of TELEMETRY_RETENTION_CLASSES) {
    const override = overrides?.[retentionClass];
    if (override !== undefined) resolved[retentionClass] = override;
    if (!Number.isSafeInteger(resolved[retentionClass]) || resolved[retentionClass] <= 0) {
      throw new RangeError(
        `telemetry retention ${retentionClass} must be a positive integer of milliseconds`,
      );
    }
  }
  return Object.freeze(resolved);
}
