/**
 * The thread that owns the telemetry sidecar's SQLite connection.
 *
 * The connection is created HERE. A native binding handle cannot be transferred,
 * and that constraint is load bearing rather than incidental: exactly one thread
 * writes the file, so the serving thread never executes a synchronous commit.
 *
 * **Why a thread at all, given the model now samples.** Sampling shrinks the
 * healthy mean, not the incident. The retained fraction is
 * `errors + slow + baseline`, so a healthy application at 1% errors and 5% slow
 * already retains about 7% — and during an incident it approaches 100%, which is
 * precisely when the application can least afford the serving thread to block on
 * a commit. Logs and analytics never sample at all, and an error storm adds a
 * group upsert and an occurrence insert per failure. The thread is incident
 * isolation, not an optimisation for the good case.
 *
 * Every signal crosses here. Leaving any of them on the serving thread would put
 * two writers on one file and split the accounting that makes the disk budget
 * mean anything.
 */
import { TelemetryStore } from "../store.ts";
import { TelemetryJournal } from "../../application-signals/journal.ts";
import { TelemetryErrorStore } from "../../errors/store.ts";
import { TelemetryExemplarStore } from "../exemplars.ts";
import { TelemetryAggregateStore } from "../aggregate.ts";
import type { TelemetryJournalRecord } from "../../application-signals/types.ts";
import type { TraceExemplar } from "../../exemplars/collector.ts";
import type { AggregateSeriesRow } from "../../aggregation/buckets.ts";
import {
  decodeRecordValue,
  FIELD_SEPARATOR,
  RECORD_SEPARATOR,
  type TelemetryRecordKind,
  type TelemetryWorkerCommand,
  type TelemetryWorkerEvent,
  type TelemetryWorkerStats,
} from "./protocol.ts";

interface Pending {
  readonly kind: TelemetryRecordKind;
  readonly value: unknown;
  readonly bytes: number;
  readonly acceptedAtMs: number;
}

interface AggregateHandoffPayload {
  readonly startMs: number;
  readonly closed: boolean;
  readonly rows: readonly AggregateSeriesRow[];
}

let store: TelemetryStore | undefined;
let journal: TelemetryJournal | undefined;
let errors: TelemetryErrorStore | undefined;
let exemplars: TelemetryExemplarStore | undefined;
let aggregate: TelemetryAggregateStore | undefined;
let commitBatch = 512;
let commitDelayMs = 25;
let commitTimer: ReturnType<typeof setTimeout> | undefined;

const pending: Pending[] = [];
let pendingBytes = 0;
let durableSeq = 0;
let acceptedSeq = 0;
let committedRecords = 0;
let committedTransactions = 0;
let rejectedRecords = 0;
let failed = false;

function post(message: TelemetryWorkerEvent): void {
  (self as unknown as { postMessage(value: unknown): void }).postMessage(message);
}

function stats(): TelemetryWorkerStats {
  const snapshot = store?.snapshot();
  return {
    durableSeq,
    pendingRecords: pending.length,
    pendingBytes,
    oldestPendingAgeMs: pending.length === 0
      ? 0
      : Math.max(0, Date.now() - pending[0]!.acceptedAtMs),
    committedRecords,
    committedTransactions,
    rejectedRecords,
    storedBytes: snapshot?.storedBytes ?? 0,
    walBytes: snapshot?.walBytes ?? 0,
    containedFailures: snapshot?.containedFailures ?? 0,
    failed: failed || snapshot?.state === "failed",
  };
}

/**
 * One transaction over everything parsed so far. The commit boundary belongs to
 * this thread alone, so it can be as large as the batch target rather than as
 * small as one operation — which is where the cost of a durable write actually
 * lives: 182 µs/row at one row per transaction against 5.15 µs/row at 512.
 */
