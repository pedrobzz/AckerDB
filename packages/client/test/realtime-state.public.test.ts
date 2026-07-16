import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decode,
  parseClientMessage,
  type ClientMessage,
  type MutationOkMessage,
  type SubscriptionCursor,
  type SubscriptionTransition,
} from "@dbzz/core";
import {
  DbzzClient,
  type DbzzClientClock,
  type DbzzWebSocket,
  type DbzzWebSocketFactory,
} from "@dbzz/client";
import {
  Engine,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  dbz,
  defineSchema,
  defineServiceLimits,
  defineTable,
  mutation,
  query,
  reconcile,
  serve,
  type CredentialVerifier,
  type PrincipalInvalidation,
  type RuntimeHooks,
  type VerifiedCredential,
  type VerifiedUserCredential,
} from "@dbzz/server";
import {
  FrameProxy,
  assertTcpPortReleased,
  type ProxiedServerFrame,
} from "../../server/test/support/frame-proxy.ts";

const WAIT_DEADLINE_MS = 5_000;
const RECONNECT_DELAY_MS = 1;

function withDeadline<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), WAIT_DEADLINE_MS);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

interface ClockTask {
  at: number;
  readonly callback: () => void;
  readonly intervalMs?: number;
}

class ReconnectClock implements DbzzClientClock {
  private nextId = 0;
  private readonly tasks = new Map<number, ClockTask>();
  private readonly changes = new Set<() => void>();

  constructor(private time = Date.now()) {}

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.time + delayMs, callback });
    this.changed();
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
    this.changed();
  }

  setInterval(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.time + delayMs, callback, intervalMs: delayMs });
    this.changed();
    return id;
  }

  clearInterval(handle: unknown): void {
    this.tasks.delete(handle as number);
    this.changed();
  }

  waitForDelay(delayMs: number): Promise<void> {
    const present = (): boolean => [...this.tasks.values()].some(({ at }) => at - this.time === delayMs);
    if (present()) return Promise.resolve();
    const waiting = Promise.withResolvers<void>();
    const check = (): void => {
      if (!present()) return;
      this.changes.delete(check);
      waiting.resolve(undefined);
    };
    this.changes.add(check);
    return withDeadline(waiting.promise, `${delayMs}ms reconnect schedule`).finally(() => {
      this.changes.delete(check);
    });
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let next: [number, ClockTask] | undefined;
      for (const entry of this.tasks) {
        if (entry[1].at <= target && (next === undefined || entry[1].at < next[1].at)) next = entry;
      }
      if (next === undefined) break;
      const [id, task] = next;
      this.time = task.at;
      if (task.intervalMs === undefined) this.tasks.delete(id);
      else task.at += task.intervalMs;
      task.callback();
    }
    this.time = target;
    this.changed();
  }

  private changed(): void {
    for (const listener of [...this.changes]) listener();
  }
}

class OneShotGate {
  private armed = false;
  private paused = false;
  private readonly entered = Promise.withResolvers<void>();
  private readonly released = Promise.withResolvers<void>();

  arm(): void {
    if (this.armed || this.paused) throw new Error("gate is already armed");
    this.armed = true;
  }

  async pause(): Promise<void> {
    if (!this.armed) return;
    this.armed = false;
    this.paused = true;
    this.entered.resolve(undefined);
    await this.released.promise;
  }

  waitEntered(): Promise<void> {
    return withDeadline(this.entered.promise, "semantic gate entry");
  }

  release(): void {
    this.released.resolve(undefined);
  }
}

class ObservationLog<T> {
  readonly values: T[] = [];
  readonly errors: string[] = [];
  private readonly changes = new Set<() => void>();

  push(value: T): void {
    this.values.push(value);
    this.changed();
  }

  pushError(code: string): void {
    this.errors.push(code);
    this.changed();
  }

