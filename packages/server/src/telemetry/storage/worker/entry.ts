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
 * Every signal crosses here, and so does every cursor. Leaving any of them on
 * the serving thread would put two writers on one file and split the accounting
 * that makes the disk budget mean anything.
 */
import { TelemetrySidecarStores } from "../kinds.ts";
import type { TelemetryJournalRecord } from "../../application-signals/types.ts";
import {
  decodeRecordValue,
  FIELD_SEPARATOR,
  RECORD_SEPARATOR,
  type TelemetryExportRequest,
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

let stores: TelemetrySidecarStores | undefined;
let commitBatch = 512;
let commitDelayMs = 25;
let commitTimer: ReturnType<typeof setTimeout> | undefined;

const pending: Pending[] = [];
let pendingBytes = 0;
let durableSeq = 0;
let processedSeq = 0;
let acceptedSeq = 0;
let committedRecords = 0;
let committedTransactions = 0;
let rejectedRecords = 0;
let failed = false;

function post(message: TelemetryWorkerEvent): void {
  (self as unknown as { postMessage(value: unknown): void }).postMessage(message);
}

function stats(): TelemetryWorkerStats {
  const snapshot = stores?.store.snapshot();
  return {
    durableSeq,
    processedSeq,
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
    freeBytes: snapshot?.freeBytes ?? Number.POSITIVE_INFINITY,
    pressure: snapshot?.pressure ?? 0,
    readOnly: snapshot?.readOnly ?? false,
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
  if (pending.length === 0 || stores === undefined) return;
  const batch = pending.splice(0, pending.length);
  pendingBytes = 0;
  const highest = acceptedSeq;
  const open = stores;
  try {
    open.store.database.transaction(() => {
      for (const item of batch) open.write(item.kind, item.value);
      open.store.maintain();
    })();
    committedRecords += batch.length;
    committedTransactions++;
    // Only a commit is a durability claim.
    durableSeq = highest;
  } catch (error) {
    // One transaction's loss is accounted; whether the connection itself is
    // gone is the store's probe to answer, exactly as on the serving thread.
    rejectedRecords += batch.length;
    if (!open.store.observeFailure(error)) failed = true;
  }
  // Resolved either way, so a batch that will never become durable does not
  // wedge every future drain — but it is not reported as durable.
  processedSeq = highest;
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
        stores = new TelemetrySidecarStores({
          path: command.path,
          generation: command.generation,
          ...(command.retention === undefined ? {} : { retention: command.retention }),
          ...(command.maxStoredBytes === undefined
            ? {}
            : { maxStoredBytes: command.maxStoredBytes }),
        });
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
        if (command.terminal !== undefined && stores !== undefined) {
          try {
            stores.journal.appendFinal(
              JSON.parse(command.terminal, decodeRecordValue) as TelemetryJournalRecord,
            );
            terminalWritten = true;
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
          }
        }
        // The stats are read while the connection is open and the connection is
        // closed BEFORE the acknowledgement: a seal that answers first hands the
        // serving thread a promise that resolves while this thread still holds
        // the file, and the next process to open it gets SQLITE_BUSY.
        const sealed = stats();
        stores?.store.close();
        post({
          type: "sealed",
          through: command.through,
          stats: sealed,
          terminalWritten,
          ...(error === undefined ? {} : { error }),
        });
        return;
      }
      case "stats": {
        // A stats request is also an idle flush: a low-traffic process must not
        // hold records below the batch threshold indefinitely.
        if (pending.length > 0) commit();
        post({ type: "stats", token: command.token, stats: stats() });
        return;
      }
      case "export": {
        exportRequest(command.token, command.name, command.request);
        return;
      }
    }
  } catch (cause) {
    failed = true;
    post({ type: "failure", message: cause instanceof Error ? cause.message : String(cause) });
  }
};

/**
 * Run one cursor operation for the export pump and answer it. A failure is
 * reported on the reply rather than as a process failure: the pump has a waiter
 * for this token, and a waiter that never settles wedges that consumer for the
 * life of the process. A batch commits first, so a consumer never has to wait
 * for unrelated traffic to push a record it already accepted over the threshold.
 */
function exportRequest(token: number, name: string, request: TelemetryExportRequest): void {
  const open = stores;
  if (open === undefined) {
    post({ type: "export", token, error: "telemetry sidecar is not open" });
    return;
  }
  try {
    if (request.kind === "batch" && pending.length > 0) {
      commit();
      post({ type: "watermark", stats: stats() });
    }
    switch (request.kind) {
      case "batch": {
        const batch = open.journal.consumerBatch(name, request.limit);
        post({ type: "export", token, consumer: batch.consumer, records: batch.records });
        return;
      }
      case "advance": {
        post({
          type: "export",
          token,
          consumer: open.journal.advanceConsumer(name, request.cursor, {
            exportedRecords: request.exportedRecords,
            skippedUnsupported: request.skippedUnsupported,
            skippedIdentity: request.skippedIdentity,
          }),
        });
        return;
      }
      case "failure": {
        post({
          type: "export",
          token,
          consumer: open.journal.recordConsumerFailure(name, request.timedOut),
        });
        return;
      }
    }
  } catch (cause) {
    post({
      type: "export",
      token,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
