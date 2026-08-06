/**
 * The one synthetic dependency key Studio's reactive `_studio.*` queries
 * subscribe to. Every durable telemetry flush pokes it. The `telemetry:`
 * prefix lives outside the table read/write-key grammar
 * (`id:`/`scan:`/`ix:`/`fts:`), so it can never collide with a real
 * application dependency key.
 */
export const TELEMETRY_JOURNAL_DEPENDENCY_KEY = "telemetry:journal";

export type TelemetryInvalidationListener = (writeKeys: ReadonlySet<string>) => void;

export interface TelemetryFlushInvalidationOptions {
  /** Minimum milliseconds between pokes; flushes inside the window coalesce. */
  readonly intervalMs?: number;
  readonly now?: () => number;
}

const DEFAULT_INTERVAL_MS = 250;
const POKED_KEYS: ReadonlySet<string> = Object.freeze(
  new Set([TELEMETRY_JOURNAL_DEPENDENCY_KEY]),
);

/**
 * Batches durable-flush notifications into at most one synthetic-dependency
 * poke per interval. The first flush after a quiet period pokes immediately;
 * flushes inside the window coalesce into a single trailing poke, so a busy
 * journal invalidates subscribers at the flush cadence instead of per batch.
 * With no subscribers it schedules nothing — zero idle cost.
 */
export class TelemetryFlushInvalidation {
  readonly intervalMs: number;
  private readonly now: () => number;
  private readonly listeners = new Set<TelemetryInvalidationListener>();
  private lastPokeAtMs = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: TelemetryFlushInvalidationOptions = {}) {
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new RangeError("telemetry invalidation intervalMs must be a positive integer");
    }
    this.intervalMs = intervalMs;
    this.now = options.now ?? Date.now;
  }

  subscribe(listener: TelemetryInvalidationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  /** Called after each durable flush; coalesced delivery to every subscriber. */
  notify(): void {
    if (this.listeners.size === 0 || this.timer !== undefined) return;
    const elapsed = this.now() - this.lastPokeAtMs;
    if (elapsed >= this.intervalMs) {
      this.poke();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.poke();
    }, this.intervalMs - elapsed);
    this.timer.unref?.();
  }

  /** Drops any pending trailing poke; safe to call repeatedly. */
  stop(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private poke(): void {
    this.lastPokeAtMs = this.now();
    for (const listener of this.listeners) {
      try {
        listener(POKED_KEYS);
      } catch {
        // A subscriber cannot poison the flush path or its peers.
      }
    }
  }
}