  waitFor(predicate: (value: T) => boolean, description: string): Promise<T> {
    const current = this.values.find(predicate);
    if (current !== undefined) return Promise.resolve(current);
    const waiting = Promise.withResolvers<T>();
    const check = (): void => {
      const value = this.values.find(predicate);
      if (value === undefined) return;
      this.changes.delete(check);
      waiting.resolve(value);
    };
    this.changes.add(check);
    return withDeadline(waiting.promise, description).finally(() => this.changes.delete(check));
  }

  private changed(): void {
    for (const listener of [...this.changes]) listener();
  }
}

interface InterceptedWrite {
  readonly connectionId: number;
  readonly message: ClientMessage;
}

class InterceptingSocket implements DbzzWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    private readonly socket: DbzzWebSocket,
    private readonly sendText: (text: string) => boolean,
  ) {
    socket.onopen = () => this.onopen?.();
    socket.onmessage = (event) => this.onmessage?.(event);
    socket.onclose = () => this.onclose?.();
    socket.onerror = () => this.onerror?.();
  }

  send(data: string): void {
    if (!this.sendText(data)) this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }
}

class BeforeWriteController {
  readonly intercepted: InterceptedWrite[] = [];
  private cut?: {
    readonly predicate: (message: ClientMessage) => boolean;
    readonly matched: PromiseWithResolvers<InterceptedWrite>;
  };
  private failure: unknown;

  constructor(private readonly proxy: FrameProxy) {}

  readonly factory: DbzzWebSocketFactory = (url) => {
    const socket = new WebSocket(url) as unknown as DbzzWebSocket;
    return new InterceptingSocket(socket, (text) => this.send(text));
  };

  cutNext(predicate: (message: ClientMessage) => boolean): Promise<InterceptedWrite> {
    if (this.cut !== undefined) throw new Error("a before-write cut is already armed");
    const matched = Promise.withResolvers<InterceptedWrite>();
    this.cut = { predicate, matched };
    return withDeadline(matched.promise, "client write interception");
  }

  assertHealthy(): void {
    if (this.failure !== undefined) throw this.failure;
  }

  private send(text: string): boolean {
    const message = parseClientMessage(decode(text));
    const cut = this.cut;
    if (cut === undefined || !cut.predicate(message)) return false;
    this.cut = undefined;
    const record = { connectionId: this.proxy.connectionsOpened, message };
    this.intercepted.push(record);
    cut.matched.resolve(record);
    queueMicrotask(() => {
      void this.proxy.dropConnections().catch((error) => {
        this.failure = error;
      });
    });
    return true;
  }
}

class TestVerifier implements CredentialVerifier {
  readonly revocationBound = { kind: "token-expiration" } as const;
  private readonly expiresAt = Date.now() + 60_000;

  async verify(token: string): Promise<VerifiedCredential> {
    const common = {
      issuer: "https://issuer.example/",
      subject: token,
      expiresAt: this.expiresAt,
      tokenId: `token-${token}`,
    } as const;
    if (token === "alice" || token === "bob") {
      return { ...common, kind: "user", claims: { role: "member" } } satisfies VerifiedUserCredential;
    }
    if (token === "status") {
      return { ...common, kind: "workload", claims: { scope: "dbzz:status" } };
    }
    throw new Error("unknown test credential");
  }

  subscribeInvalidation(_listener: (invalidation: PrincipalInvalidation) => void): () => void {
    return () => {};
  }
}

const schema = defineSchema({
  messages: defineTable({
    id: dbz.primaryKey(),
    channelId: dbz.bigint(),
    body: dbz.string(),
  }).index("by_channel", ["channelId"]),
});

// Public integration fixtures intentionally exercise inferred application handlers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

interface MessageRow {
  readonly id: bigint;
  readonly channelId: bigint;
  readonly body: string;
}

interface PublicAppOptions {
  readonly oneTransitionHistory?: boolean;
}

interface PublicApp {
  readonly snapshotGate: OneShotGate;
  readonly mutationGate: OneShotGate;
  readonly commitGate: OneShotGate;
  readonly clock: ReconnectClock;
  readonly proxy: FrameProxy;
  readonly beforeWrite: BeforeWriteController;
  readonly client: DbzzClient;
  readonly observer: DbzzClient;
  readonly base: string;
  close(): Promise<void>;
}