function commit(): void {
  if (commitTimer !== undefined) {
    clearTimeout(commitTimer);
    commitTimer = undefined;
  }
  if (pending.length === 0 || store === undefined) return;
  const batch = pending.splice(0, pending.length);
  pendingBytes = 0;
  const highest = acceptedSeq;
  try {
    store.database.transaction(() => {
      for (const item of batch) {
        switch (item.kind) {
          case "log":
          case "analytics":
            journal!.appendDirect(item.value as TelemetryJournalRecord);
            break;
          case "error": {
            // A live Error does not survive JSON, so the serving thread sends
            // its sanitized shape and the fingerprinter is handed an Error
            // again — it groups on name and in-app frames, both of which are
            // here.
            const raw = item.value as {
              readonly error: {
                readonly name: string;
                readonly message: string;
                readonly stack?: string;
              };
              readonly timestampMs: number;
              readonly functionAddress?: string;
              readonly traceId?: string;
            };
            const rebuilt = new Error(raw.error.message);
            rebuilt.name = raw.error.name;
            if (raw.error.stack !== undefined) rebuilt.stack = raw.error.stack;
            errors!.ingestDirect({
              error: rebuilt,
              timestampMs: raw.timestampMs,
              ...(raw.functionAddress === undefined
                ? {}
                : { functionAddress: raw.functionAddress }),
              ...(raw.traceId === undefined ? {} : { traceId: raw.traceId }),
            });
            break;
          }
          case "exemplar":
            exemplars!.writeDirect(item.value as TraceExemplar);
            break;
          case "aggregate": {
            const handoff = item.value as AggregateHandoffPayload;
            aggregate!.writeDirect(handoff.startMs, handoff.closed, handoff.rows);
            break;
          }
        }
      }
      store!.maintain();
    })();
    committedRecords += batch.length;
    committedTransactions++;
    durableSeq = highest;
  } catch (error) {
    // One transaction's loss is accounted; whether the connection itself is
    // gone is the store's probe to answer, exactly as on the serving thread.
    rejectedRecords += batch.length;
    if (store !== undefined && !store.observeFailure(error)) failed = true;
    // The sequence still advances: these records will never become durable, and
    // a watermark that never moves would wedge every future drain.
    durableSeq = highest;
  }
}

function parse(payload: string): void {
  if (payload.length === 0) return;
  const now = Date.now();
  for (const line of payload.split(RECORD_SEPARATOR)) {
    if (line.length === 0) continue;
    const split = line.indexOf(FIELD_SEPARATOR);
    if (split < 0) continue;
    const kind = line.slice(0, split) as TelemetryRecordKind;
    const json = line.slice(split + 1);
    try {
      pending.push({
        kind,
        value: JSON.parse(json, decodeRecordValue),
        bytes: json.length,
        acceptedAtMs: now,
      });
      pendingBytes += json.length;
    } catch {
      rejectedRecords++;
    }
  }
}

self.onmessage = (event: MessageEvent<TelemetryWorkerCommand>): void => {
  const command = event.data;
  try {
    switch (command.type) {
      case "open": {
        commitBatch = command.commitBatch;
        commitDelayMs = command.commitDelayMs;
        store = new TelemetryStore({
          path: command.path,
          ...(command.retention === undefined ? {} : { retention: command.retention }),
          ...(command.maxStoredBytes === undefined
            ? {}
            : { limits: { maxStoredBytes: command.maxStoredBytes } }),
        });
        journal = new TelemetryJournal({ store });
        errors = new TelemetryErrorStore({ store });
        exemplars = new TelemetryExemplarStore(store);
        aggregate = new TelemetryAggregateStore(store, command.generation);
        post({ type: "ready" });
        return;
      }
      case "records": {
        acceptedSeq = command.through;
        parse(command.payload);
        while (pending.length >= commitBatch) commit();
        // Count OR time: a below-threshold remainder must not wait for traffic
        // that may never come, or a quiet process's durability lag is unbounded.
        if (pending.length > 0 && commitTimer === undefined) {
          commitTimer = setTimeout(() => {
            commitTimer = undefined;
            commit();
            post({ type: "watermark", stats: stats() });
          }, commitDelayMs);
        }
        post({ type: "watermark", stats: stats() });
        return;
      }
      case "seal": {
        acceptedSeq = command.through;
        commit();
        let terminalWritten = false;
        let error: string | undefined;
        if (command.terminal !== undefined && journal !== undefined) {
          try {
            journal.appendFinal(
              JSON.parse(command.terminal, decodeRecordValue) as TelemetryJournalRecord,
            );
            terminalWritten = true;
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
          }
        }
        const sealed = stats();
        post({
          type: "sealed",
          through: command.through,
          stats: sealed,
          terminalWritten,
          ...(error === undefined ? {} : { error }),
        });
        store?.close();
        return;
      }
      case "stats": {
        // A stats request is also an idle flush: a low-traffic process must not
        // hold records below the batch threshold indefinitely.
        if (pending.length > 0) commit();
        post({ type: "stats", token: command.token, stats: stats() });
        return;
      }
    }
  } catch (cause) {
    failed = true;
    post({ type: "failure", message: cause instanceof Error ? cause.message : String(cause) });
  }
};
