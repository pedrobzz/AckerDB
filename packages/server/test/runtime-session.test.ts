import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  parseClientMessage,
  type MutationOkMessage,
  type Outcome,
  type TransitionMessage,
} from "@dbzz/core";
import {
  DbzzClient,
  type DbzzClientClock,
  type DbzzClientError,
  type DbzzLiveEvent,
  type DbzzWebSocket,
} from "@dbzz/client";
import {
  type CredentialVerifier,
  type PrincipalInvalidation,
  type UserPrincipal,
} from "../src/auth.ts";
import { dbz } from "../src/dbz.ts";
import { Engine } from "../src/engine.ts";
import { mutation, query } from "../src/functions.ts";
import { reconcile } from "../src/reconcile.ts";
import { Registry } from "../src/registry.ts";
import { Runtime } from "../src/runtime.ts";
import { defineEventTable, defineSchema, defineTable } from "../src/schema.ts";
import {
  Session,
  type SessionApplicationMessage,
  type SessionClock,
  type SessionControlMessage,
  type SessionSink,
} from "../src/session.ts";

const NOW = 1_720_000_000_000;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function uuidV7(now: number, sequence: number): string {
  const timestamp = now.toString(16).padStart(12, "0");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

class FixedClock implements SessionClock, DbzzClientClock {
  now = (): number => NOW;
  setTimeout = (_callback: () => void, _delayMs: number): number => 1;
  clearTimeout = (_handle: unknown): void => {};
  setInterval = (_callback: () => void, _delayMs: number): number => 2;
  clearInterval = (_handle: unknown): void => {};
}

class UserVerifier implements CredentialVerifier {
  readonly revocationBound = { kind: "token-expiration" } as const;

  async verify(token: string): Promise<UserPrincipal> {
    if (token !== "alice" && token !== "bob") throw new Error("unknown test credential");
    return {
      kind: "user",
      issuer: "https://issuer.example/",
      subject: token,
      claims: { role: "member" },
      expiresAt: NOW + 60_000,
      tokenId: `token-${token}`,
    };
  }

  subscribeInvalidation(_listener: (invalidation: PrincipalInvalidation) => void): () => void {
    return () => {};
  }
}

interface ApplicationRecord {
  readonly authEpoch: number;
  readonly message: SessionApplicationMessage;
}

interface ApplicationBlock {
  readonly entered: Promise<void>;
  release(): void;
}

interface PendingApplicationBlock {
  readonly predicate: (record: ApplicationRecord) => boolean;
  readonly entered: Deferred<void>;
  readonly released: Deferred<void>;
}

function applicationTrace(authEpoch: number, message: SessionApplicationMessage): string {
  if (message.t === "transition") {
    return `application:transition:${message.id}:${message.transition.kind}:${authEpoch}`;
  }
  if (message.t === "ok" && message.kind === "mutation") {
    return `application:mutation:${message.id}:${message.receipt.replay}:${authEpoch}`;
  }
  return `application:${message.t}:${message.id}:${authEpoch}`;
}

class DeterministicSink implements SessionSink {
  readonly controls: SessionControlMessage[] = [];
  readonly applications: ApplicationRecord[] = [];
  readonly droppedApplications: ApplicationRecord[] = [];
  readonly closes: Outcome[] = [];
  readonly trace: string[] = [];
  dropNextMutationResponse = false;
  private readonly authWaiters = new Map<number, Set<() => void>>();
  private applicationBlock: PendingApplicationBlock | null = null;

  async sendControl(message: SessionControlMessage): Promise<void> {
    this.controls.push(message);
    if (message.t === "auth") {
      this.trace.push(`control:auth:${message.attemptId}:${message.authEpoch}`);
      for (const resolve of this.authWaiters.get(message.attemptId) ?? []) resolve();
      this.authWaiters.delete(message.attemptId);
      return;
    }
    this.trace.push(`control:${message.t}`);
  }

  async sendApplication(authEpoch: number, message: SessionApplicationMessage): Promise<void> {
    const record = { authEpoch, message };
    this.trace.push(applicationTrace(authEpoch, message));
    const block = this.applicationBlock;
    if (block?.predicate(record)) {
      this.applicationBlock = null;
      block.entered.resolve(undefined);
      await block.released.promise;
    }
    if (this.dropNextMutationResponse && message.t === "ok" && message.kind === "mutation") {
      this.dropNextMutationResponse = false;
      this.droppedApplications.push(record);
      return;
    }
    this.applications.push(record);
  }

  async dropApplicationFramesBefore(authEpoch: number): Promise<void> {
    this.trace.push(`drop-before:${authEpoch}`);
    for (let index = this.applications.length - 1; index >= 0; index--) {
      if (this.applications[index]!.authEpoch < authEpoch) this.applications.splice(index, 1);
    }
  }

  async close(outcome: Outcome): Promise<void> {
    this.closes.push(outcome);
  }

  waitForAuth(attemptId: number): Promise<void> {
    if (this.controls.some((message) => message.t === "auth" && message.attemptId === attemptId)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let waiters = this.authWaiters.get(attemptId);
      if (waiters === undefined) this.authWaiters.set(attemptId, (waiters = new Set()));
      waiters.add(resolve);
    });
  }

  blockNextApplication(predicate: (record: ApplicationRecord) => boolean): ApplicationBlock {
    if (this.applicationBlock !== null) throw new Error("an application delivery is already blocked");
    const entered = deferred<void>();
    const released = deferred<void>();
    this.applicationBlock = { predicate, entered, released };
    return { entered: entered.promise, release: () => released.resolve(undefined) };
  }
}

