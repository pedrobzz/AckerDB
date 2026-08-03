import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  encode,
  type AuthenticationDescriptor,
  type Identity,
  type MutationOkMessage,
  type Outcome,
  type SubscriptionTransition,
  type TransitionMessage,
} from "@ackerdb/core";
import {
  AckerDBClient,
  type AckerDBClientClock,
  type AckerDBClientError,
  type AckerDBLiveEvent,
  type AckerDBWebSocket,
} from "@ackerdb/client";
import {
  type CredentialVerifier,
  type PrincipalInvalidation,
  type VerifiedUserCredential,
} from "../../src/auth/credentials.ts";
import { v } from "../../src/validation/v.ts";
import { Engine } from "../../src/database/engine.ts";
import { mutation, query } from "../../src/app/functions.ts";
import { defineServiceLimits, PRODUCTION_LIMITS } from "../../src/runtime/limits.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineEventTable, defineSchema, defineTable } from "../../src/schema/definition.ts";
import {
  type RuntimePublication,
  type SessionApplicationMessage,
  type SessionClock,
  type SessionControlMessage,
  type SessionSink,
} from "../../src/subscriptions/session/contract.ts";
import { Session } from "../../src/subscriptions/session/session.ts";
import type { TelemetryRecord, TelemetrySpanRecord } from "../../src/telemetry/telemetry.ts";
import { deferred, type Deferred } from "ackerdb-test-support/async";

const ALICE_AUTHENTICATION = {
  principal: "user",
  identity: 1n as Identity,
  provenance: { issuer: "https://issuer.example/", subject: "alice" },
} satisfies AuthenticationDescriptor;
const BOB_AUTHENTICATION = {
  principal: "user",
  identity: 2n as Identity,
  provenance: { issuer: "https://issuer.example/", subject: "bob" },
} satisfies AuthenticationDescriptor;

const NOW = 1_720_000_000_000;
const TEST_SOURCE = Object.freeze({ family: "test", address: "runtime-session" });

function uuidV7(now: number, sequence: number): string {
  const timestamp = now.toString(16).padStart(12, "0");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

function handle(session: Session, frame: unknown): Promise<void> {
  return session.handle(encode(frame));
}

class FixedClock implements SessionClock, AckerDBClientClock {
  now = (): number => NOW;
  setTimeout = (_callback: () => void, _delayMs: number): number => 1;
  clearTimeout = (_handle: unknown): void => {};
  setInterval = (_callback: () => void, _delayMs: number): number => 2;
  clearInterval = (_handle: unknown): void => {};
}

interface ReconnectTask {
  at: number;
  readonly callback: () => void;
  readonly intervalMs?: number;
}

class ReconnectClock implements AckerDBClientClock {
  private time = NOW;
  private nextId = 0;
  private readonly tasks = new Map<number, ReconnectTask>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.time + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  setInterval(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.time + delayMs, callback, intervalMs: delayMs });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let next: [number, ReconnectTask] | undefined;
      for (const entry of this.tasks) {
        if (entry[1].at <= target && (next === undefined || entry[1].at < next[1].at)) {
          next = entry;
        }
      }
      if (next === undefined) break;
      const [id, task] = next;
      this.time = task.at;
      if (task.intervalMs === undefined) this.tasks.delete(id);
      else task.at += task.intervalMs;
      task.callback();
    }
    this.time = target;
  }
}

class UserVerifier implements CredentialVerifier {
  readonly revocationBound = { kind: "token-expiration" } as const;

