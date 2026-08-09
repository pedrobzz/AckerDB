/**
 * Administration configuration: one object holding everything an operator sets
 * about the surfaces AckerDB runs on its own behalf.
 *
 * It exists so there is exactly one place to look. Telemetry storage used to be
 * configured through an environment variable that no manifest mentioned, a
 * journal-limits object passed beside the Runtime's other telemetry fields, and
 * nothing at all for retention — three surfaces for one subject. `admin` is the
 * normative shape; `.ackerdb.config.json` mirrors it field for field and the
 * CLI passes it straight through.
 *
 * The object is declared as an interface with optional members, so the next
 * administrative surface to be configured adds a member without changing what
 * any existing caller wrote.
 */
import type { TelemetryAggregateLimits } from "../../telemetry/aggregation/buckets.ts";
import type { TelemetrySidecarQueueLimits } from "../../telemetry/storage/writer.ts";
import type { TelemetryStoreLimits } from "../../telemetry/storage/store.ts";

/**
 * Durable trace storage: retained traces stored as exemplars in the sidecar,
 * for Studio to read.
 *
 * **Presence is the switch.** Absent, no trace is ever stored and no exemplar is
 * ever built. There is deliberately no `enabled` boolean here — that would be a
 * second off switch overlapping `AdminTelemetryOptions.enabled`, and their
 * interaction is one more thing an operator has to hold in their head. The
 * relationship is containment and not overlap: `enabled: false` stops the
 * runtime recording anything at all, and this capability decides whether what is
 * recorded is also KEPT.
 *
 * **It is off by default because it is not free.** The aggregate is always on —
 * it is what `/status` and the runtime metrics are made of, and it is bounded by
 * cardinality rather than by traffic. Storing whole traces is a different cost,
 * it exists to serve Studio, and Studio is itself opt-in. An application that
 * ships without Studio must not pay for a trace store nobody will open, which is
 * the "zero cost when nobody is looking" constraint applied literally.
 *
 * Turning it on is not retroactive: traces are stored from that point forward.
 */
export interface AdminTelemetryTraceOptions {
  /**
   * Share of healthy traces kept so "show me a normal one" has an answer.
   * Errors and the tail are kept regardless; this is the remainder.
   */
  readonly baselineProbability?: number;
}

export interface AdminTelemetryOptions {
  /**
   * The one telemetry off switch. Disabled, the runtime records no spans,
   * events or metrics and attaches no durable span pipeline; application logs
   * and analytics keep their journal, because ADR-0017 makes those durable
   * regardless of whether anyone is watching operations.
   */
  readonly enabled?: boolean;
  /**
   * Durable trace storage, off unless present. See `AdminTelemetryTraceOptions`
   * for why this is a capability rather than a second boolean.
   */
  readonly traces?: AdminTelemetryTraceOptions;
  /**
   * Milliseconds each class of stored telemetry survives, by the class names
   * the store registers. Retention is retroactive: a change applies to data
   * already stored on the next maintenance pass.
   */
  readonly retention?: Readonly<Record<string, number>>;
  /** The sidecar's disk budget and maintenance bounds. */
  readonly storage?: Partial<TelemetryStoreLimits>;
  /**
   * In-memory bounds on the one queue every durable signal waits in: the ring
   * in front of the sidecar, its handoff size, and its commit batch.
   */
  readonly queue?: Partial<TelemetrySidecarQueueLimits>;
  /**
   * Bounds on the aggregate every observation reaches: series cardinality, open
   * minute buckets, and the sketch's declared relative accuracy.
   */
  readonly aggregate?: Partial<TelemetryAggregateLimits>;
}

export interface AdminOptions {
  readonly telemetry?: AdminTelemetryOptions;
}