async function createPublicApp(options: PublicAppOptions = {}): Promise<PublicApp> {
  const snapshotGate = new OneShotGate();
  const mutationGate = new OneShotGate();
  const commitGate = new OneShotGate();
  const directory = mkdtempSync(join(tmpdir(), "dbzz-realtime-public-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const registry = new Registry({
      messages: {
        list: query({
          access: "public",
          args: { channelId: dbz.bigint() },
          handler: async (ctx: Ctx, args: Ctx) => {
            const rows = await ctx.db.messages.byChannel((builder: Ctx) =>
              builder.eq("channelId", args.channelId)
            ).collect();
            await snapshotGate.pause();
            return rows;
          },
        }),
        nonempty: query({
          access: "public",
          args: { channelId: dbz.bigint() },
          handler: async (ctx: Ctx, args: Ctx) =>
            (await ctx.db.messages.byChannel((builder: Ctx) =>
              builder.eq("channelId", args.channelId)
            ).collect()).length > 0,
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
            await mutationGate.pause();
            return ctx.db.messages.insert(args);
          },
        }),
      },
  });
  const limits = options.oneTransitionHistory
    ? defineServiceLimits({
        ...PRODUCTION_LIMITS,
        resume: { ...PRODUCTION_LIMITS.resume, maxTransitionsPerStream: 1 },
      })
    : PRODUCTION_LIMITS;
  const hooks: RuntimeHooks = {
    wait(stage, context) {
      if (stage === "commit" && context.operation === "mutation") return commitGate.pause();
    },
  };
  const runtime = new Runtime({
    engine,
    registry,
    verifier: new TestVerifier(),
    limits,
    telemetry: false,
    hooks,
  });
  const server = serve({ runtime, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const proxy = await FrameProxy.listen({ upstreamPort: server.port });
  const clock = new ReconnectClock();
  const beforeWrite = new BeforeWriteController(proxy);
  const client = new DbzzClient({
    url: proxy.url,
    credential: { kind: "bearer", token: "alice" },
    clientSessionId: `public-transition-${crypto.randomUUID()}`,
    clock,
    random: () => 0,
    reconnect: {
      baseDelayMs: RECONNECT_DELAY_MS,
      maxDelayMs: RECONNECT_DELAY_MS,
      stableOpenMs: 60_000,
    },
    createWebSocket: beforeWrite.factory,
  });
  const observer = new DbzzClient({
    url: base,
    credential: { kind: "anonymous" },
    clientSessionId: `observer-${crypto.randomUUID()}`,
  });
  const app: PublicApp = {
    snapshotGate,
    mutationGate,
    commitGate,
    clock,
    proxy,
    beforeWrite,
    client,
    observer,
    base,
    async close() {
      let failure: unknown;
      const recordFailure = (error: unknown): void => {
        failure ??= error;
      };
      snapshotGate.release();
      mutationGate.release();
      commitGate.release();
      const proxyPort = proxy.port;
      const serverPort = server.port;
      try {
        client.close();
      } catch (error) {
        recordFailure(error);
      }
      try {
        observer.close();
      } catch (error) {
        recordFailure(error);
      }
      try {
        beforeWrite.assertHealthy();
        proxy.assertBytePreserving();
      } catch (error) {
        recordFailure(error);
      }
      try {
        await proxy.close();
      } catch (error) {
        recordFailure(error);
      }
      let engineClosed = false;
      try {
        await server.drain();
        engine.close("clean");
        engineClosed = true;
      } catch (error) {
        recordFailure(error);
        if (!engineClosed) {
          try {
            engine.close("unclean");
          } catch (closeError) {
            recordFailure(closeError);
          }
        }
      }
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        recordFailure(error);
      }
      try {
        await assertTcpPortReleased(proxyPort);
      } catch (error) {
        recordFailure(error);
      }
      try {
        await assertTcpPortReleased(serverPort);
      } catch (error) {
        recordFailure(error);
      }
      if (failure !== undefined) throw failure;
    },
  };
  return app;
}