class SessionSocket implements DbzzWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  session!: Session;
  readonly pending = new Set<Promise<void>>();
  error: unknown;
  private closed = false;
  private inboundTail: Promise<void> = Promise.resolve();

  send(data: string): void {
    if (this.closed) throw new Error("socket is closed");
    const message = parseClientMessage(decode(data));
    const operation = this.inboundTail.then(() => this.session.handle(message));
    this.inboundTail = operation.catch(() => {});
    this.track(operation);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
    this.track(this.session.close());
  }

  open(): void {
    if (!this.closed) this.onopen?.();
  }

  receive(message: SessionControlMessage | SessionApplicationMessage): void {
    if (!this.closed) this.onmessage?.({ data: encode(message) });
  }

  serverClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  async settle(): Promise<void> {
    for (let turn = 0; turn < 32; turn++) {
      await Promise.resolve();
      if (this.pending.size === 0) break;
      await Promise.all([...this.pending]);
    }
    if (this.error !== undefined) throw this.error;
  }

  private track(operation: Promise<void>): void {
    let settled!: Promise<void>;
    settled = operation
      .catch((error) => {
        this.error = error;
      })
      .finally(() => this.pending.delete(settled));
    this.pending.add(settled);
  }
}

class SessionSocketSink implements SessionSink {
  constructor(private readonly socket: SessionSocket) {}

  async sendControl(message: SessionControlMessage): Promise<void> {
    this.socket.receive(message);
  }

  async sendApplication(_authEpoch: number, message: SessionApplicationMessage): Promise<void> {
    this.socket.receive(message);
  }

  async dropApplicationFramesBefore(_authEpoch: number): Promise<void> {}

  async close(_outcome: Outcome): Promise<void> {
    this.socket.serverClose();
  }
}

function mutationMessages(records: readonly ApplicationRecord[]): MutationOkMessage[] {
  return records.flatMap(({ message }) =>
    message.t === "ok" && message.kind === "mutation" ? [message] : []
  );
}

function transitionMessages(records: readonly ApplicationRecord[]): TransitionMessage[] {
  return records.flatMap(({ message }) => message.t === "transition" ? [message] : []);
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 16; turn++) await Promise.resolve();
}

const schema = defineSchema({
  messages: defineTable({
    id: dbz.primaryKey(),
    channelId: dbz.bigint(),
    body: dbz.string(),
  }).index("by_channel", ["channelId"]),
  typing: defineEventTable({
    id: dbz.primaryKey(),
    channelId: dbz.bigint(),
  }, {
    args: { channelId: dbz.bigint() },
    access: "public",
    matches: (row, args) => row.channelId === args.channelId,
  }),
  privateTyping: defineEventTable({
    id: dbz.primaryKey(),
    channelId: dbz.bigint(),
  }, {
    args: { channelId: dbz.bigint() },
    access: "authenticated",
    matches: (row, args) => row.channelId === args.channelId,
  }),
});

// Integration tests exercise runtime ownership rather than generated application types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

