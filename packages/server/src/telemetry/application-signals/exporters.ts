/**
 * The export pump: durable journal rows delivered to application-supplied
 * exporters, at least once, with the cursor in the file.
 *
 * The exporters run HERE, on the serving thread, because a
 * `TelemetrySignalExporter` is a closure the application wrote and a closure
 * does not cross a thread. The journal they read runs on the thread that owns
 * the sidecar's connection. So the two halves are split at the only seam that
 * survives both facts: batches travel up over the sidecar channel, the closure
 * runs here, and the advance travels back down. Nothing about durability moves —
 * a cursor is only ever written by the thread that owns the file it describes.
 *
 * The delivery contract is unchanged by the split, and it is at-least-once: the
 * advance follows the export. A process that dies between them re-delivers that
 * batch, which is the failure worth having; advancing first would lose it.
 */
import type {
  TelemetryConsumerAdvance,
  TelemetryConsumerSnapshot,
} from "./journal.ts";
import type { TelemetryExportPort } from "../storage/writer.ts";
import type {
  TelemetryJournalEntry,
  TelemetryJournalRecord,
} from "./types.ts";

export type TelemetrySignalKind = TelemetryJournalRecord["kind"];

export interface TelemetrySignalExportContext {
  readonly signal: AbortSignal;
}

export interface TelemetrySignalExporter {
  readonly name: string;
  readonly signals: readonly TelemetrySignalKind[];
  readonly requiresAnalyticsIdentity?: boolean;
  export(
    records: readonly TelemetryJournalEntry[],
    context: Readonly<TelemetrySignalExportContext>,
  ): void | PromiseLike<void>;
}

export interface TelemetryJournalExporterLimits {
  readonly batchRecords: number;
  readonly timeoutMs: number;
  readonly retryMinMs: number;
  readonly retryMaxMs: number;
}

export interface TelemetryJournalExportersOptions {
  /** The sidecar's consumer side; every cursor operation is a round trip. */
  readonly port: TelemetryExportPort;
  readonly exporters: readonly TelemetrySignalExporter[];
  readonly limits?: Partial<TelemetryJournalExporterLimits>;
  readonly warn?: (message: string) => void;
}

export interface TelemetryExporterSnapshot extends TelemetryConsumerSnapshot {
  readonly inFlight: boolean;
  readonly retryInMs: number;
}

export type TelemetryExportersSnapshot = Readonly<Record<string, TelemetryExporterSnapshot>>;

const DEFAULT_LIMITS: TelemetryJournalExporterLimits = Object.freeze({
  batchRecords: 100,
  timeoutMs: 5_000,
  retryMinMs: 1_000,
  retryMaxMs: 60_000,
});

interface Worker {
  readonly exporter: TelemetrySignalExporter;
  readonly signals: ReadonlySet<TelemetrySignalKind>;
  consumer: TelemetryConsumerSnapshot;
  scheduled: boolean;
  stopped: boolean;
  inFlight: boolean;
  attempt?: Promise<void>;
  controller?: AbortController;
  retryTimer?: ReturnType<typeof setTimeout>;
  retryDelayMs: number;
  retryAtMs: number;
}

const EMPTY_CONSUMER: TelemetryConsumerSnapshot = Object.freeze({
  cursor: 0n,
  exportedRecords: 0,
  skippedUnsupported: 0,
  skippedIdentity: 0,
  evictedRecords: 0,
  failures: 0,
  timedOut: 0,
});

type ExportOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "timeout" };

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function exporterLimits(
  limits: Partial<TelemetryJournalExporterLimits> | undefined,
): TelemetryJournalExporterLimits {
  const resolved = Object.freeze({
    batchRecords: positiveInteger(
      limits?.batchRecords ?? DEFAULT_LIMITS.batchRecords,
      "telemetry exporter batchRecords",
    ),
    timeoutMs: positiveInteger(
      limits?.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
      "telemetry exporter timeoutMs",
    ),
    retryMinMs: positiveInteger(
      limits?.retryMinMs ?? DEFAULT_LIMITS.retryMinMs,
      "telemetry exporter retryMinMs",
    ),
    retryMaxMs: positiveInteger(
      limits?.retryMaxMs ?? DEFAULT_LIMITS.retryMaxMs,
      "telemetry exporter retryMaxMs",
    ),
  });
  if (resolved.retryMinMs > resolved.retryMaxMs) {
    throw new RangeError("telemetry exporter retryMinMs cannot exceed retryMaxMs");
  }
  return resolved;
}