function mountMessages(app: PublicApp): ObservationLog<readonly MessageRow[]> {
  const log = new ObservationLog<readonly MessageRow[]>();
  app.client.subscribe<{ channelId: bigint }, readonly MessageRow[]>(
    "messages.list",
    { channelId: 1n },
    (value) => log.push(value),
    (error) => log.pushError(error.code),
  );
  return log;
}

function mountNonempty(app: PublicApp): ObservationLog<boolean> {
  const log = new ObservationLog<boolean>();
  app.client.subscribe<{ channelId: bigint }, boolean>(
    "messages.nonempty",
    { channelId: 1n },
    (value) => log.push(value),
    (error) => log.pushError(error.code),
  );
  return log;
}

function mountIdentity(app: PublicApp): ObservationLog<{ readonly subject: string }> {
  const log = new ObservationLog<{ readonly subject: string }>();
  app.client.subscribe<Record<string, never>, { readonly subject: string }>(
    "messages.identity",
    {},
    (value) => log.push(value),
    (error) => log.pushError(error.code),
  );
  return log;
}

async function statusConnections(app: PublicApp): Promise<number> {
  const response = await fetch(`${app.base}/status`, {
    headers: { authorization: "Bearer status" },
  });
  if (!response.ok) throw new Error(`status returned ${response.status}`);
  const body = decode(await response.text()) as { readonly connections?: unknown };
  if (typeof body.connections !== "number") throw new Error("status omitted connection count");
  return body.connections;
}

async function waitForConnections(app: PublicApp, expected: number): Promise<void> {
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  let observed = -1;
  while (Date.now() < deadline) {
    observed = await statusConnections(app);
    if (observed === expected) return;
  }
  throw new Error(`Timed out waiting for ${expected} public connections; last observed ${observed}`);
}

async function prepareReconnect(
  app: PublicApp,
  closedConnectionId: number,
  remainingServerConnections: number,
): Promise<void> {
  await app.clock.waitForDelay(RECONNECT_DELAY_MS);
  await app.proxy.waitForConnectionClosed(closedConnectionId);
  await waitForConnections(app, remainingServerConnections);
}

async function advanceReconnect(app: PublicApp): Promise<number> {
  const connectionId = app.proxy.connectionsOpened + 1;
  app.clock.advance(RECONNECT_DELAY_MS);
  await app.proxy.waitForConnection(connectionId);
  return connectionId;
}

function transitionFrame(kind: SubscriptionTransition["kind"]): (frame: ProxiedServerFrame["message"]) => boolean {
  return (message) => message.t === "transition" && message.transition.kind === kind;
}

function sameCursor(left: SubscriptionCursor, right: SubscriptionCursor): boolean {
  return left.generation === right.generation &&
    left.commitVersion === right.commitVersion &&
    left.authEpoch === right.authEpoch &&
    left.identity === right.identity;
}

function assertForwardedCursorChain(app: PublicApp): void {
  let cursor: SubscriptionCursor | null = null;
  for (const frame of app.proxy.serverFrames) {
    if (frame.forwardedBytes === undefined || frame.message.t !== "transition") continue;
    const transition = frame.message.transition;
    expect(transition.to.commitVersion).toBeGreaterThanOrEqual(transition.from?.commitVersion ?? 0n);
    if (transition.kind === "reset") {
      if (transition.from !== null && cursor !== null) expect(sameCursor(transition.from, cursor)).toBe(true);
    } else {
      expect(cursor).not.toBeNull();
      expect(cursor !== null && sameCursor(transition.from, cursor)).toBe(true);
    }
    if (cursor !== null) {
      expect(transition.to.commitVersion).toBeGreaterThanOrEqual(cursor.commitVersion);
    }
    cursor = transition.to;
  }
}

