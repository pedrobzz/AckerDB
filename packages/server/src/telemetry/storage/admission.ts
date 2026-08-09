/**
 * Admission control, at the telemetry writer.
 *
 * **This layer, and not the HTTP one.** PocketBase puts its request logger
 * outside its rate limiter — priorities −1040 against −1000, sorted so the logger
 * runs outer — so a rate-limited request returns `TooManyRequestsError`, the
 * error reaches `logRequest`, and every blocked request still writes a full
 * error-level row. Their limiter protects the application and does nothing for
 * the log store. Ours has the same shape at the HTTP edge, so the gate belongs
 * where every durable signal has to pass regardless of which producer made it:
 * a crash loop, a retry storm, a misconfigured poller and a flood all arrive
 * here, and only here.
 *
 * **What it protects against is measured, not hypothetical.** Tail sampling
 * retains every error as a full exemplar, which is correct at a 1% error rate
 * and catastrophic at 100% — and a flood makes it 100%. At 2,099 bytes an
 * exemplar against 316 a log row, the store fills about seven times faster
 * exactly when the application is under attack.
 *
 * **So the specimens shed and the shape does not.** The aggregate is bounded by
 * CARDINALITY, so no amount of traffic makes it grow, and it holds the counts,
 * the error counts and the distributions. Exemplars, error occurrences and log
 * rows all scale with traffic, so those are what pressure takes — in that order,
 * cheapest evidence first. Error *counts* are unaffected, because they come from
 * the aggregate and never from the retained specimens.
 *
 * **One mechanism, not two.** The admitted share is the store's own pressure —
 * how close it is to its byte target or the free-space floor — so the budget
 * drives the limiter. journald does the same thing, multiplying its effective
 * rate by a factor derived from remaining free space, and emits one row saying
 * how many messages it dropped rather than N rows saying nothing.
 */
import { kindCounters, type TelemetryRecordKind } from "./worker/protocol.ts";

/**
 * Loki's discard-reason vocabulary. A counted drop should read the same here as
 * in `loki_discarded_bytes_total`, because an operator who knows one should not
 * have to learn the other.
 */
export type TelemetryShedReason =
  | "rate_limited"
  | "line_too_long"
  | "queue_full"
  | "read_only"
  | "sealed";

export const TELEMETRY_SHED_REASONS: readonly TelemetryShedReason[] = Object.freeze([
  "rate_limited",
  "line_too_long",
  "queue_full",
  "read_only",
  "sealed",
]);

/**
 * The pressure at which each signal starts shedding.
 *
 * The order is by evidence per byte. Exemplars go first: they are the largest
 * rows and the aggregate beside them already answers every question about
 * volume, latency and failure rate, so a shed exemplar costs one specimen and no
 * shape. Error occurrences go next — the group row survives, so the failure is
 * still indexed. Logs and analytics go last, because they are the application's
 * own words and nothing else records them. The aggregate never sheds at all.
 */
const SHED_FROM: Readonly<Record<TelemetryRecordKind, number>> = Object.freeze({
  aggregate: Number.POSITIVE_INFINITY,
  exemplar: 0.8,
  error: 0.9,
  log: 0.95,
  analytics: 0.95,
});

/**
 * The share of `kind` admitted at `pressure`: 1 until that signal's start, then
 * falling linearly to 0 as pressure reaches 1. Nothing is paid below the start,
 * so ordinary operation never meets the limiter.
 */
export function admittedShare(kind: TelemetryRecordKind, pressure: number): number {
  const from = SHED_FROM[kind];
  if (!Number.isFinite(pressure) || pressure <= from) return 1;
  if (pressure >= 1) return 0;
  return Math.max(0, (1 - pressure) / (1 - from));
}

export interface TelemetryShedSnapshot {
  readonly pressure: number;
  readonly readOnly: boolean;
  readonly shedRecords: number;
  readonly shedByReason: Readonly<Record<string, number>>;
  readonly shedByKind: Readonly<Record<string, number>>;
}

/**
 * Realizes the admitted share exactly, by carrying credit rather than rolling
 * dice. A random draw at these rates has variance an operator would read as the
 * limiter misbehaving; an accumulator admits precisely `share` of the stream and
 * is reproducible in a test.
 */
export class TelemetryAdmission {
  private readonly credit = kindCounters();
  private readonly byReason: Record<string, number> = {};
  private readonly byKind = kindCounters();
  private shedRecords = 0;
  private pressure = 0;
  private readOnly = false;

  /** The sidecar reports its own headroom; this is the only input. */
  observe(pressure: number, readOnly: boolean): void {
    this.pressure = pressure;
    this.readOnly = readOnly;
  }

  /**
   * Whether one record is admitted, and why not when it is not. The aggregate is
   * never rate-shed: it is bounded by cardinality, so shedding it would save
   * nothing while losing the only complete account of what happened.
   *
   * Below the free-space floor everything is refused, aggregate included. A floor
   * with exceptions is not a floor, and the volume it protects is the one the
   * application's own database is on.
   */
  admit(kind: TelemetryRecordKind): TelemetryShedReason | undefined {
    if (this.readOnly) return this.record("read_only", kind);
    const share = admittedShare(kind, this.pressure);
    if (share >= 1) return undefined;
    const credit = (this.credit[kind] ?? 0) + share;
    if (credit >= 1) {
      this.credit[kind] = credit - 1;
      return undefined;
    }
    this.credit[kind] = credit;
    return this.record("rate_limited", kind);
  }

  /** Count a drop this class did not decide — an oversized record, a full ring. */
  record(reason: TelemetryShedReason, kind: TelemetryRecordKind): TelemetryShedReason {
    this.shedRecords++;
    this.byReason[reason] = (this.byReason[reason] ?? 0) + 1;
    this.byKind[kind] = (this.byKind[kind] ?? 0) + 1;
    return reason;
  }

  snapshot(): TelemetryShedSnapshot {
    return Object.freeze({
      pressure: this.pressure,
      readOnly: this.readOnly,
      shedRecords: this.shedRecords,
      shedByReason: Object.freeze({ ...this.byReason }),
      shedByKind: Object.freeze({ ...this.byKind }),
    });
  }
}