export function validateTelemetryJournalExportersOptions(
  options: Omit<TelemetryJournalExportersOptions, "port">,
): void {
  exporterLimits(options.limits);
  const names = new Set<string>();
  for (const exporter of options.exporters) {
    if (exporter.name.length === 0 || exporter.name.length > 128) {
      throw new TypeError("telemetry exporter name must contain 1 to 128 characters");
    }
    if (names.has(exporter.name)) {
      throw new TypeError(`duplicate telemetry exporter name "${exporter.name}"`);
    }
    names.add(exporter.name);
    if (exporter.signals.length === 0) {
      throw new TypeError(`telemetry exporter "${exporter.name}" must support at least one signal`);
    }
    const signals = new Set(exporter.signals);
    if ([...signals].some((signal) => signal !== "log" && signal !== "analytics")) {
      throw new TypeError(`telemetry exporter "${exporter.name}" declares an unknown signal`);
    }
  }
}

export class TelemetryJournalExporters {
  readonly limits: TelemetryJournalExporterLimits;
  private readonly port: TelemetryExportPort;
  private readonly workers: readonly Worker[];
  private readonly warn: (message: string) => void;
  private readonly releasePort: () => void;
  private stopped = false;

  constructor(options: TelemetryJournalExportersOptions) {
    this.port = options.port;
    this.warn = options.warn ?? ((message) => console.warn(message));
    validateTelemetryJournalExportersOptions(options);
    this.limits = exporterLimits(options.limits);
    this.workers = Object.freeze(options.exporters.map((exporter): Worker => ({
      exporter,
      signals: new Set(exporter.signals),
      // Seeded empty rather than read: the durable cursor lives in the sidecar
      // and the first batch brings it back. A synchronous read here is exactly
      // what a constructor cannot do once the journal is on another thread.
      consumer: EMPTY_CONSUMER,
      scheduled: false,
      stopped: false,
      inFlight: false,
      retryDelayMs: this.limits.retryMinMs,
      retryAtMs: 0,
    })));
    this.releasePort = this.port.onPersist(() => this.scheduleAll());
    this.scheduleAll();
  }

  async flush(): Promise<void> {
    if (this.stopped) return;
    await Promise.all(this.workers.map((worker) => this.flushWorker(worker)));
  }

  snapshot(): TelemetryExportersSnapshot {
    const snapshot: Record<string, TelemetryExporterSnapshot> = {};
    const now = Date.now();
    for (const worker of this.workers) {
      snapshot[worker.exporter.name] = Object.freeze({
        ...worker.consumer,
        inFlight: worker.inFlight,
        retryInMs: Math.max(0, worker.retryAtMs - now),
      });
    }
    return Object.freeze(snapshot);
  }

  async drain(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.releasePort();
    for (const worker of this.workers) {
      worker.stopped = true;
      if (worker.retryTimer !== undefined) clearTimeout(worker.retryTimer);
      worker.retryTimer = undefined;
      worker.retryAtMs = 0;
      worker.controller?.abort(new Error("telemetry exporter runtime is draining"));
    }
  }

  private scheduleAll(): void {
    if (this.stopped) return;
    for (const worker of this.workers) this.schedule(worker);
  }

  private schedule(worker: Worker): void {
    if (
      this.stopped || worker.stopped || worker.scheduled || worker.inFlight ||
      worker.retryTimer !== undefined
    ) return;
    worker.scheduled = true;
    queueMicrotask(() => {
      worker.scheduled = false;
      void this.startWorker(worker).catch((error) => this.containWorkerFailure(worker, error));
    });
  }

  /**
   * Deliver everything readable AS OF THIS CALL, which is more than joining an
   * attempt that happens to be running.
   *
   * Reading a batch is a round trip to the thread that owns the journal, so an
   * attempt started a moment ago may already have read — and found nothing —
   * before the records this caller is flushing for were accepted. Awaiting that
   * attempt alone resolves with a clean answer about a read that never saw them,
   * which for a drain is silently unexported data. So a flush joins whatever is
   * in flight and then reads again.
   */
  private flushWorker(worker: Worker): Promise<void> {
    if (this.stopped || worker.stopped) return Promise.resolve();
    const inFlight = worker.attempt;
    return inFlight === undefined
      ? this.startWorker(worker)
      : inFlight.then(() => this.startWorker(worker));
  }

  /** One attempt at a time per consumer; a second caller joins the first. */
  private startWorker(worker: Worker): Promise<void> {
    if (this.stopped || worker.stopped || worker.inFlight) return Promise.resolve();
    if (worker.attempt !== undefined) return worker.attempt;
    const attempt = this.runWorker(worker).finally(() => {
      if (worker.attempt === attempt) worker.attempt = undefined;
    });
    worker.attempt = attempt;
    return attempt;
  }