function assertInsertOnlyMessages(log: ObservationLog<readonly MessageRow[]>): void {
  let previous = new Map<bigint, MessageRow>();
  for (const rows of log.values) {
    const current = new Map<bigint, MessageRow>();
    for (const row of rows) {
      expect(current.has(row.id)).toBe(false);
      current.set(row.id, row);
    }
    expect(rows.length).toBeGreaterThanOrEqual(previous.size);
    for (const [id, row] of previous) expect(current.get(id)).toEqual(row);
    previous = current;
  }
}

interface TrackedMutation {
  readonly body: string;
  readonly promise: Promise<bigint>;
  settlements(): number;
}

function beginMutation(app: PublicApp, body: string): TrackedMutation {
  let settlements = 0;
  const promise = app.client.mutation<{ channelId: bigint; body: string }, bigint>(
    "messages.send",
    { channelId: 1n, body },
  ).then(
    (value) => {
      settlements++;
      return value;
    },
    (error) => {
      settlements++;
      throw error;
    },
  );
  return { body, promise, settlements: () => settlements };
}

function mutationRequests(app: PublicApp, body: string): Extract<ClientMessage, { t: "m" }>[] {
  const proxied = app.proxy.clientFrames.flatMap(({ message }) =>
    message.t === "m" && (message.args as { body?: unknown }).body === body ? [message] : []
  );
  const intercepted = app.beforeWrite.intercepted.flatMap(({ message }) =>
    message.t === "m" && (message.args as { body?: unknown }).body === body ? [message] : []
  );
  return [...intercepted, ...proxied];
}

function forwardedMutationAcks(app: PublicApp, requestId: string): MutationOkMessage[] {
  return app.proxy.serverFrames.flatMap(({ message, forwardedBytes }) =>
    forwardedBytes !== undefined &&
    message.t === "ok" &&
    message.kind === "mutation" &&
    message.receipt.mutationRequestId === requestId
      ? [message]
      : []
  );
}

async function assertMutation(
  app: PublicApp,
  mutationEvidence: TrackedMutation,
  expectedRequestMinimum: number,
  expectedReplay?: "executed" | "replayed",
  subscription?: ObservationLog<readonly MessageRow[]>,
): Promise<bigint> {
  const result = await withDeadline(mutationEvidence.promise, `${mutationEvidence.body} mutation settlement`);
  const requests = mutationRequests(app, mutationEvidence.body);
  expect(requests.length).toBeGreaterThanOrEqual(expectedRequestMinimum);
  expect(new Set(requests.map(({ mutationRequestId }) => mutationRequestId)).size).toBe(1);
  const requestId = requests[0]!.mutationRequestId;
  const acknowledgements = forwardedMutationAcks(app, requestId);
  expect(acknowledgements).toHaveLength(1);
  if (expectedReplay !== undefined) expect(acknowledgements[0]!.receipt.replay).toBe(expectedReplay);
  expect(mutationEvidence.settlements()).toBe(1);

  const rows = await app.observer.query<{ channelId: bigint }, readonly MessageRow[]>(
    "messages.list",
    { channelId: 1n },
  );
  const effects = rows.filter(({ body }) => body === mutationEvidence.body);
  expect(effects).toHaveLength(1);
  expect(effects[0]!.id).toBe(result);
  if (subscription !== undefined) {
    await subscription.waitFor(
      (candidate) => candidate.length === rows.length && candidate.every((row, index) =>
        row.id === rows[index]!.id &&
        row.channelId === rows[index]!.channelId &&
        row.body === rows[index]!.body
      ),
      `${mutationEvidence.body} authoritative subscribed state`,
    );
    expect(subscription.values.at(-1)).toEqual(rows);
  }
  await Promise.resolve();
  expect(mutationEvidence.settlements()).toBe(1);
  return result;
}

async function recoverCutConnection(
  app: PublicApp,
  cutConnectionId: number,
  remainingConnections: number,
  recoveryKind: SubscriptionTransition["kind"],
): Promise<number> {
  await prepareReconnect(app, cutConnectionId, remainingConnections);
  const recovery = await advanceReconnect(app);
  await app.proxy.waitForForwardedServerFrame(recovery, transitionFrame(recoveryKind));
  return recovery;
}

