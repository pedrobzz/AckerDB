/**
 * The runtime: executes functions with the right guarantees.
 *
 * - Mutations and procedure transactions serialize through a writer mutex;
 *   each runs in BEGIN IMMEDIATE .. COMMIT on the writer connection.
 * - Queries (one-shot and subscription recomputes) run inside a read
 *   transaction on the reader connection (WAL snapshot), serialized by a
 *   read mutex — reads can never observe a commit landing mid-handler.
 * - Mutations are exactly-once: the client's idempotency key and the encoded
 *   result are recorded in _dbz_mutations *inside* the same transaction; a
 *   retry replays the recorded result instead of re-executing.
 * - `fetch` inside any transaction throws (AsyncLocalStorage guard): the
 *   rule that keeps mutations retriable is enforced, not suggested.
 * - After each commit: buffered event rows broadcast, affected subscription
 *   entries recompute once per (query, args), the scheduler re-arms.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { decode, encode } from "@dbzz/core";
import { checkShape, ValidationError } from "./dbz.ts";
import { makeDbReader, makeDbWriter, newWriteCollector, type WriteCollector } from "./db.ts";
import type { Engine } from "./engine.ts";
import { emitWriteKeys } from "./keys.ts";
import type { AnyRegistered, AuthCtx, ProcedureCtx, SseCtx, StreamWriter } from "./functions.ts";
import { SubscriptionManager, type SubEntry, type Subscriber } from "./reactive.ts";
import type { Registry } from "./registry.ts";

const txALS = new AsyncLocalStorage<true>();
let fetchPatched = false;

/** Make `fetch` throw inside transactions. Installed once per process. */
function patchFetch(): void {
  if (fetchPatched) return;
  fetchPatched = true;
  const original = globalThis.fetch;
  const guarded = ((...args: Parameters<typeof fetch>) => {
    if (txALS.getStore() === true) {
      throw new Error(
        "fetch is not allowed inside a transaction — mutations must stay retriable; use a procedure",
      );
    }
    return original(...args);
  }) as typeof fetch;
  Object.assign(guarded, original);
  globalThis.fetch = guarded;
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

const ANONYMOUS: AuthCtx = { userId: null, sessionId: null, identity: null };

export class Runtime {
  readonly engine: Engine;
  readonly registry: Registry;
  readonly subs = new SubscriptionManager();
  private readonly writeMutex = new Mutex();
  private readonly readMutex = new Mutex();
  private readonly scheduled: Map<string, string>;
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly eventSeqs = new Map<string, bigint>();
  private stopped = false;

  constructor(opts: { engine: Engine; registry: Registry }) {
    patchFetch();
    this.engine = opts.engine;
    this.registry = opts.registry;
    this.scheduled = opts.registry.resolveScheduled(opts.engine.schema);
    this.engine.writer
      .query("DELETE FROM _dbz_mutations WHERE at < ?")
      .run(Date.now() - 3600_000);
    this.armScheduler();
  }

  stop(): void {
    this.stopped = true;
    if (this.schedulerTimer !== null) clearTimeout(this.schedulerTimer);
    this.schedulerTimer = null;
  }

  kindOf(address: string): string | null {
    if (address.startsWith("events.")) return "event";
    return this.registry.kindOf(address) ?? null;
  }

  private expect(address: string, kind: string): AnyRegistered {
    const fn = this.registry.get(address);
    if (fn === undefined) throw new ValidationError(`unknown function "${address}"`);
    if (fn.kind !== kind) {
      throw new ValidationError(`"${address}" is a ${fn.kind}, expected a ${kind}`);
    }
    return fn;
  }

  private nextEventId(table: string): bigint {
    const next = (this.eventSeqs.get(table) ?? 0n) + 1n;
    this.eventSeqs.set(table, next);
    return next;
  }

  // -- queries ---------------------------------------------------------------

  async runQuery(address: string, args: unknown, reads: Set<string> | null = null): Promise<unknown> {
    const fn = this.expect(address, "query");
    const checked = checkShape(fn.args, args ?? {}, address);
    return this.readMutex.run(async () => {
      const reader = this.engine.reader;
      const snapshot = reader !== this.engine.writer;
      if (snapshot) reader.exec("BEGIN DEFERRED");
      try {
        const db = makeDbReader(this.engine, reader, reads === null ? null : { add: (k) => reads.add(k) });
        return await (fn.handler as (ctx: unknown, args: unknown) => unknown)(
          { db, auth: ANONYMOUS },
          checked,
        );
      } finally {
        if (snapshot) reader.exec("COMMIT");
      }
    });
  }

  // -- transactions (mutations + procedure tx) --------------------------------

  private async transact<T>(
    work: (db: unknown) => Promise<T> | T,
    record?: { mid: string },
  ): Promise<{ result: T; replayed: boolean }> {
    if (txALS.getStore() === true) {
      throw new Error(
        "cannot open a transaction inside a transaction — run transactions sequentially in the procedure body",
      );
    }
    const outcome = await this.writeMutex.run(async () => {
      const writer = this.engine.writer;
      if (record !== undefined) {
        const row = writer
          .query("SELECT result FROM _dbz_mutations WHERE mid = ?")
          .get(record.mid) as { result: string } | null;
        if (row !== null) return { result: decode(row.result) as T, replayed: true, writes: null };
      }
      const writes = newWriteCollector();
      const db = makeDbWriter(this.engine, writes, (table) => this.nextEventId(table));
      writer.exec("BEGIN IMMEDIATE");
      try {
        const result = await txALS.run(true, async () => work(db));
        if (record !== undefined) {
          writer
            .query("INSERT INTO _dbz_mutations (mid, result, at) VALUES (?, ?, ?)")
            .run(record.mid, encode(result), Date.now());
        }
        writer.exec("COMMIT");
        return { result, replayed: false, writes };
      } catch (error) {
        writer.exec("ROLLBACK");
        throw error;
      }
    });
    if (outcome.writes !== null) await this.afterCommit(outcome.writes);
    return { result: outcome.result, replayed: outcome.replayed };
  }

  async runMutation(address: string, args: unknown, mid?: string): Promise<unknown> {
    const fn = this.expect(address, "mutation");
    const checked = checkShape(fn.args, args ?? {}, address);
    const { result } = await this.transact(
      (db) =>
        (fn.handler as (ctx: unknown, args: unknown) => unknown)({ db, auth: ANONYMOUS }, checked),
      mid === undefined ? undefined : { mid },
    );
    return result;
  }

  // -- procedures --------------------------------------------------------------

  private procedureCtx(): ProcedureCtx {
    return {
      auth: ANONYMOUS,
      tx: async <T>(fn: (tx: { db: never; auth: typeof ANONYMOUS }) => T | Promise<T>): Promise<T> => {
        const { result } = await this.transact((db) => fn({ db: db as never, auth: ANONYMOUS }));
        return result;
      },
    };
  }

  async runProcedure(address: string, args: unknown): Promise<unknown> {
    const fn = this.expect(address, "procedure");
    const checked = checkShape(fn.args, args ?? {}, address);
    return (fn.handler as (ctx: unknown, args: unknown) => unknown)(this.procedureCtx(), checked);
  }

  // -- SSE procedures -----------------------------------------------------------

  runSse(address: string, args: unknown, signal: AbortSignal): ReadableStream<string> {
    const fn = this.expect(address, "sse");
    const checked = checkShape(fn.args, args ?? {}, address);
    let controller!: ReadableStreamDefaultController<string>;
    let closed = false;
    const enqueue = (text: string) => {
      if (closed) return;
      try {
        controller.enqueue(text);
      } catch {
        closed = true;
      }
    };
    const close = () => {
      if (closed) return;
      closed = true;
      try {
        controller.close();
      } catch {
        /* consumer already gone */
      }
    };
    const merges: Promise<void>[] = [];
    const stream: StreamWriter = {
      write: (chunk) => enqueue(`data: ${encode(chunk)}\n\n`),
      merge: (readable) => {
        merges.push(
          (async () => {
            const reader = readable.getReader();
            const cancel = () => void reader.cancel().catch(() => {});
            signal.addEventListener("abort", cancel, { once: true });
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                enqueue(`data: ${encode(value)}\n\n`);
              }
            } finally {
              signal.removeEventListener("abort", cancel);
            }
          })(),
        );
      },
    };
    const ctx: SseCtx = { ...this.procedureCtx(), stream, abortSignal: signal };
    const out = new ReadableStream<string>({
      start: (c) => {
        controller = c;
      },
      cancel: () => {
        closed = true;
      },
    });
    void (async () => {
      try {
        await (fn.handler as (ctx: unknown, args: unknown) => unknown)(ctx, checked);
        await Promise.all(merges);
        enqueue("data: [DONE]\n\n");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`sse ${address} failed:`, message);
        enqueue(`data: ${encode({ type: "error", errorText: message })}\n\n`);
      } finally {
        close();
      }
    })();
    return out;
  }

  // -- subscriptions -------------------------------------------------------------

  async subscribe(address: string, args: unknown, subscriber: Subscriber, subId: number): Promise<void> {
    if (address.startsWith("events.")) {
      const table = address.slice("events.".length);
      const def = this.engine.schema.tables[table];
      if (def === undefined || def.kind !== "event") {
        throw new ValidationError(`unknown event table "${table}"`);
      }
      this.subs.attachEvent(table, subscriber, subId);
      return;
    }
    const fn = this.expect(address, "query");
    const checked = checkShape(fn.args, args ?? {}, address);
    const { entry, isNew } = this.subs.entryFor(address, checked);
    this.subs.attach(entry, subscriber, subId);
    if (isNew) {
      await this.recompute(entry);
    } else if (entry.lastEncoded !== null) {
      subscriber.sendUpdate(subId, entry.lastEncoded);
    }
  }

  unsubscribe(subscriber: Subscriber, subId: number): void {
    this.subs.detach(subscriber, subId);
  }

  disconnect(subscriber: Subscriber): void {
    this.subs.detachAll(subscriber);
  }

  private async recompute(entry: SubEntry): Promise<void> {
    const reads = new Set<string>();
    try {
      const value = await this.runQuery(entry.address, entry.args, reads);
      const encoded = encode(value);
      const changed = this.subs.update(entry, reads, encoded);
      if (!changed) return;
      for (const [subscriber, ids] of entry.listeners) {
        for (const id of ids) subscriber.sendUpdate(id, encoded);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const [subscriber, ids] of entry.listeners) {
        for (const id of ids) subscriber.sendError(id, message);
      }
    }
  }

  private async afterCommit(writes: WriteCollector): Promise<void> {
    for (const event of writes.events) {
      const encoded = encode(event.row);
      for (const [subscriber, ids] of this.subs.eventListeners(event.table)) {
        for (const id of ids) subscriber.sendEvent(id, encoded);
      }
    }
    if (writes.keys.size > 0) {
      for (const entry of this.subs.affected(writes.keys)) {
        await this.recompute(entry);
      }
    }
    if (writes.scheduledTouched) this.armScheduler();
  }

  // -- scheduler --------------------------------------------------------------------

  armScheduler(): void {
    if (this.schedulerTimer !== null) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    if (this.stopped || this.scheduled.size === 0) return;
    let minAt: number | null = null;
    for (const table of this.scheduled.keys()) {
      const plan = this.engine.plan(table);
      const row = this.engine.writer
        .query(`SELECT MIN("${plan.scheduleAt}") AS m FROM "${table}"`)
        .get() as { m: number | bigint | null };
      if (row.m !== null) {
        const at = Number(row.m);
        if (minAt === null || at < minAt) minAt = at;
      }
    }
    if (minAt === null) return;
    const delay = Math.min(Math.max(0, minAt - Date.now()), 2 ** 31 - 1);
    this.schedulerTimer = setTimeout(() => {
      this.schedulerTimer = null;
      this.fireScheduled().catch((error) => console.error("scheduler failed:", error));
    }, delay);
  }

  private async fireScheduled(): Promise<void> {
    if (this.stopped) return;
    const due: { address: string; row: Record<string, unknown> }[] = [];
    const writes = newWriteCollector();
    await this.writeMutex.run(async () => {
      const writer = this.engine.writer;
      writer.exec("BEGIN IMMEDIATE");
      try {
        const now = Date.now();
        for (const [table, address] of this.scheduled) {
          const plan = this.engine.plan(table);
          const raws = writer
            .query(`SELECT * FROM "${table}" WHERE "${plan.scheduleAt}" <= ? ORDER BY "${plan.scheduleAt}"`)
            .all(now) as Record<string, unknown>[];
          for (const raw of raws) {
            const row = this.engine.rowFromSql(plan, raw);
            writer.query(`DELETE FROM "${table}" WHERE "${plan.pk}" = ?`).run(row[plan.pk] as never);
            emitWriteKeys(plan, row, writes.keys);
            due.push({ address, row });
          }
        }
        writer.exec("COMMIT");
      } catch (error) {
        writer.exec("ROLLBACK");
        throw error;
      }
    });
    await this.afterCommit(writes);
    for (const { address, row } of due) {
      try {
        if (this.registry.kindOf(address) === "mutation") {
          await this.runMutation(address, row);
        } else {
          await this.runProcedure(address, row);
        }
      } catch (error) {
        console.error(`scheduled handler ${address} failed:`, error);
      }
    }
    this.armScheduler();
  }
}