  private async runWorker(worker: Worker): Promise<void> {
    while (!this.stopped && !worker.stopped && !worker.inFlight) {
      const batch = await this.port.batch(worker.exporter.name, this.limits.batchRecords);
      if (this.stopped || worker.stopped) return;
      worker.consumer = batch.consumer;
      if (batch.records.length === 0) return;
      const advance: {
        exportedRecords: number;
        skippedUnsupported: number;
        skippedIdentity: number;
      } = {
        exportedRecords: 0,
        skippedUnsupported: 0,
        skippedIdentity: 0,
      };
      const delivered: TelemetryJournalEntry[] = [];
      for (const record of batch.records) {
        if (!worker.signals.has(record.kind)) {
          advance.skippedUnsupported++;
        } else if (
          record.kind === "analytics" &&
          worker.exporter.requiresAnalyticsIdentity === true &&
          record.identity === undefined
        ) {
          advance.skippedIdentity++;
        } else {
          delivered.push(record);
        }
      }
      advance.exportedRecords = delivered.length;
      const cursor = batch.records.at(-1)!.id;
      if (delivered.length === 0) {
        worker.consumer = await this.port.advance(worker.exporter.name, cursor, advance);
        await new Promise<void>((resolve) => setImmediate(resolve));
        continue;
      }
      const outcome = await this.exportBatch(worker, delivered, cursor, advance);
      if (outcome !== "continue") return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private async exportBatch(
    worker: Worker,
    records: readonly TelemetryJournalEntry[],
    cursor: bigint,
    advance: Required<TelemetryConsumerAdvance>,
  ): Promise<"continue" | "stop"> {
    const controller = new AbortController();
    worker.controller = controller;
    worker.inFlight = true;
    const settled: Promise<ExportOutcome> = Promise.resolve()
      .then(() => worker.exporter.export(records, Object.freeze({ signal: controller.signal })))
      .then(
        (): ExportOutcome => ({ kind: "ok" }),
        (error): ExportOutcome => ({ kind: "failed", error }),
      );
    let timeout!: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<ExportOutcome>((resolve) => {
      timeout = setTimeout(() => resolve({ kind: "timeout" }), this.limits.timeoutMs);
      timeout.unref?.();
    });
    const settle = (): void => {
      clearTimeout(timeout);
      worker.inFlight = false;
      worker.controller = undefined;
    };
    const outcome = await Promise.race([settled, timedOut]);
    if (this.stopped || worker.stopped) {
      settle();
      return "stop";
    }
    if (outcome.kind === "timeout") {
      controller.abort(new Error(`telemetry exporter "${worker.exporter.name}" timed out`));
      worker.consumer = await this.port.failure(worker.exporter.name, true);
      this.warnFailure(worker, "timed out");
      void settled.then(async (late) => {
        settle();
        if (this.stopped || worker.stopped) return;
        if (late.kind === "ok") {
          worker.consumer = await this.port.advance(worker.exporter.name, cursor, advance);
          this.resetRetry(worker);
          this.schedule(worker);
        } else {
          this.scheduleRetry(worker);
        }
      }).catch((error) => this.containWorkerFailure(worker, error));
      return "stop";
    }
    settle();
    if (outcome.kind === "failed") {
      worker.consumer = await this.port.failure(worker.exporter.name, false);
      this.warnFailure(
        worker,
        `failed (${outcome.error instanceof Error ? outcome.error.name : "UnknownError"})`,
      );
      this.scheduleRetry(worker);
      return "stop";
    }
    worker.consumer = await this.port.advance(worker.exporter.name, cursor, advance);
    this.resetRetry(worker);
    return "continue";
  }

  private warnFailure(worker: Worker, outcome: string): void {
    try {
      this.warn(`[ackerdb] telemetry exporter "${worker.exporter.name}" ${outcome}`);
    } catch {
      // Console/host warning sinks cannot own exporter health.
    }
  }

  private containWorkerFailure(worker: Worker, error: unknown): void {
    worker.stopped = true;
    worker.inFlight = false;
    worker.controller = undefined;
    if (worker.retryTimer !== undefined) clearTimeout(worker.retryTimer);
    worker.retryTimer = undefined;
    worker.retryAtMs = 0;
    this.warnFailure(
      worker,
      `stopped after local journal failure (${error instanceof Error ? error.name : "UnknownError"})`,
    );
  }

  private scheduleRetry(worker: Worker): void {
    if (this.stopped || worker.stopped || worker.retryTimer !== undefined) return;
    const delay = worker.retryDelayMs;
    worker.retryAtMs = Date.now() + delay;
    worker.retryTimer = setTimeout(() => {
      worker.retryTimer = undefined;
      worker.retryAtMs = 0;
      this.schedule(worker);
    }, delay);
    worker.retryTimer.unref?.();
    worker.retryDelayMs = Math.min(this.limits.retryMaxMs, delay * 2);
  }

  private resetRetry(worker: Worker): void {
    if (worker.retryTimer !== undefined) clearTimeout(worker.retryTimer);
    worker.retryTimer = undefined;
    worker.retryAtMs = 0;
    worker.retryDelayMs = this.limits.retryMinMs;
  }
}