describe("Session + Runtime integration", () => {
  test("orders convergence, replay, and auth-epoch transitions end to end", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dbzz-runtime-session-"));
    const engine = new Engine(schema, join(directory, "data.db"));
    reconcile(engine);
    let mutationExecutions = 0;
    const registry = new Registry({
      messages: {
        list: query({
          access: "public",
          args: { channelId: dbz.bigint() },
          handler: (ctx: Ctx, args: Ctx) =>
            ctx.db.messages.byChannel((builder: Ctx) =>
              builder.eq("channelId", args.channelId)
            ).collect(),
        }),
        identity: query({
          access: "authenticated",
          args: {},
          handler: (ctx: Ctx) => ({ subject: ctx.auth.subject }),
        }),
        send: mutation({
          access: "public",
          args: { channelId: dbz.bigint(), body: dbz.string() },
          handler: async (ctx: Ctx, args: Ctx) => {
            mutationExecutions++;
            return ctx.db.messages.insert(args);
          },
        }),
      },
    });
    const runtime = new Runtime({ engine, registry, telemetry: false, now: () => NOW });
    const sink = new DeterministicSink();
    const session = new Session({
      runtime,
      sink,
      verifier: new UserVerifier(),
      clock: new FixedClock(),
    });

    try {
      await session.handle({
        v: PROTOCOL_VERSION,
        t: "hello",
        clientSessionId: "integration-client",
        credential: { kind: "bearer", token: "alice" },
      });
      expect(sink.controls).toEqual([{
        v: PROTOCOL_VERSION,
        t: "welcome",
        clientSessionId: "integration-client",
        authEpoch: 0,
        principal: "user",
      }]);

      await session.handle({
        v: PROTOCOL_VERSION,
        t: "sub",
        id: 10,
        ref: "messages.list",
        args: { channelId: 1n },
      });
      const initial = transitionMessages(sink.applications).at(-1);
      expect(initial).toMatchObject({
        id: 10,
        transition: {
          kind: "reset",
          from: null,
          to: { authEpoch: 0, commitVersion: 0n },
          value: [],
        },
      });

      const mutationRequestId = uuidV7(NOW, 1);
      const mutation = {
        v: PROTOCOL_VERSION,
        t: "m" as const,
        id: 2,
        ref: "messages.send",
        args: { channelId: 1n, body: "once" },
        mutationRequestId,
        issuedAt: NOW,
      };
      sink.dropNextMutationResponse = true;
      const mutationTraceStart = sink.trace.length;
      await session.handle(mutation);

      expect(sink.trace.slice(mutationTraceStart)).toEqual([
        "application:transition:10:update:0",
        "application:mutation:2:executed:0",
      ]);
      const update = transitionMessages(sink.applications).at(-1);
      const dropped = mutationMessages(sink.droppedApplications)[0];
      expect(update).toMatchObject({
        id: 10,
        transition: { kind: "update", to: { authEpoch: 0 } },
      });
      expect(dropped).toBeDefined();
      expect(dropped!.receipt).toEqual({
        mutationRequestId,
        commitVersion: update!.transition.to.commitVersion,
        durability: "production",
        replay: "executed",
        obligations: [10],
      });
      expect(mutationMessages(sink.applications)).toHaveLength(0);

      await session.handle({ ...mutation, id: 3 });
      const replay = mutationMessages(sink.applications).at(-1);
      expect(replay).toMatchObject({
        id: 3,
        value: 1n,
        receipt: {
          mutationRequestId,
          commitVersion: dropped!.receipt.commitVersion,
          durability: "production",
          replay: "replayed",
          obligations: [10],
        },
      });
      expect(mutationExecutions).toBe(1);
      expect(engine.reader.query('SELECT COUNT(*) AS count FROM "messages"').get()).toEqual({ count: 1n });

      await session.handle({
        v: PROTOCOL_VERSION,
        t: "sub",
        id: 20,
        ref: "messages.identity",
        args: {},
      });
      expect(transitionMessages(sink.applications).at(-1)).toMatchObject({
        id: 20,
        transition: { kind: "reset", to: { authEpoch: 0 }, value: { subject: "alice" } },
      });

      const rotationTraceStart = sink.trace.length;
      const authenticated = sink.waitForAuth(1);
      await session.handle({
        v: PROTOCOL_VERSION,
        t: "auth",
        attemptId: 1,
        credential: { kind: "bearer", token: "bob" },
      });
      await authenticated;
      await settle();

      expect(sink.trace.slice(rotationTraceStart)).toEqual([
        "drop-before:1",
        "application:transition:10:revoked:1",
        "application:transition:20:revoked:1",
        "application:transition:10:reset:1",
        "application:transition:20:reset:1",
        "control:auth:1:1",
      ]);
      expect(sink.applications.every(({ authEpoch }) => authEpoch === 1)).toBe(true);
      expect(transitionMessages(sink.applications).every(({ transition }) =>
        transition.to.authEpoch === 1
      )).toBe(true);
      expect(transitionMessages(sink.applications).findLast(({ id, transition }) =>
        id === 20 && transition.kind === "reset"
      )).toMatchObject({ transition: { value: { subject: "bob" } } });
      expect(session.snapshot()).toMatchObject({
        phase: "active",
        authEpoch: 1,
        principal: { kind: "user", subject: "bob" },
      });
    } finally {
      await session.close();
      await runtime.drain();
      engine.close("clean");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps real client event state consistent through partitions, refresh, and sign-out", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dbzz-client-session-events-"));
    const engine = new Engine(schema, join(directory, "data.db"));
    reconcile(engine);
    const registry = new Registry({
      typing: {
        emit: mutation({
          access: "public",
          args: { channelId: dbz.bigint() },
          handler: async (ctx: Ctx, args: Ctx) => {
            await ctx.db.typing.insert(args);
            await ctx.db.privateTyping.insert(args);
            return null;
          },
        }),
      },
    });
    const runtime = new Runtime({ engine, registry, telemetry: false, now: () => NOW });
    const clock = new FixedClock();
    let socket!: SessionSocket;
    const client = new DbzzClient({
      url: "http://loopback.test",
      credential: { kind: "bearer", token: "alice" },
      clientSessionId: "real-client-events",
      clock,
      random: () => 0,
      createWebSocket: () => {
        socket = new SessionSocket();
        socket.session = new Session({
          runtime,
          sink: new SessionSocketSink(socket),
          verifier: new UserVerifier(),
          clock,
        });
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const publicOne: DbzzLiveEvent<{ id: bigint; channelId: bigint }>[] = [];
    const publicTwo: DbzzLiveEvent<{ id: bigint; channelId: bigint }>[] = [];
    const privateOne: DbzzLiveEvent<{ id: bigint; channelId: bigint }>[] = [];
    const privateErrors: DbzzClientError[] = [];
    const malformedErrors: DbzzClientError[] = [];

    try {
      client.subscribeEvent<{ channelId: bigint }, { id: bigint; channelId: bigint }>(
        "events.typing",
        { channelId: 1n },
        (event) => publicOne.push(event),
      );
      client.subscribeEvent<{ channelId: bigint }, { id: bigint; channelId: bigint }>(
        "events.typing",
        { channelId: 2n },
        (event) => publicTwo.push(event),
      );
      client.subscribeEvent<{ channelId: bigint }, { id: bigint; channelId: bigint }>(
        "events.privateTyping",
        { channelId: 1n },
        (event) => privateOne.push(event),
        (error) => privateErrors.push(error),
      );
      client.subscribeEvent<{ channelId: string }, unknown>(
        "events.typing",
        { channelId: "malformed" },
        () => {},
        (error) => malformedErrors.push(error),
      );
      await socket.settle();
      expect(malformedErrors).toMatchObject([{ code: "validation" }]);

      const first = client.mutation("typing.emit", { channelId: 1n });
      await socket.settle();
      await first;
      expect(publicOne.filter((event) => event.kind === "row")).toHaveLength(1);
      expect(publicTwo.filter((event) => event.kind === "row")).toHaveLength(0);
      expect(privateOne.filter((event) => event.kind === "row")).toHaveLength(1);

      const refresh = client.refreshCredential({ kind: "bearer", token: "bob" });
      await socket.settle();
      expect(await refresh).toEqual({ authEpoch: 1, principal: "user" });
      expect(privateErrors).toHaveLength(0);
      expect(privateOne.filter((event) => event.kind === "reset")).toHaveLength(2);

      const afterRefresh = client.mutation("typing.emit", { channelId: 1n });
      await socket.settle();
      await afterRefresh;
      expect(privateOne.filter((event) => event.kind === "row")).toHaveLength(2);

      const signOut = client.refreshCredential({ kind: "anonymous" });
      await socket.settle();
      expect(await signOut).toEqual({ authEpoch: 2, principal: "anonymous" });
      expect(privateErrors).toMatchObject([{ code: "unauthenticated" }]);
      const privateRows = privateOne.filter((event) => event.kind === "row").length;

      const afterSignOut = client.mutation("typing.emit", { channelId: 1n });
      await socket.settle();
      await afterSignOut;
      expect(privateOne.filter((event) => event.kind === "row")).toHaveLength(privateRows);
      expect(publicOne.filter((event) => event.kind === "row")).toHaveLength(3);
      expect(runtime.status().reactive.eventListeners).toBe(2);
    } finally {
      client.close();
      await socket?.settle();
      await runtime.drain();
      engine.close("clean");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("never relabels slow old-principal query or event delivery with the new epoch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dbzz-runtime-session-race-"));
    const engine = new Engine(schema, join(directory, "data.db"));
    reconcile(engine);
    const registry = new Registry({
      messages: {
        list: query({
          access: "public",
          args: { channelId: dbz.bigint() },
          handler: (ctx: Ctx, args: Ctx) =>
            ctx.db.messages.byChannel((builder: Ctx) =>
              builder.eq("channelId", args.channelId)
            ).collect(),
        }),
        send: mutation({
          access: "public",
          args: { channelId: dbz.bigint(), body: dbz.string() },
          handler: (ctx: Ctx, args: Ctx) => ctx.db.messages.insert(args),
        }),
      },
      typing: {
        emit: mutation({
          access: "public",
          args: { channelId: dbz.bigint() },
          handler: (ctx: Ctx, args: Ctx) => ctx.db.typing.insert(args),
        }),
      },
    });
    const runtime = new Runtime({ engine, registry, telemetry: false, now: () => NOW });
    const verifier = new UserVerifier();
    const slowSink = new DeterministicSink();
    const targetSink = new DeterministicSink();
    const callerSink = new DeterministicSink();
    const slow = new Session({ runtime, sink: slowSink, verifier, clock: new FixedClock() });
    const target = new Session({ runtime, sink: targetSink, verifier, clock: new FixedClock() });
    const caller = new Session({ runtime, sink: callerSink, clock: new FixedClock() });

    try {
      await slow.handle({
        v: PROTOCOL_VERSION,
        t: "hello",
        clientSessionId: "slow-client",
        credential: { kind: "bearer", token: "alice" },
      });
      await target.handle({
        v: PROTOCOL_VERSION,
        t: "hello",
        clientSessionId: "target-client",
        credential: { kind: "bearer", token: "alice" },
      });
      await caller.handle({
        v: PROTOCOL_VERSION,
        t: "hello",
        clientSessionId: "caller-client",
        credential: { kind: "anonymous" },
      });
      for (const session of [slow, target]) {
        await session.handle({
          v: PROTOCOL_VERSION,
          t: "sub",
          id: 10,
          ref: "messages.list",
          args: { channelId: 1n },
        });
        await session.handle({
          v: PROTOCOL_VERSION,
          t: "sub",
          id: 20,
          ref: "events.typing",
          args: { channelId: 1n },
        });
      }

      const slowQuery = slowSink.blockNextApplication(({ message }) =>
        message.t === "transition" && message.id === 10 && message.transition.kind === "update"
      );
      const queryMutation = caller.handle({
        v: PROTOCOL_VERSION,
        t: "m",
        id: 1,
        ref: "messages.send",
        args: { channelId: 1n, body: "query-race" },
        mutationRequestId: uuidV7(NOW, 2),
        issuedAt: NOW,
      });
      await slowQuery.entered;

      const firstAuth = targetSink.waitForAuth(1);
      await target.handle({
        v: PROTOCOL_VERSION,
        t: "auth",
        attemptId: 1,
        credential: { kind: "bearer", token: "bob" },
      });
      await firstAuth;
      await settle();
      const beforeQueryRelease = targetSink.applications.length;
      slowQuery.release();
      await queryMutation;

      expect(targetSink.applications.slice(beforeQueryRelease)).toEqual([]);

      const slowEvent = slowSink.blockNextApplication(({ message }) =>
        message.t === "event" && message.id === 20 && message.event.kind === "row"
      );
      const eventMutation = caller.handle({
        v: PROTOCOL_VERSION,
        t: "m",
        id: 2,
        ref: "typing.emit",
        args: { channelId: 1n },
        mutationRequestId: uuidV7(NOW, 3),
        issuedAt: NOW,
      });
      await slowEvent.entered;

      const secondAuth = targetSink.waitForAuth(2);
      await target.handle({
        v: PROTOCOL_VERSION,
        t: "auth",
        attemptId: 2,
        credential: { kind: "bearer", token: "alice" },
      });
      await secondAuth;
      await settle();
      const beforeEventRelease = targetSink.applications.length;
      slowEvent.release();
      await eventMutation;

      expect(targetSink.applications.slice(beforeEventRelease)).not.toContainEqual(expect.objectContaining({
        authEpoch: 2,
        message: expect.objectContaining({
          t: "event",
          id: 20,
          event: expect.objectContaining({ kind: "row" }),
        }),
      }));
      expect(targetSink.applications.every(({ authEpoch }) => authEpoch === 2)).toBe(true);
    } finally {
      await Promise.all([slow.close(), target.close(), caller.close()]);
      await runtime.drain();
      engine.close("clean");
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
