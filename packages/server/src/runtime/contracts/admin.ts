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
import type { TelemetryJournalLimits } from "../../telemetry/application-signals/journal.ts";
import type { TelemetrySpanStoreLimits } from "../../telemetry/storage/spans.ts";
import type { TelemetryStoreLimits } from "../../telemetry/storage/store.ts";

export interface AdminTelemetryOptions {
  /**
   * The one telemetry off switch. Disabled, the runtime records no spans,
   * events or metrics and attaches no durable span pipeline; application logs
   * and analytics keep their journal, because ADR-0017 makes those durable
   * regardless of whether anyone is watching operations.
   */
  readonly enabled?: boolean;
  /**
   * Milliseconds each class of stored telemetry survives, by the class names
   * the store registers. Retention is retroactive: a change applies to data
   * already stored on the next maintenance pass.
   */
  readonly retention?: Readonly<Record<string, number>>;
  /** The sidecar's disk budget and maintenance bounds. */
  readonly storage?: Partial<TelemetryStoreLimits>;
  /** In-memory bounds on the log and analytics journal's own queue. */
  readonly journal?: Partial<TelemetryJournalLimits>;
  /** In-memory bounds on the durable span pipeline's own queue. */
  readonly spans?: Partial<TelemetrySpanStoreLimits>;
}

export interface AdminOptions {
  readonly telemetry?: AdminTelemetryOptions;
}