async function runSemanticCut(cut: number): Promise<void> {
  const app = await createPublicApp({ oneTransitionHistory: cut === 12 });
  let semanticUpdates: ObservationLog<readonly MessageRow[]> | undefined;
  try {
    if (cut >= 1 && cut <= 4) {
      let fault: Promise<{ readonly connectionId: number }> | undefined;
      if (cut === 1) {
        fault = app.beforeWrite.cutNext((message) => message.t === "sub");
      } else if (cut === 2) {
        fault = app.proxy.cutNextClientFrame((message) => message.t === "sub");
      } else if (cut === 3) {
        app.snapshotGate.arm();
      } else {
        fault = app.proxy.cutNextServerFrame(transitionFrame("reset"));
      }
      const updates = mountMessages(app);
      semanticUpdates = updates;
      let cutConnectionId: number;
      if (cut === 3) {
        await app.snapshotGate.waitEntered();
        cutConnectionId = app.proxy.connectionsOpened;
        await app.proxy.dropConnections();
        app.snapshotGate.release();
      } else {
        cutConnectionId = (await fault!).connectionId;
      }
      const recovery = await recoverCutConnection(app, cutConnectionId, 0, "reset");
      await updates.waitFor((rows) => rows.length === 0, `R2.${cut} authoritative snapshot`);
      expect(recovery).toBeGreaterThan(cutConnectionId);
      await assertMutation(app, beginMutation(app, `semantic-${cut}`), 1, "executed", updates);
      expect(updates.errors).toEqual([]);
    } else if (cut >= 5 && cut <= 10) {
      const updates = mountMessages(app);
      semanticUpdates = updates;
      await updates.waitFor((rows) => rows.length === 0, `R2.${cut} initial snapshot`);
      const baseline = await statusConnections(app);
      const body = `semantic-${cut}`;
      let mutationEvidence: TrackedMutation;
      let cutConnectionId: number;

      if (cut === 5) {
        const intercepted = app.beforeWrite.cutNext((message) => message.t === "m");
        mutationEvidence = beginMutation(app, body);
        cutConnectionId = (await intercepted).connectionId;
      } else if (cut === 6) {
        app.mutationGate.arm();
        mutationEvidence = beginMutation(app, body);
        await app.mutationGate.waitEntered();
        cutConnectionId = app.proxy.connectionsOpened;
        await app.proxy.dropConnections();
        app.mutationGate.release();
      } else if (cut === 7) {
        app.commitGate.arm();
        mutationEvidence = beginMutation(app, body);
        await app.commitGate.waitEntered();
        cutConnectionId = app.proxy.connectionsOpened;
        await app.proxy.dropConnections();
        app.commitGate.release();
      } else if (cut === 8) {
        const fault = app.proxy.cutNextServerFrame(transitionFrame("update"));
        mutationEvidence = beginMutation(app, body);
        cutConnectionId = (await fault).connectionId;
      } else if (cut === 9) {
        const heldPromise = app.proxy.holdNextServerFrame((message) =>
          message.t === "ok" && message.kind === "mutation"
        );
        mutationEvidence = beginMutation(app, body);
        const held = await heldPromise;
        await updates.waitFor(
          (rows) => rows.some(({ body: observed }) => observed === body),
          "R2.9 client application before acknowledgement",
        );
        cutConnectionId = held.frame.connectionId;
        held.drop();
      } else {
        const fault = app.proxy.cutNextServerFrame((message) =>
          message.t === "ok" && message.kind === "mutation"
        );
        mutationEvidence = beginMutation(app, body);
        cutConnectionId = (await fault).connectionId;
      }

      expect(mutationEvidence.settlements()).toBe(0);
      await recoverCutConnection(app, cutConnectionId, baseline - 1, cut <= 8 ? "update" : "resume");
      await assertMutation(
        app,
        mutationEvidence,
        2,
        cut === 5 ? "executed" : cut === 6 ? undefined : "replayed",
        updates,
      );
      expect(updates.errors).toEqual([]);
    } else if (cut === 11) {
      const updates = mountMessages(app);
      semanticUpdates = updates;
      await updates.waitFor((rows) => rows.length === 0, "R2.11 initial snapshot");
      const baseline = await statusConnections(app);
      const first = app.proxy.connectionsOpened;
      await app.proxy.dropConnections();
      await prepareReconnect(app, first, baseline - 1);
      const fault = app.proxy.cutNextServerFrame(transitionFrame("resume"));
      await advanceReconnect(app);
      const cutFrame = await fault;
      await recoverCutConnection(app, cutFrame.connectionId, baseline - 1, "resume");
      await assertMutation(app, beginMutation(app, "semantic-11"), 1, "executed", updates);
      expect(updates.errors).toEqual([]);
    } else if (cut === 12) {
      const updates = mountMessages(app);
      semanticUpdates = updates;
      await updates.waitFor((rows) => rows.length === 0, "R2.12 initial snapshot");
      const firstBaseline = await statusConnections(app);
      const first = app.proxy.connectionsOpened;
      await app.proxy.dropConnections();
      await prepareReconnect(app, first, firstBaseline - 1);
      await app.observer.mutation("messages.send", { channelId: 1n, body: "history-one" });
      await app.observer.mutation("messages.send", { channelId: 1n, body: "history-two" });
      const remaining = await statusConnections(app);
      const fault = app.proxy.cutNextServerFrame(transitionFrame("reset"));
      await advanceReconnect(app);
      const cutFrame = await fault;
      await recoverCutConnection(app, cutFrame.connectionId, remaining, "reset");
      await updates.waitFor(
        (rows) => rows.some(({ body }) => body === "history-two"),
        "R2.12 authoritative reset snapshot",
      );
      await assertMutation(app, beginMutation(app, "semantic-12"), 1, "executed", updates);
      expect(updates.errors).toEqual([]);
    } else {
      throw new Error(`unknown semantic cut ${cut}`);
    }

    if (semanticUpdates === undefined) throw new Error(`R2.${cut} omitted its public callback log`);
    assertInsertOnlyMessages(semanticUpdates);
    assertForwardedCursorChain(app);
    app.proxy.assertBytePreserving();
  } finally {
    await app.close();
  }
}