  async verify(token: string): Promise<VerifiedUserCredential> {
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

  async sendApplication(authEpoch: number, publication: RuntimePublication): Promise<void> {
    const { message } = publication;
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

type TransitionCutPhase = "before" | "after";

interface TransitionCut {
  readonly kind: SubscriptionTransition["kind"];
  readonly phase: TransitionCutPhase;
}

class SessionSocket implements AckerDBWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  session!: Session;
  readonly pending = new Set<Promise<void>>();
  readonly attemptedTransitions: TransitionMessage[] = [];
  readonly deliveredTransitions: TransitionMessage[] = [];
  error: unknown;
  private closed = false;
  private inboundTail: Promise<void> = Promise.resolve();
  private transitionCut?: TransitionCut;

  send(data: string): void {
    if (this.closed) throw new Error("socket is closed");
    const operation = this.inboundTail.then(() => this.session.handle(data));
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

  receive(message: SessionControlMessage): void {
    if (!this.closed) this.onmessage?.({ data: encode(message) });
  }

  receiveText(text: string): void {
    if (!this.closed) this.onmessage?.({ data: text });
  }

  deliverApplication(publication: RuntimePublication): void {
    if (this.closed) return;
    const transition = publication.message.t === "transition"
      ? publication.message
      : undefined;
    if (transition !== undefined) {
      this.attemptedTransitions.push(transition);
      if (this.consumeTransitionCut(transition, "before")) {
        this.close();
        return;
      }
    }
    this.receiveText(publication.text);
    if (transition !== undefined) {
      this.deliveredTransitions.push(transition);
      if (this.consumeTransitionCut(transition, "after")) this.close();
    }
  }

  cutNextTransition(kind: SubscriptionTransition["kind"], phase: TransitionCutPhase): void {
    if (this.transitionCut !== undefined) throw new Error("a transition cut is already armed");
    this.transitionCut = { kind, phase };
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

  private consumeTransitionCut(
    transition: TransitionMessage,
    phase: TransitionCutPhase,
  ): boolean {
    if (
      this.transitionCut?.kind !== transition.transition.kind ||
      this.transitionCut.phase !== phase
    ) return false;
    this.transitionCut = undefined;
    return true;
  }
}

class SessionSocketSink implements SessionSink {
  constructor(private readonly socket: SessionSocket) {}

  async sendControl(message: SessionControlMessage): Promise<void> {
    // A transport handoff completes before the remote peer can react to it.
    // Two turns put Session's post-await state transition ahead of loopback delivery.
    queueMicrotask(() => queueMicrotask(() => this.socket.receive(message)));
  }

  async sendApplication(_authEpoch: number, publication: RuntimePublication): Promise<void> {
    this.socket.deliverApplication(publication);
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

async function waitForTransitionAttempt(
  socket: SessionSocket,
  kind: SubscriptionTransition["kind"],
): Promise<void> {
  for (let turn = 0; turn < 100; turn++) {
    if (socket.attemptedTransitions.some(({ transition }) => transition.kind === kind)) return;
    await Promise.resolve();
  }
  throw new Error(`timed out waiting for ${kind} transition`);
}

const schema = defineSchema({
  messages: defineTable({
    id: v.primaryKey(),
    channelId: v.bigint(),
    body: v.string(),
  }).index(["channelId"]),
  typing: defineEventTable({
    id: v.primaryKey(),
    channelId: v.bigint(),
  }, {
    args: { channelId: v.bigint() },
    access: "public",
    matches: (row, args) => row.channelId === args.channelId,
  }),
  privateTyping: defineEventTable({
    id: v.primaryKey(),
    channelId: v.bigint(),
  }, {
    args: { channelId: v.bigint() },
    access: "authenticated",
    matches: (row, args) => row.channelId === args.channelId,
  }),
});

// Integration tests exercise runtime ownership rather than generated application types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

type ReconnectTransitionCase = readonly [
  transition: SubscriptionTransition["kind"],
  phase: TransitionCutPhase,
  recoveryTransitions: readonly SubscriptionTransition["kind"][],
  updates: readonly string[],
  errors: readonly string[],
];

const RECONNECT_TRANSITION_CASES: readonly ReconnectTransitionCase[] = [
  ["reset", "before", ["reset"], ["", "one,two"], []],
  ["reset", "after", ["resume"], ["", "one,two"], []],
  ["update", "before", ["update"], ["", "one"], []],
  ["update", "after", ["resume"], ["", "one"], []],
  ["checkpoint", "before", ["checkpoint"], ["true"], []],
  ["checkpoint", "after", ["resume"], ["true"], []],
  ["resume", "before", ["resume"], [""], []],
  ["resume", "after", ["resume"], [""], []],
  ["revoked", "before", ["reset"], ["alice", "bob"], []],
  ["revoked", "after", ["reset"], ["alice", "bob"], ["auth_stale"]],
];

interface ReconnectTransitionEvidence {
  readonly transition: SubscriptionTransition["kind"];
  readonly phase: TransitionCutPhase;
  readonly cutAttempted: boolean;
  readonly cutApplied: boolean;
  readonly recoveryTransitions: readonly SubscriptionTransition["kind"][];
  readonly updates: readonly string[];
  readonly errors: readonly string[];
}

async function reconnectTransitionEvidence(
  transition: SubscriptionTransition["kind"],
  phase: TransitionCutPhase,
): Promise<ReconnectTransitionEvidence> {
  const directory = mkdtempSync(join(tmpdir(), `ackerdb-reconnect-${transition}-${phase}-`));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const limits = transition === "reset"
    ? defineServiceLimits({
        ...PRODUCTION_LIMITS,
        resume: { ...PRODUCTION_LIMITS.resume, maxTransitionsPerStream: 1 },
      })
    : PRODUCTION_LIMITS;
  const registry = new Registry({
    messages: {
      list: query({
        access: "public",
        args: { channelId: v.bigint() },
        handler: (ctx: Ctx, args: Ctx) =>
          ctx.db.messages.query()
            .where((row: Ctx) => row.channelId.eq(args.channelId))
            .collect(),
      }),
      nonempty: query({
        access: "public",
        args: { channelId: v.bigint() },
        handler: async (ctx: Ctx, args: Ctx) =>
          (await ctx.db.messages.query()
            .where((row: Ctx) => row.channelId.eq(args.channelId))
            .collect()).length > 0,
      }),
      identity: query({
        access: "authenticated",
        args: {},
        handler: (ctx: Ctx) => ({ subject: ctx.auth.subject }),
      }),
      send: mutation({
        access: "public",
        args: { channelId: v.bigint(), body: v.string() },
        handler: (ctx: Ctx, args: Ctx) => ctx.db.messages.insert(args),
      }),
    },
  });
  const verifier = new UserVerifier();
  const runtime = new Runtime({
    engine,
    registry,
    verifier,
    limits,
    telemetry: false,
    now: () => NOW,
  });
  const writerSink = new DeterministicSink();
  const writer = new Session({
    runtime,
    sink: writerSink,
    source: TEST_SOURCE,
    clock: new FixedClock(),
  });
  const clock = new ReconnectClock();
  const sockets: SessionSocket[] = [];
  const client = new AckerDBClient({
    url: "http://loopback.test",
    credential: { kind: "bearer", token: "alice" },
    clientSessionId: `reconnect-${transition}-${phase}`,
    clock,
    random: () => 0,
    reconnect: { baseDelayMs: 1, maxDelayMs: 1, stableOpenMs: 60_000 },
    createWebSocket: () => {
      const socket = new SessionSocket();
      socket.session = new Session({
        runtime,
        sink: new SessionSocketSink(socket),
        source: TEST_SOURCE,
        clock: new FixedClock(),
      });
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket;
    },
  });
  const updates: string[] = [];
  const errors: string[] = [];
  let mutationSequence = 0;

  const write = async (args: unknown): Promise<void> => {
    const sequence = ++mutationSequence;
    await handle(writer, {
      v: PROTOCOL_VERSION,
      t: "m",
      id: sequence,
      ref: "messages.send",
      args,
      mutationRequestId: uuidV7(NOW, 100 + sequence),
      issuedAt: NOW,
    });
  };
  const latestSocket = (): SessionSocket => {
    const socket = sockets.at(-1);
    if (socket === undefined) throw new Error("client did not create a socket");
    return socket;
  };
  const reconnect = async (): Promise<SessionSocket> => {
    const previousCount = sockets.length;
    clock.advance(1);
    const socket = sockets[previousCount];
    if (socket === undefined) throw new Error(`${transition}/${phase}: client did not reconnect`);
    await socket.settle();
    return socket;
  };
  const onError = (error: AckerDBClientError): void => {
    errors.push(error.code);
  };

  try {
    await handle(writer, {
      v: PROTOCOL_VERSION,
      t: "hello",
      clientSessionId: `writer-${transition}-${phase}`,
      credential: { kind: "anonymous" },
    });

    if (transition === "checkpoint") await write({ channelId: 1n, body: "seed" });

    if (transition === "checkpoint") {
      client.subscribe("messages.nonempty", { channelId: 1n }, (value) => {
        updates.push(String(value));
      }, onError);
    } else if (transition === "revoked") {
      client.subscribe("messages.identity", {}, (value) => {
        updates.push((value as { readonly subject: string }).subject);
      }, onError);
    } else {
      client.subscribe("messages.list", { channelId: 1n }, (value) => {
        const rows = value as readonly { readonly body: string }[];
        updates.push(rows.map(({ body }) => body).sort().join(","));
      }, onError);
    }

    const first = latestSocket();
    await first.settle();
    let cutSocket: SessionSocket = first;
    let refresh: Promise<unknown> | undefined;

    switch (transition) {
      case "reset": {
        first.close();
        await first.settle();
        await write({ channelId: 1n, body: "one" });
        await write({ channelId: 1n, body: "two" });
        const previousCount = sockets.length;
        clock.advance(1);
        cutSocket = sockets[previousCount]!;
        cutSocket.cutNextTransition("reset", phase);
        await cutSocket.settle();
        break;
      }
      case "update":
        cutSocket = first;
        cutSocket.cutNextTransition("update", phase);
        await write({ channelId: 1n, body: "one" });
        await cutSocket.settle();
        break;
      case "checkpoint":
        cutSocket = first;
        cutSocket.cutNextTransition("checkpoint", phase);
        await write({ channelId: 1n, body: "second" });
        await cutSocket.settle();
        break;
      case "resume": {
        first.close();
        await first.settle();
        const previousCount = sockets.length;
        clock.advance(1);
        cutSocket = sockets[previousCount]!;
        cutSocket.cutNextTransition("resume", phase);
        await cutSocket.settle();
        break;
      }
      case "revoked":
        cutSocket = first;
        cutSocket.cutNextTransition("revoked", phase);
        refresh = client.refreshCredential({ kind: "bearer", token: "bob" });
        void refresh.catch(() => {});
        await waitForTransitionAttempt(cutSocket, "revoked");
        await cutSocket.settle();
        break;
    }

    const recoverySocket = await reconnect();
    await refresh;
    await recoverySocket.settle();
    return {
      transition,
      phase,
      cutAttempted: cutSocket.attemptedTransitions.some(({ transition: attempted }) =>
        attempted.kind === transition
      ),
      cutApplied: cutSocket.deliveredTransitions.some(({ transition: delivered }) =>
        delivered.kind === transition
      ),
      recoveryTransitions: recoverySocket.deliveredTransitions.map(({ transition: recovered }) =>
        recovered.kind
      ),
      updates,
      errors,
    };
  } finally {
    client.close();
    await Promise.all(sockets.map((socket) => socket.settle()));
    await writer.close();
    await runtime.drain();
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Session + Runtime integration", () => {
  test("preserves exact noncanonical Session bytes in concrete Runtime telemetry", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ackerdb-runtime-session-bytes-"));
    const engine = new Engine(schema, join(directory, "data.db"));
    reconcile(engine);
    const exported: TelemetryRecord[] = [];
    const runtime = new Runtime({
      engine,
      registry: new Registry({
        messages: {
          list: query({
            access: "public",
            args: { channelId: v.bigint() },
            handler: (ctx: Ctx, args: Ctx) =>
              ctx.db.messages.query()
                .where((row: Ctx) => row.channelId.eq(args.channelId))
                .collect(),
          }),
        },
      }),
      telemetry: {
        enabled: true,
        exporter: { export: (batch) => void exported.push(...batch) },
        localSink: false,
        limits: { slowOperationMs: 0, batchIntervalMs: 60_000, sampleIntervalMs: 60_000 },
      },
      now: () => NOW,
    });
    const sink = new DeterministicSink();
    const session = new Session({ runtime, sink, source: TEST_SOURCE, clock: new FixedClock() });

    try {
      await handle(session, {
        v: PROTOCOL_VERSION,
        t: "hello",
        clientSessionId: "exact-session-bytes",
        credential: { kind: "anonymous" },
      });
      const message = {
        v: PROTOCOL_VERSION,
        t: "q" as const,
        id: 91,
        ref: "messages.list",
        args: { channelId: 1n },
      };
      const canonical = encode(message);
      const received = `${" ".repeat(137)}${canonical}`;
      const receivedBytes = Buffer.byteLength(received);
      expect(receivedBytes).toBeGreaterThan(Buffer.byteLength(canonical));

      await session.handle(received);
      await runtime.telemetry.flush();
      const requestSpans = exported.filter((record): record is TelemetrySpanRecord =>
        record.kind === "span" && record.requestId === "91"
      );
      expect(requestSpans.find((span) => span.stage === "admission")?.sizeBytes).toBe(receivedBytes);
      expect(requestSpans.find((span) => span.stage === "queue")?.sizeBytes).toBe(receivedBytes);
    } finally {
      await session.close();
      await runtime.drain();
      engine.close("clean");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reconnects safely immediately before and after every query transition kind", async () => {
    for (const [transition, phase, recoveryTransitions, updates, errors] of RECONNECT_TRANSITION_CASES) {
      expect(await reconnectTransitionEvidence(transition, phase)).toEqual({
        transition,
        phase,
        cutAttempted: true,
        cutApplied: phase === "after",
        recoveryTransitions,
        updates,
        errors,
      });
    }
  });

  test("orders convergence, replay, and auth-epoch transitions end to end", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ackerdb-runtime-session-"));
    const engine = new Engine(schema, join(directory, "data.db"));
    reconcile(engine);
    let mutationExecutions = 0;
    const registry = new Registry({
      messages: {
        list: query({
          access: "public",
          args: { channelId: v.bigint() },
          handler: (ctx: Ctx, args: Ctx) =>
            ctx.db.messages.query()
              .where((row: Ctx) => row.channelId.eq(args.channelId))
              .collect(),
        }),
        identity: query({
          access: "authenticated",
          args: {},
          handler: (ctx: Ctx) => ({ subject: ctx.auth.subject }),
        }),
        send: mutation({
          access: "public",
          args: { channelId: v.bigint(), body: v.string() },
          handler: async (ctx: Ctx, args: Ctx) => {
            mutationExecutions++;
            return ctx.db.messages.insert(args);
          },
        }),
      },
    });
    const runtime = new Runtime({
      engine,
      registry,
      verifier: new UserVerifier(),
      telemetry: false,
      now: () => NOW,
    });
    const sink = new DeterministicSink();
    const session = new Session({
      runtime,
      sink,
      source: TEST_SOURCE,
      clock: new FixedClock(),
    });

    try {
      await handle(session, {
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
        ...ALICE_AUTHENTICATION,
      }]);

      await handle(session, {
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
      await handle(session, mutation);

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

      await handle(session, { ...mutation, id: 3 });
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

      await handle(session, {
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
      await handle(session, {
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
    const directory = mkdtempSync(join(tmpdir(), "ackerdb-client-session-events-"));
    const engine = new Engine(schema, join(directory, "data.db"));
    reconcile(engine);
    const registry = new Registry({
      typing: {
        emit: mutation({
          access: "public",
          args: { channelId: v.bigint() },
          handler: async (ctx: Ctx, args: Ctx) => {
            await ctx.db.typing.insert(args);
            await ctx.db.privateTyping.insert(args);
            return null;
          },
        }),
      },
    });
    const runtime = new Runtime({
      engine,
      registry,
      verifier: new UserVerifier(),
      telemetry: false,
      now: () => NOW,
    });
    const clock = new FixedClock();
    let socket!: SessionSocket;
    const client = new AckerDBClient({
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
          source: TEST_SOURCE,
          clock,
        });
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const publicOne: AckerDBLiveEvent<{ id: bigint; channelId: bigint }>[] = [];
    const publicTwo: AckerDBLiveEvent<{ id: bigint; channelId: bigint }>[] = [];
    const privateOne: AckerDBLiveEvent<{ id: bigint; channelId: bigint }>[] = [];
    const privateErrors: AckerDBClientError[] = [];
    const malformedErrors: AckerDBClientError[] = [];

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
      expect(await refresh).toEqual({ authEpoch: 1, ...BOB_AUTHENTICATION });
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
    const directory = mkdtempSync(join(tmpdir(), "ackerdb-runtime-session-race-"));
    const engine = new Engine(schema, join(directory, "data.db"));
    reconcile(engine);
    const registry = new Registry({
      messages: {
        list: query({
          access: "public",
          args: { channelId: v.bigint() },
          handler: (ctx: Ctx, args: Ctx) =>
            ctx.db.messages.query()
              .where((row: Ctx) => row.channelId.eq(args.channelId))
              .collect(),
        }),
        send: mutation({
          access: "public",
          args: { channelId: v.bigint(), body: v.string() },
          handler: (ctx: Ctx, args: Ctx) => ctx.db.messages.insert(args),
        }),
      },
      typing: {
        emit: mutation({
          access: "public",
          args: { channelId: v.bigint() },
          handler: (ctx: Ctx, args: Ctx) => ctx.db.typing.insert(args),
        }),
      },
    });
    const verifier = new UserVerifier();
    const runtime = new Runtime({
      engine,
      registry,
      verifier,
      telemetry: false,
      now: () => NOW,
    });
    const slowSink = new DeterministicSink();
    const targetSink = new DeterministicSink();
    const callerSink = new DeterministicSink();
    const slow = new Session({ runtime, sink: slowSink, source: TEST_SOURCE, clock: new FixedClock() });
    const target = new Session({ runtime, sink: targetSink, source: TEST_SOURCE, clock: new FixedClock() });
    const caller = new Session({ runtime, sink: callerSink, source: TEST_SOURCE, clock: new FixedClock() });

    try {
      await handle(slow, {
        v: PROTOCOL_VERSION,
        t: "hello",
        clientSessionId: "slow-client",
        credential: { kind: "bearer", token: "alice" },
      });
      await handle(target, {
        v: PROTOCOL_VERSION,
        t: "hello",
        clientSessionId: "target-client",
        credential: { kind: "bearer", token: "alice" },
      });
      await handle(caller, {
        v: PROTOCOL_VERSION,
        t: "hello",
        clientSessionId: "caller-client",
        credential: { kind: "anonymous" },
      });
      for (const session of [slow, target]) {
        await handle(session, {
          v: PROTOCOL_VERSION,
          t: "sub",
          id: 10,
          ref: "messages.list",
          args: { channelId: 1n },
        });
        await handle(session, {
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
      const queryMutation = handle(caller, {
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
      await handle(target, {
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
      const eventMutation = handle(caller, {
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
      await handle(target, {
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