type TransitionPhase = "before" | "after";

interface TransitionCase {
  readonly kind: SubscriptionTransition["kind"];
  readonly phase: TransitionPhase;
  readonly recovery: SubscriptionTransition["kind"];
  readonly updates: readonly string[];
  readonly errors: readonly string[];
}

const TRANSITION_CASES: readonly TransitionCase[] = [
  { kind: "reset", phase: "before", recovery: "reset", updates: ["", "one,two"], errors: [] },
  { kind: "reset", phase: "after", recovery: "resume", updates: ["", "one,two"], errors: [] },
  { kind: "update", phase: "before", recovery: "update", updates: ["", "one"], errors: [] },
  { kind: "update", phase: "after", recovery: "resume", updates: ["", "one"], errors: [] },
  { kind: "checkpoint", phase: "before", recovery: "checkpoint", updates: ["true"], errors: [] },
  { kind: "checkpoint", phase: "after", recovery: "resume", updates: ["true"], errors: [] },
  { kind: "resume", phase: "before", recovery: "resume", updates: [""], errors: [] },
  { kind: "resume", phase: "after", recovery: "resume", updates: [""], errors: [] },
  { kind: "revoked", phase: "before", recovery: "reset", updates: ["alice", "bob"], errors: [] },
  { kind: "revoked", phase: "after", recovery: "reset", updates: ["alice", "bob"], errors: ["auth_stale"] },
];

async function runTransitionCase(entry: TransitionCase): Promise<void> {
  const app = await createPublicApp({ oneTransitionHistory: entry.kind === "reset" });
  let mutationEvidence: TrackedMutation | undefined;
  let refresh: Promise<unknown> | undefined;
  let stringifyUpdates: () => string[];
  let errors: string[];
  let waitForExpected: () => Promise<unknown>;
  let messageLog: ObservationLog<readonly MessageRow[]> | undefined;
  try {
    if (entry.kind === "checkpoint") {
      await app.observer.mutation("messages.send", { channelId: 1n, body: "seed" });
      const log = mountNonempty(app);
      await log.waitFor((value) => value, "checkpoint initial state");
      stringifyUpdates = () => log.values.map(String);
      errors = log.errors;
      waitForExpected = () => log.waitFor((value) => value, "checkpoint state");
    } else if (entry.kind === "revoked") {
      const log = mountIdentity(app);
      await log.waitFor(({ subject }) => subject === "alice", "initial authenticated state");
      stringifyUpdates = () => log.values.map(({ subject }) => subject);
      errors = log.errors;
      waitForExpected = () => log.waitFor(
        ({ subject }) => subject === entry.updates.at(-1),
        "rotated authenticated state",
      );
    } else {
      const log = mountMessages(app);
      messageLog = log;
      await log.waitFor((rows) => rows.length === 0, `${entry.kind} initial state`);
      const stringify = (rows: readonly MessageRow[]): string =>
        rows.map(({ body }) => body).sort().join(",");
      stringifyUpdates = () => log.values.map(stringify);
      errors = log.errors;
      waitForExpected = () => log.waitFor(
        (rows) => stringify(rows) === entry.updates.at(-1),
        `${entry.kind} authoritative state`,
      );
    }

    if (entry.kind === "reset" || entry.kind === "resume") {
      const baseline = await statusConnections(app);
      const first = app.proxy.connectionsOpened;
      await app.proxy.dropConnections();
      await prepareReconnect(app, first, baseline - 1);
      if (entry.kind === "reset") {
        await app.observer.mutation("messages.send", { channelId: 1n, body: "one" });
        await app.observer.mutation("messages.send", { channelId: 1n, body: "two" });
      }
    }

    const remaining = await statusConnections(app);
    const cut = app.proxy.cutNextServerFrame(transitionFrame(entry.kind), entry.phase);
    if (entry.kind === "reset" || entry.kind === "resume") {
      await advanceReconnect(app);
    } else if (entry.kind === "update") {
      mutationEvidence = beginMutation(app, "one");
    } else if (entry.kind === "checkpoint") {
      mutationEvidence = beginMutation(app, "second");
    } else {
      refresh = app.client.refreshCredential({ kind: "bearer", token: "bob" });
      void refresh.catch(() => {});
    }
    const cutFrame = await cut;
    const remainingAfterCut = entry.kind === "reset" || entry.kind === "resume"
      ? remaining
      : remaining - 1;
    const recovery = await recoverCutConnection(
      app,
      cutFrame.connectionId,
      remainingAfterCut,
      entry.recovery,
    );
    expect(recovery).toBeGreaterThan(cutFrame.connectionId);
    await refresh;
    if (mutationEvidence !== undefined) {
      await assertMutation(app, mutationEvidence, 2, "replayed", messageLog);
    }

    await waitForExpected();
    for (const code of entry.errors) {
      if (!errors.includes(code)) {
        throw new Error(`${entry.kind}/${entry.phase} omitted ${code}`);
      }
    }
    expect(stringifyUpdates()).toEqual([...entry.updates]);
    expect(errors).toEqual([...entry.errors]);

    if (mutationEvidence === undefined) {
      await assertMutation(
        app,
        beginMutation(app, `probe-${entry.kind}-${entry.phase}`),
        1,
        "executed",
        messageLog,
      );
    }
    assertForwardedCursorChain(app);
    app.proxy.assertBytePreserving();
  } finally {
    await app.close();
  }
}

describe("public realtime transition failure acceptance", () => {
  for (let cut = 1; cut <= 12; cut++) {
    test(`reconnects at authoritative R2 semantic cut ${cut}`, () => runSemanticCut(cut), 15_000);
  }
  for (const entry of TRANSITION_CASES) {
    test(
      `reconnects ${entry.phase} ${entry.kind}`,
      () => runTransitionCase(entry),
      15_000,
    );
  }
});
