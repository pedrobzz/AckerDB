import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  parseCallResponse,
  parseServerMessage,
  parseSseMessage,
  type CallResponse,
  type ServerMessage,
  type SseMessage,
} from "@dbzz/core";
import type {
  CredentialVerifier,
  PrincipalInvalidation,
  VerifiedCredential,
} from "../src/auth.ts";
import { dbz } from "../src/dbz.ts";
import { Engine } from "../src/engine.ts";
import { DbzzError } from "../src/errors.ts";
import { mutation, procedure, query, sseProcedure } from "../src/functions.ts";
import { defineServiceLimits, PRODUCTION_LIMITS } from "../src/limits.ts";
import { reconcile } from "../src/reconcile.ts";
import { Registry } from "../src/registry.ts";
import { Runtime } from "../src/runtime.ts";
import { defineEventTable, defineSchema, defineTable } from "../src/schema.ts";
import { DbzzServer, serve } from "../src/serve.ts";

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

function uuidV7(sequence: number): string {
  const timestamp = Date.now().toString(16).padStart(12, "0");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

function stalledBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0x7b]));
    },
  });
}

async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await Bun.sleep(5);
  }
}

async function within<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error("operation timed out");
    }),
  ]);
}

const limits = defineServiceLimits({
  ...PRODUCTION_LIMITS,
  maxConnections: 1,
  maxOperations: 2,
  maxOperationsPerCaller: 2,
  maxOperationsPerConnection: 2,
  readQueue: { ...PRODUCTION_LIMITS.readQueue, maxAgeMs: 50 },
  maxRequestBytes: 512,
  maxFrameBytes: 2_048,
  webSocket: {
    maxBytesPerConnection: 8_192,
    maxBytes: 32_768,
    maxStallMs: 1_000,
  },
  sse: {
    maxBytesPerStream: 4_096,
    maxBytes: 16_384,
    maxStallMs: 1_000,
  },
  gracefulShutdownMs: 100,
});

const schema = defineSchema({
  notes: defineTable({
    id: dbz.primaryKey(),
    body: dbz.string(),
    rank: dbz.bigint(),
  }).index("by_rank", ["rank"]),
  beeps: defineEventTable({
    id: dbz.primaryKey(),
    n: dbz.number(),
  }, {
    args: {},
    access: "public",
    matches: () => true,
  }),
});

// Tests exercise transport ownership, not generated application types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

let longSseStarted: Deferred<void> | null = null;
let blockedProcedureStarted: Deferred<void> | null = null;
let blockedProcedureRelease: Deferred<void> | null = null;
let blockedMutationStarted: Deferred<void> | null = null;
let blockedMutationRelease: Deferred<void> | null = null;
let blockedCredentialStarted: Deferred<void> | null = null;
let blockedCredentialRelease: Deferred<void> | null = null;

const functions = {
  notes: {
    list: query({
      access: "public",
      args: { rank: dbz.bigint() },
      handler: (ctx: Ctx, args: Ctx) =>
        ctx.db.notes.byRank((builder: Ctx) => builder.eq("rank", args.rank)).collect(),
    }),
    add: mutation({
      access: "public",
      args: { body: dbz.string(), rank: dbz.bigint() },
      handler: async (ctx: Ctx, args: Ctx) => {
        const id = await ctx.db.notes.insert(args);
        await ctx.db.beeps.insert({ n: 1 });
        return id;
      },
    }),
    echo: procedure({
      access: "public",
      args: { value: dbz.string() },
      handler: (_ctx: Ctx, args: Ctx) => args.value,
    }),
    numbers: procedure({
      access: "public",
      args: { values: dbz.array(dbz.number()) },
      handler: (_ctx: Ctx, args: Ctx) => args.values.length,
    }),
    identity: procedure({
      access: "authenticated",
      args: {},
      handler: (ctx: Ctx) => ({
        kind: ctx.auth.kind,
        subject: ctx.auth.subject,
        identity: ctx.auth.kind === "user" ? ctx.auth.identity : null,
      }),
    }),
    identityQuery: query({
      access: "authenticated",
      args: {},
      handler: (ctx: Ctx) => ({
        kind: ctx.auth.kind,
        subject: ctx.auth.subject,
        identity: ctx.auth.kind === "user" ? ctx.auth.identity : null,
      }),
    }),
    conflict: procedure({
      access: "public",
      args: {},
      handler: () => {
        throw new DbzzError("conflict", "already exists");
      },
    }),
    explode: procedure({
      access: "public",
      args: {},
      handler: () => {
        throw new Error("secret implementation detail");
      },
    }),
    chat: sseProcedure({
      access: "authenticated",
      args: { text: dbz.string() },
      yields: dbz.jsonb(),
      handler: async function* (_ctx: Ctx, args: Ctx) {
        yield { type: "text-delta", delta: args.text };
        yield { type: "usage", chunks: 1 };
      },
    }),
    failLate: sseProcedure({
      access: "public",
      args: {},
      yields: dbz.jsonb(),
      handler: async function* () {
        yield { phase: "started" };
        throw new DbzzError("unavailable", "stream failed", { resource: "sse" });
      },
    }),
    stayOpen: sseProcedure({
      access: "public",
      args: {},
      yields: dbz.jsonb(),
      handler: async function* (ctx: Ctx) {
        longSseStarted?.resolve();
        yield { phase: "started" };
        await new Promise<void>((resolve) => {
          if (ctx.abortSignal.aborted) resolve();
          else ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    }),
    block: procedure({
      access: "public",
      args: {},
      handler: async () => {
        blockedProcedureStarted?.resolve();
        await blockedProcedureRelease?.promise;
        return "released";
      },
    }),
    hold: mutation({
      access: "public",
      args: {},
      handler: async () => {
        blockedMutationStarted?.resolve();
        await blockedMutationRelease?.promise;
        return "released";
      },
    }),
  },
};

class TestVerifier implements CredentialVerifier {
  readonly revocationBound = { kind: "token-expiration" } as const;
  readonly verified: string[] = [];

  async verify(token: string): Promise<VerifiedCredential> {
    this.verified.push(token);
    const common = {
      issuer: "https://issuer.example",
      subject: token,
      expiresAt: Date.now() + 60_000,
      tokenId: `id-${token}`,
    } as const;
    switch (token) {
      case "user-token":
        return { ...common, kind: "user", claims: { role: "member" } };
      case "user-rotated-token":
        return {
          ...common,
          kind: "user",
          subject: "user-token",
          tokenId: "id-user-token-rotated",
          claims: { role: "rotated" },
        };
      case "user-two-token":
        return { ...common, kind: "user", claims: { role: "member" } };
      case "workload-token":
        return { ...common, kind: "workload", claims: { scope: "metrics dbzz:status" } };
      case "workload-alias-token":
        return { ...common, kind: "workload", claims: { scope: "dbzz:status-extra" } };
      case "blocked-token":
        blockedCredentialStarted?.resolve(undefined);
        await blockedCredentialRelease?.promise;
        return { ...common, kind: "user", claims: { role: "member" } };
      default:
        throw new DbzzError("unauthenticated", "invalid credential");
    }
  }

  subscribeInvalidation(_listener: (invalidation: PrincipalInvalidation) => void): () => void {
    return () => {};
  }
}

interface WsClient {
  readonly socket: WebSocket;
  send(frame: unknown): void;
  next(): Promise<ServerMessage>;
  closed(): Promise<CloseEvent>;
}

function rawWebSocket(url: string): Promise<WsClient> {
  const socket = new WebSocket(url);
  const frames: ServerMessage[] = [];
  const waiters: Array<(frame: ServerMessage) => void> = [];
  let closeEvent: CloseEvent | null = null;
  const closeWaiters: Array<(event: CloseEvent) => void> = [];
  socket.onmessage = (event) => {
    const frame = parseServerMessage(decode(String(event.data)));
    const waiter = waiters.shift();
    if (waiter === undefined) frames.push(frame);
    else waiter(frame);
  };
  socket.onclose = (event) => {
    closeEvent = event;
    for (const waiter of closeWaiters.splice(0)) waiter(event);
  };

  return within(new Promise<WsClient>((resolve, reject) => {
    socket.onopen = () => resolve({
      socket,
      send: (frame) => socket.send(encode(frame)),
      next: () => {
        const frame = frames.shift();
        return frame === undefined
          ? new Promise<ServerMessage>((accept) => waiters.push(accept))
          : Promise.resolve(frame);
      },
      closed: () => closeEvent === null
        ? new Promise<CloseEvent>((accept) => closeWaiters.push(accept))
        : Promise.resolve(closeEvent),
    });
    socket.onerror = () => reject(new Error("WebSocket connection failed"));
  }));
}

let sessionSequence = 0;

async function connectWebSocket(
  url: string,
  credential: { kind: "anonymous" } | { kind: "bearer"; token: string } = { kind: "anonymous" },
): Promise<WsClient> {
  const client = await rawWebSocket(url);
  client.send({
    v: PROTOCOL_VERSION,
    t: "hello",
    clientSessionId: `serve-test-${++sessionSequence}`,
    credential,
  });
  const welcome = await within(client.next());
  expect(welcome).toMatchObject({
    v: PROTOCOL_VERSION,
    t: "welcome",
    authEpoch: 0,
    principal: credential.kind === "anonymous" ? "anonymous" : "user",
  });
  return client;
}

function sendHeldMutation(client: WsClient, id: number): void {
  client.send({
    v: PROTOCOL_VERSION,
    t: "m",
    id,
    ref: "notes.hold",
    args: {},
    mutationRequestId: uuidV7(id),
    issuedAt: Date.now(),
  });
}

let dir: string;
let engine: Engine;
let runtime: Runtime;
let server: ReturnType<typeof serve>;
let verifier: TestVerifier;
let base: string;
let requestId: number;

beforeEach(() => {
  longSseStarted = null;
  blockedProcedureStarted = null;
  blockedProcedureRelease = null;
  blockedMutationStarted = null;
  blockedMutationRelease = null;
  blockedCredentialStarted = null;
  blockedCredentialRelease = null;
  dir = mkdtempSync(join(tmpdir(), "dbzz-serve-"));
  engine = new Engine(schema, join(dir, "data.db"));
  reconcile(engine);
  runtime = new Runtime({ engine, registry: new Registry(functions), limits, telemetry: false });
  verifier = new TestVerifier();
  server = serve({ runtime, verifier, port: 0 });
  base = `http://127.0.0.1:${server.port}`;
  requestId = 0;
});

afterEach(async () => {
  await server.drain().catch(() => {});
  await runtime.drain().catch(() => {});
  engine.close("clean");
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  ref: string,
  args: unknown,
  authorization?: string,
): Promise<{ readonly status: number; readonly frame: CallResponse }> {
  const response = await fetch(`${base}/api/call`, {
    method: "POST",
    headers: authorization === undefined ? {} : { authorization },
    body: encode({ v: PROTOCOL_VERSION, t: "call", id: ++requestId, ref, args }),
  });
  return { status: response.status, frame: parseCallResponse(decode(await response.text())) };
}

interface SseResponseReader {
  readonly streamId: string;
  next(): Promise<SseMessage | null>;
  cancel(reason?: unknown): Promise<void>;
}

function readSse(response: Response): SseResponseReader {
  const streamId = response.headers.get("x-dbzz-sse-stream");
  if (streamId === null) throw new Error("SSE response is missing its stream capability");
  if (response.body === null) throw new Error("SSE response is missing its body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  return {
    streamId,
    cancel: (reason) => reader.cancel(reason),
    next: async () => {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (!event.startsWith("data: ")) throw new Error(`invalid SSE event ${JSON.stringify(event)}`);
          return parseSseMessage(decode(event.slice(6)));
        }
        if (ended) {
          if (buffer !== "") throw new Error(`truncated SSE event ${JSON.stringify(buffer)}`);
          return null;
        }
        const chunk = await reader.read();
        if (chunk.done) {
          buffer += decoder.decode();
          ended = true;
        } else {
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      }
    },
  };
}

function acknowledgeSse(
  baseUrl: string,
  stream: string,
  message: SseMessage,
  overrides: { readonly stream?: string; readonly seq?: number; readonly proof?: string } = {},
  authorization?: string,
): Promise<Response> {
  return fetch(`${baseUrl}/api/sse/ack`, {
    method: "POST",
    headers: authorization === undefined ? {} : { authorization },
    body: encode({
      v: PROTOCOL_VERSION,
      t: "sse_ack",
      stream: overrides.stream ?? stream,
      seq: overrides.seq ?? message.seq,
      proof: overrides.proof ?? message.proof,
    }),
  });
}

describe("health and protected status", () => {
  test("owns its port through explicit startup phases and atomically activates one Runtime", async () => {
    const early = new DbzzServer({ limits, verifier, port: 0 });
    const earlyBase = `http://127.0.0.1:${early.port}`;
    const earlyDir = mkdtempSync(join(tmpdir(), "dbzz-serve-startup-"));
    let earlyEngine: Engine | undefined;
    let earlyRuntime: Runtime | undefined;
    try {
      expect(await (await fetch(`${earlyBase}/live`)).json()).toEqual({ version: 1, live: true });
      expect(early.status()).toMatchObject({
        state: "starting",
        startupPhase: "listening",
        runtime: null,
      });
      expect(Object.isFrozen(early.limits)).toBe(true);
      const listening = await fetch(`${earlyBase}/ready`);
      expect(listening.status).toBe(503);
      expect(await listening.json()).toEqual({
        version: 1,
        ready: false,
        state: "starting",
        phase: "listening",
      });

      for (const [path, init] of [
        ["/api/call", { method: "POST", body: "{" }],
        ["/api/sse", { method: "POST", body: "{" }],
        ["/status", undefined],
        ["/ws", undefined],
      ] as const) {
        const response = await fetch(`${earlyBase}${path}`, init);
        expect(response.status).toBe(503);
        expect(parseCallResponse(decode(await response.text()))).toEqual({
          v: PROTOCOL_VERSION,
          t: "err",
          id: null,
          outcome: {
            code: "unavailable",
            retryable: true,
            resource: "connection",
            message: "server is not ready",
          },
        });
      }

      const socket = new WebSocket(`ws://127.0.0.1:${early.port}/ws`);
      const wsResult = await within(new Promise<"opened" | "refused">((resolve) => {
        socket.onopen = () => resolve("opened");
        socket.onerror = () => resolve("refused");
      }));
      expect(wsResult).toBe("refused");
      socket.close();

      early.advanceStartup("loading");
      early.advanceStartup("reconciling");
      const reconciling = await fetch(`${earlyBase}/ready`);
      expect(reconciling.status).toBe(503);
      expect(await reconciling.json()).toEqual({
        version: 1,
        ready: false,
        state: "starting",
        phase: "reconciling",
      });

      earlyEngine = new Engine(schema, join(earlyDir, "data.db"));
      reconcile(earlyEngine);
      earlyRuntime = new Runtime({
        engine: earlyEngine,
        registry: new Registry(functions),
        limits,
        telemetry: false,
      });
      early.activate(earlyRuntime);

      const ready = await fetch(`${earlyBase}/ready`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ version: 1, ready: true, state: "ready" });
      expect(() => early.activate(earlyRuntime!)).toThrow("only be activated once");
      expect(() => early.advanceStartup("reconciling")).toThrow("server is not starting");
    } finally {
      await early.drain().catch(() => {});
      await earlyRuntime?.drain().catch(() => {});
      earlyEngine?.close("clean");
      rmSync(earlyDir, { recursive: true, force: true });
    }
  });

  test("exposes detail-free liveness/readiness, removes /health, and follows Runtime readiness", async () => {
    expect(await (await fetch(`${base}/live`)).json()).toEqual({ version: 1, live: true });
    expect(await (await fetch(`${base}/ready`)).json()).toEqual({
      version: 1,
      ready: true,
      state: "ready",
    });
    expect((await fetch(`${base}/health`)).status).toBe(404);

    await runtime.drain();
    const ready = await fetch(`${base}/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({
      version: 1,
      ready: false,
      state: "stopped",
    });
    expect(await (await fetch(`${base}/live`)).json()).toEqual({ version: 1, live: true });
  });

  test("requires a workload with the exact configured scope token", async () => {
    const anonymous = await fetch(`${base}/status`);
    expect(anonymous.status).toBe(403);

    const user = await fetch(`${base}/status`, { headers: { authorization: "Bearer user-token" } });
    expect(user.status).toBe(403);

    const alias = await fetch(`${base}/status`, {
      headers: { authorization: "Bearer workload-alias-token" },
    });
    expect(alias.status).toBe(403);

    const checkpoint = engine.checkpoint("PASSIVE");
    const response = await fetch(`${base}/status`, {
      headers: { authorization: "Bearer workload-token" },
    });
    expect(response.status).toBe(200);
    const status = decode(await response.text()) as Record<string, unknown>;
    expect(status).toMatchObject({
      version: 1,
      state: "ready",
      connections: 0,
      httpIngress: 1,
      outboundBytes: 0,
      runtime: {
        state: "ready",
        storage: {
          lastCheckpointAtMs: expect.any(Number),
          lastCheckpoint: checkpoint,
        },
        telemetryAggregates: { maxSeries: 0, overflowedRecords: 0, series: [] },
      },
    });
    expect(verifier.verified).toEqual(["user-token", "workload-alias-token", "workload-token"]);
  });

  test("validates configured status scope", () => {
    expect(() => serve({ runtime, verifier, port: 0, statusScope: "" })).toThrow(TypeError);
    expect(() => serve({ runtime, verifier, port: 0, statusScope: "two scopes" })).toThrow(TypeError);
    expect(() => serve({ runtime, verifier, port: 0, statusScope: "x".repeat(129) })).toThrow(TypeError);

    const unsafeRuntime = Object.create(runtime) as Runtime;
    Object.defineProperty(unsafeRuntime, "limits", {
      value: { ...runtime.limits, maxRequestBytes: Number.MAX_SAFE_INTEGER },
    });
    expect(() => serve({ runtime: unsafeRuntime, verifier, port: 0 })).toThrow(
      "maxRequestBytes + 1 must be a safe integer",
    );
    expect(() => new DbzzServer({
      limits: { ...limits, maxConnections: 0 },
      port: 0,
    })).toThrow("maxConnections must be a positive safe integer");
  });

  test("sanitizes Bun's last-resort fetch error boundary", async () => {
    Object.defineProperty(runtime, "status", {
      configurable: true,
      value: () => {
        throw new Error("secret stack detail");
      },
    });
    let response: Response;
    try {
      response = await fetch(`${base}/ready`);
    } finally {
      Reflect.deleteProperty(runtime, "status");
    }

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("secret stack detail");
    expect(parseCallResponse(decode(text))).toEqual({
      v: PROTOCOL_VERSION,
      t: "err",
      id: null,
      outcome: { code: "internal", retryable: false, message: "internal server error" },
    });
  });
});

describe("Protocol-2 HTTP procedures", () => {
  test("returns exact success envelopes and routes credentials through the shared verifier", async () => {
    expect(await call("notes.echo", { value: "hello" })).toEqual({
      status: 200,
      frame: { v: PROTOCOL_VERSION, t: "ok", id: 1, kind: "procedure", value: "hello" },
    });
    expect(await call("notes.identity", {}, "Bearer user-token")).toEqual({
      status: 200,
      frame: {
        v: PROTOCOL_VERSION,
        t: "ok",
        id: 2,
        kind: "procedure",
        value: { kind: "user", subject: "user-token", identity: 1n },
      },
    });
    expect(verifier.verified).toEqual(["user-token"]);
  });

  test("resolves one durable Identity for the same user over HTTP and WebSocket", async () => {
    const http = await call("notes.identity", {}, "Bearer user-token");
    expect(http.status).toBe(200);
    if (http.frame.t !== "ok") throw new Error("expected HTTP procedure success");

    const client = await connectWebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      kind: "bearer",
      token: "user-token",
    });
    client.send({ v: PROTOCOL_VERSION, t: "q", id: 1, ref: "notes.identityQuery", args: {} });
    const websocket = await within(client.next());
    expect(websocket).toMatchObject({ t: "ok", id: 1, kind: "query" });
    if (websocket.t !== "ok") throw new Error("expected WebSocket query success");

    expect(websocket.value).toEqual(http.frame.value);
    expect(http.frame.value).toEqual({
      kind: "user",
      subject: "user-token",
      identity: 1n,
    });
    expect(engine.writer.query("SELECT COUNT(*) AS count FROM _dbz_identities").get())
      .toEqual({ count: 1n });
    expect(engine.writer.query("SELECT COUNT(*) AS count FROM _dbz_identity_accounts").get())
      .toEqual({ count: 1n });

    client.socket.close();
    await within(client.closed());
  });

  test("is procedure-only and maps every outcome through its exact HTTP status", async () => {
    const wrongKind = await call("notes.list", { rank: 1n });
    expect(wrongKind.status).toBe(400);
    expect(wrongKind.frame).toMatchObject({ t: "err", id: 1, outcome: { code: "validation" } });

    const unknown = await call("notes.missing", {});
    expect(unknown.status).toBe(404);
    expect(unknown.frame).toMatchObject({ t: "err", id: 2, outcome: { code: "not_found" } });

    const unauthenticated = await call("notes.identity", {});
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.frame).toMatchObject({
      t: "err",
      id: 3,
      outcome: { code: "unauthenticated" },
    });

    const conflict = await call("notes.conflict", {});
    expect(conflict.status).toBe(409);
    expect(conflict.frame).toMatchObject({ t: "err", id: 4, outcome: { code: "conflict" } });

    const internal = await call("notes.explode", {});
    expect(internal.status).toBe(500);
    expect(internal.frame).toEqual({
      v: PROTOCOL_VERSION,
      t: "err",
      id: 5,
      outcome: { code: "internal", retryable: false, message: "internal server error" },
    });
  });

  test("admits the received HTTP bytes without rejecting a larger canonical re-encoding", async () => {
    const exponents = Array.from({ length: 60 }, () => "1e9").join(",");
    const body = `{"v":${PROTOCOL_VERSION},"t":"call","id":9,"ref":"notes.numbers","args":{"values":[${exponents}]}}`;
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(limits.maxRequestBytes);
    expect(Buffer.byteLength(encode(decode(body)))).toBeGreaterThan(limits.maxRequestBytes);

    const response = await fetch(`${base}/api/call`, { method: "POST", body });
    expect(response.status).toBe(200);
    expect(parseCallResponse(decode(await response.text()))).toMatchObject({
      t: "ok",
      id: 9,
      kind: "procedure",
      value: 60,
    });
  });

  test("strictly parses call envelopes and rejects malformed Authorization", async () => {
    const extra = await fetch(`${base}/api/call`, {
      method: "POST",
      body: encode({ v: PROTOCOL_VERSION, t: "call", id: 7, ref: "notes.echo", args: {}, extra: true }),
    });
    expect(extra.status).toBe(400);
    expect(parseCallResponse(decode(await extra.text()))).toMatchObject({
      t: "err",
      id: null,
      outcome: { code: "malformed" },
    });

    const old = await fetch(`${base}/api/call`, {
      method: "POST",
      body: encode({ v: 1, t: "call", id: 7, ref: "notes.echo", args: {} }),
    });
    expect(old.status).toBe(400);
    expect(parseCallResponse(decode(await old.text()))).toMatchObject({
      outcome: { code: "unsupported_protocol" },
    });

    const basic = await fetch(`${base}/api/call`, {
      method: "POST",
      headers: { authorization: "Basic secret" },
      body: encode({ v: PROTOCOL_VERSION, t: "call", id: 8, ref: "notes.echo", args: { value: "x" } }),
    });
    expect(basic.status).toBe(401);
    expect(parseCallResponse(decode(await basic.text()))).toMatchObject({
      t: "err",
      id: 8,
      outcome: { code: "unauthenticated" },
    });
  });

  test("bounds declared and streaming HTTP bodies before wire decode", async () => {
    const declared = await fetch(`${base}/api/call`, {
      method: "POST",
      body: "x".repeat(limits.maxRequestBytes + 1),
    });
    expect(declared.status).toBe(429);
    expect(parseCallResponse(decode(await declared.text()))).toMatchObject({
      t: "err",
      id: null,
      outcome: { code: "overloaded", resource: "operation" },
    });

    const chunkedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(limits.maxRequestBytes));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const chunked = await fetch(`${base}/api/call`, { method: "POST", body: chunkedBody });
    expect(chunked.status).toBe(429);
    expect(parseCallResponse(decode(await chunked.text()))).toMatchObject({
      outcome: { code: "overloaded", resource: "operation" },
    });

    const transportRejected = await fetch(`${base}/api/call`, {
      method: "POST",
      body: "x".repeat(limits.maxRequestBytes + 2),
    });
    expect(transportRejected.status).toBe(413);
  });

  test("globally bounds pre-body HTTP admission and rejects node saturation as 503", async () => {
    const controllers = [new AbortController(), new AbortController()];
    const stalled = controllers.map((controller) =>
      fetch(`${base}/api/call`, {
        method: "POST",
        body: stalledBody(),
        signal: controller.signal,
      }).then(
        (response) => ({ kind: "response" as const, response }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ));
    await eventually(() => server.status().httpIngress === limits.maxOperations);

    const excess = await fetch(`${base}/api/call`, {
      method: "POST",
      body: encode({ v: PROTOCOL_VERSION, t: "call", id: 1, ref: "notes.echo", args: { value: "x" } }),
    });
    expect(excess.status).toBe(503);
    expect(parseCallResponse(decode(await excess.text()))).toMatchObject({
      t: "err",
      id: null,
      outcome: { code: "overloaded", retryable: true, resource: "connection" },
    });

    for (const controller of controllers) controller.abort();
    await Promise.all(stalled);
    await eventually(() => server.status().httpIngress === 0);
  });

  test("reserves HTTP capacity across source, principal, handoff, and SSE body ownership", async () => {
    const fairDirectory = mkdtempSync(join(tmpdir(), "dbzz-http-fairness-"));
    const fairEngine = new Engine(schema, join(fairDirectory, "data.db"));
    reconcile(fairEngine);
    const fairRuntime = new Runtime({
      engine: fairEngine,
      registry: new Registry(functions),
      limits: defineServiceLimits({
        ...limits,
        maxOperationsPerCaller: 1,
        readQueue: { ...limits.readQueue, maxAgeMs: 500 },
      }),
      telemetry: false,
    });
    const fairVerifier = new TestVerifier();
    const fairServer = serve({ runtime: fairRuntime, verifier: fairVerifier, port: 0 });
    const fairBase = `http://127.0.0.1:${fairServer.port}`;
    const sourceController = new AbortController();
    const sseController = new AbortController();
    let heldProcedure: Promise<Response> | undefined;
    let heldSse: Response | undefined;
    let heldSseReader: SseResponseReader | undefined;
    const body = (id: number, ref: string, args: unknown) =>
      encode({ v: PROTOCOL_VERSION, t: "call", id, ref, args });

    try {
      const stalled = fetch(`${fairBase}/api/call`, {
        method: "POST",
        body: stalledBody(),
        signal: sourceController.signal,
      }).catch(() => undefined);
      await eventually(() => fairServer.status().httpIngress === 1);

      const spoofedSource = await fetch(`${fairBase}/api/call`, {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.99" },
        body: body(1, "notes.echo", { value: "spoofed" }),
      });
      expect(spoofedSource.status).toBe(503);
      expect(parseCallResponse(decode(await spoofedSource.text()))).toMatchObject({
        outcome: {
          code: "overloaded",
          retryable: true,
          retryAfterMs: 0,
          resource: "connection",
        },
      });
      expect(fairServer.status()).toMatchObject({
        httpIngress: 1,
        httpFairnessKeys: 1,
        httpFairShareRejections: 1,
      });
      sourceController.abort();
      await stalled;
      await eventually(() => fairServer.status().httpIngress === 0);

      blockedProcedureStarted = deferred<void>();
      blockedProcedureRelease = deferred<void>();
      heldProcedure = fetch(`${fairBase}/api/call`, {
        method: "POST",
        headers: { authorization: "Bearer user-token" },
        body: body(2, "notes.block", {}),
      });
      await blockedProcedureStarted.promise;

      const hot = await fetch(`${fairBase}/api/call`, {
        method: "POST",
        headers: { authorization: "Bearer user-rotated-token" },
        body: body(3, "notes.echo", { value: "hot" }),
      });
      expect(hot.status).toBe(429);
      expect(parseCallResponse(decode(await hot.text()))).toMatchObject({
        outcome: { code: "overloaded", retryable: true, resource: "operation" },
      });

      const cold = await fetch(`${fairBase}/api/call`, {
        method: "POST",
        headers: { authorization: "Bearer user-two-token" },
        body: body(4, "notes.echo", { value: "cold" }),
      });
      expect(cold.status).toBe(200);
      expect(parseCallResponse(decode(await cold.text()))).toMatchObject({ value: "cold" });
      expect(fairServer.status()).toMatchObject({ httpIngress: 1, httpFairnessKeys: 1 });

      blockedProcedureRelease.resolve(undefined);
      expect((await heldProcedure).status).toBe(200);
      heldProcedure = undefined;
      await eventually(() => fairServer.status().httpIngress === 0);

      longSseStarted = deferred<void>();
      heldSse = await fetch(`${fairBase}/api/sse`, {
        method: "POST",
        headers: { authorization: "Bearer user-token" },
        body: body(5, "notes.stayOpen", {}),
        signal: sseController.signal,
      });
      await longSseStarted.promise;
      expect(heldSse.status).toBe(200);
      expect(fairServer.status()).toMatchObject({ httpIngress: 0, httpFairnessKeys: 0 });
      expect(fairRuntime.status()).toMatchObject({ activeOperations: 1, activeOperationCallers: 1 });
      heldSseReader = readSse(heldSse);
      const started = await heldSseReader.next();
      expect(started).toMatchObject({ t: "sse_chunk", value: { phase: "started" } });
      const verifiedBeforeAck = [...fairVerifier.verified];
      const credit = await acknowledgeSse(
        fairBase,
        heldSseReader.streamId,
        started!,
        {},
        "Bearer must-not-be-verified",
      );
      expect(credit.status).toBe(204);
      expect(await credit.text()).toBe("");
      expect(fairVerifier.verified).toEqual(verifiedBeforeAck);
      expect(fairServer.status()).toMatchObject({ httpIngress: 0, httpFairnessKeys: 0 });

      const whileStreaming = await fetch(`${fairBase}/api/call`, {
        method: "POST",
        headers: { authorization: "Bearer user-token" },
        body: body(6, "notes.echo", { value: "streaming" }),
      });
      expect(whileStreaming.status).toBe(429);
      expect(parseCallResponse(decode(await whileStreaming.text()))).toMatchObject({
        outcome: { code: "overloaded", resource: "operation" },
      });

      sseController.abort("test cancellation");
      await heldSseReader.cancel("test cancellation").catch(() => {});
      heldSseReader = undefined;
      heldSse = undefined;
      await eventually(() =>
        fairServer.status().httpIngress === 0 &&
        fairRuntime.status().activeOperationCallers === 0
      );
      const afterCancel = await fetch(`${fairBase}/api/call`, {
        method: "POST",
        headers: { authorization: "Bearer user-token" },
        body: body(7, "notes.echo", { value: "released" }),
      });
      expect(afterCancel.status).toBe(200);
      expect(parseCallResponse(decode(await afterCancel.text()))).toMatchObject({ value: "released" });
    } finally {
      sourceController.abort();
      sseController.abort("test cleanup");
      blockedProcedureRelease?.resolve(undefined);
      await heldSseReader?.cancel("test cleanup").catch(() => {});
      await heldProcedure?.catch(() => {});
      await fairServer.drain().catch(() => {});
      await fairRuntime.drain().catch(() => {});
      fairEngine.close("clean");
      rmSync(fairDirectory, { recursive: true, force: true });
    }
  });

  test("cancels a slow request body at the finite ingress deadline", async () => {
    const startedAt = performance.now();
    const response = await fetch(`${base}/api/call`, {
      method: "POST",
      body: stalledBody(),
    });
    const elapsed = performance.now() - startedAt;

    expect(response.status).toBe(504);
    expect(parseCallResponse(decode(await response.text()))).toMatchObject({
      t: "err",
      id: null,
      outcome: { code: "deadline_exceeded", resource: "operation" },
    });
    expect(elapsed).toBeGreaterThanOrEqual(limits.readQueue.maxAgeMs - 15);
    expect(elapsed).toBeLessThan(limits.readQueue.maxAgeMs + 500);
    expect(server.status().httpIngress).toBe(0);
  });
});

describe("SSE", () => {
  test("routes capability ACKs without oracles and keeps the registry through terminal credit", async () => {
    const denied = await fetch(`${base}/api/sse`, {
      method: "POST",
      body: encode({ v: PROTOCOL_VERSION, t: "call", id: 1, ref: "notes.chat", args: { text: "no" } }),
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("content-type")).toStartWith("application/json");
    expect(parseCallResponse(decode(await denied.text()))).toMatchObject({
      t: "err",
      id: 1,
      outcome: { code: "unauthenticated" },
    });

    const success = await fetch(`${base}/api/sse`, {
      method: "POST",
      headers: { authorization: "Bearer user-token" },
      body: encode({
        v: PROTOCOL_VERSION,
        t: "call",
        id: 2,
        ref: "notes.chat",
        args: { text: "hello" },
      }),
    });
    expect(success.status).toBe(200);
    expect(success.headers.get("content-type")).toStartWith("text/event-stream");
    expect(success.headers.get("x-vercel-ai-ui-message-stream")).toBeNull();
    expect(success.headers.get("x-dbzz-sse-stream")).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(success.headers.get("x-dbzz-sse-max-stall-ms")).toBe(String(limits.sse.maxStallMs));
    expect(success.headers.get("access-control-expose-headers")).toBe(
      "x-dbzz-sse-stream, x-dbzz-sse-max-stall-ms",
    );
    expect(server.status()).toMatchObject({ httpIngress: 0, httpFairnessKeys: 0 });
    expect(runtime.status().activeSse).toBe(1);

    const reader = readSse(success);
    const first = await reader.next();
    expect(first).toMatchObject({ t: "sse_chunk", seq: 1, value: { type: "text-delta", delta: "hello" } });
    expect((await acknowledgeSse(base, reader.streamId, first!)).status).toBe(204);
    const second = await reader.next();
    expect(second).toMatchObject({ t: "sse_chunk", seq: 2, value: { type: "usage", chunks: 1 } });
    const beforeNoops = runtime.status().sseBudget.bytes;
    const verifiedBeforeAcks = [...verifier.verified];
    for (const response of [
      await acknowledgeSse(base, reader.streamId, second!, {
        stream: "AAAAAAAAAAAAAAAAAAAAAA",
      }, "Bearer ack-must-not-verify"),
      await acknowledgeSse(base, reader.streamId, second!, { proof: `${second!.proof}x` }),
      await acknowledgeSse(base, reader.streamId, second!, { seq: second!.seq + 100 }),
    ]) {
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    }
    expect(verifier.verified).toEqual(verifiedBeforeAcks);
    expect(runtime.status().sseBudget.bytes).toBe(beforeNoops);
    expect(server.status()).toMatchObject({ sseAckIngress: 4, sseAckNoops: 3 });

    const credited = await acknowledgeSse(base, reader.streamId, second!);
    expect(credited.status).toBe(204);
    expect(runtime.status().sseBudget.bytes).toBeLessThan(beforeNoops);
    const terminal = await reader.next();
    expect(terminal).toMatchObject({ t: "sse_done", seq: 3 });
    expect(runtime.status().activeSse).toBe(1);
    expect((await acknowledgeSse(base, reader.streamId, terminal!)).status).toBe(204);
    expect(await reader.next()).toBeNull();
    await eventually(() => runtime.status().activeSse === 0);
    expect(runtime.status().sseBudget.bytes).toBe(0);

    const stale = await acknowledgeSse(base, reader.streamId, terminal!);
    expect(stale.status).toBe(204);
    expect(await stale.text()).toBe("");
    expect(server.status()).toMatchObject({ sseAckIngress: 7, sseAckNoops: 4 });

    const malformed = await fetch(`${base}/api/sse/ack`, {
      method: "POST",
      body: encode({
        v: PROTOCOL_VERSION,
        t: "sse_ack",
        stream: reader.streamId,
        seq: terminal!.seq,
        proof: terminal!.proof,
        extra: true,
      }),
    });
    expect(malformed.status).toBe(400);
    expect(parseCallResponse(decode(await malformed.text()))).toMatchObject({
      t: "err",
      id: null,
      outcome: { code: "malformed" },
    });
    expect(server.status()).toMatchObject({
      httpIngress: 0,
      httpFairnessKeys: 0,
      sseAckIngress: 8,
      sseAckNoops: 4,
    });

    const preflight = await fetch(`${base}/api/sse/ack`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-expose-headers")).toContain("x-dbzz-sse-stream");
    const wrongMethod = await fetch(`${base}/api/sse/ack`);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");

    const late = await fetch(`${base}/api/sse`, {
      method: "POST",
      body: encode({ v: PROTOCOL_VERSION, t: "call", id: 3, ref: "notes.failLate", args: {} }),
    });
    expect(late.status).toBe(200);
    const lateReader = readSse(late);
    const lateStarted = await lateReader.next();
    expect(lateStarted).toMatchObject({
      t: "sse_chunk",
      value: { phase: "started" },
    });
    // Crediting the chunk advances the handler into its failure.
    expect((await acknowledgeSse(base, lateReader.streamId, lateStarted!)).status).toBe(204);
    const failure = await lateReader.next();
    expect(failure).toMatchObject({
      t: "sse_error",
      outcome: { code: "unavailable", resource: "sse" },
    });
    expect((await acknowledgeSse(base, lateReader.streamId, failure!)).status).toBe(204);
    expect(await lateReader.next()).toBeNull();
    expect(verifier.verified).toEqual(["user-token"]);
  });
});

describe("WebSocket Session transport", () => {
  test("handles hello, query, subscription, mutation, and filtered event contracts", async () => {
    const client = await connectWebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      kind: "bearer",
      token: "user-token",
    });
    expect(verifier.verified).toEqual(["user-token"]);

    client.send({ v: PROTOCOL_VERSION, t: "q", id: 1, ref: "notes.list", args: { rank: 1n } });
    expect(await within(client.next())).toEqual({
      v: PROTOCOL_VERSION,
      t: "ok",
      id: 1,
      kind: "query",
      value: [],
    });

    client.send({ v: PROTOCOL_VERSION, t: "sub", id: 2, ref: "notes.list", args: { rank: 1n } });
    expect(await within(client.next())).toMatchObject({
      t: "transition",
      id: 2,
      transition: { kind: "reset", value: [] },
    });

    client.send({ v: PROTOCOL_VERSION, t: "sub", id: 3, ref: "events.beeps", args: {} });
    expect(await within(client.next())).toMatchObject({
      t: "event",
      id: 3,
      event: { kind: "reset" },
    });

    const mutationRequestId = uuidV7(1);
    client.send({
      v: PROTOCOL_VERSION,
      t: "m",
      id: 4,
      ref: "notes.add",
      args: { body: "one", rank: 1n },
      mutationRequestId,
      issuedAt: Date.now(),
    });
    const delivered = [
      await within(client.next()),
      await within(client.next()),
      await within(client.next()),
    ];
    expect(delivered.find((frame) => frame.t === "transition")).toMatchObject({
      t: "transition",
      id: 2,
      transition: { kind: "update", value: [{ id: 1n, body: "one", rank: 1n }] },
    });
    expect(delivered.find((frame) => frame.t === "event")).toMatchObject({
      t: "event",
      id: 3,
      event: { kind: "row", row: { id: 1n, n: 1 } },
    });
    expect(delivered.find((frame) => frame.t === "ok")).toMatchObject({
      t: "ok",
      id: 4,
      kind: "mutation",
      value: 1n,
      receipt: { mutationRequestId, replay: "executed", obligations: [2] },
    });

    client.socket.close();
    await within(client.closed());
    await eventually(() => server.status().connections === 0);
    expect(runtime.status().connections).toBe(0);
  });

  test("accepts exact-limit noncanonical text and rejects the next received byte", async () => {
    const client = await rawWebSocket(`ws://127.0.0.1:${server.port}/ws`);
    client.send({
      v: PROTOCOL_VERSION,
      t: "hello",
      clientSessionId: "raw-request-byte-limit",
      credential: { kind: "anonymous" },
    });
    expect(await within(client.next())).toMatchObject({ t: "welcome" });

    const canonical = encode({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 1,
      ref: "notes.list",
      args: { rank: 1n },
    });
    const canonicalBytes = Buffer.byteLength(canonical);
    expect(canonicalBytes).toBeLessThan(limits.maxRequestBytes);
    const exact = " ".repeat(limits.maxRequestBytes - canonicalBytes) + canonical;
    expect(Buffer.byteLength(exact)).toBe(limits.maxRequestBytes);

    client.socket.send(exact);
    expect(await within(client.next())).toMatchObject({
      v: PROTOCOL_VERSION,
      t: "ok",
      id: 1,
      kind: "query",
      value: [],
    });

    const oneByteOver = ` ${exact}`;
    expect(Buffer.byteLength(oneByteOver)).toBe(limits.maxRequestBytes + 1);
    expect(Buffer.byteLength(oneByteOver)).toBeLessThanOrEqual(limits.maxFrameBytes);

    client.socket.send(oneByteOver);
    expect(await within(client.next())).toMatchObject({
      v: PROTOCOL_VERSION,
      t: "err",
      id: null,
      outcome: { code: "overloaded", resource: "operation" },
    });
    expect((await within(client.closed())).code).toBe(1013);
  });

  test("accepts valid binary UTF-8 at the exact request limit", async () => {
    const client = await rawWebSocket(`ws://127.0.0.1:${server.port}/ws`);
    client.send({
      v: PROTOCOL_VERSION,
      t: "hello",
      clientSessionId: "binary-request-byte-limit",
      credential: { kind: "anonymous" },
    });
    expect(await within(client.next())).toMatchObject({ t: "welcome" });

    const mutationRequestId = uuidV7(2);
    const canonical = encode({
      v: PROTOCOL_VERSION,
      t: "m",
      id: 2,
      ref: "notes.add",
      args: { body: "é", rank: 1n },
      mutationRequestId,
      issuedAt: Date.now(),
    });
    const exact = " ".repeat(limits.maxRequestBytes - Buffer.byteLength(canonical)) + canonical;
    const binary = new TextEncoder().encode(exact);
    expect(binary.byteLength).toBe(limits.maxRequestBytes);

    client.socket.send(binary);
    expect(await within(client.next())).toMatchObject({
      v: PROTOCOL_VERSION,
      t: "ok",
      id: 2,
      kind: "mutation",
      value: 1n,
      receipt: { mutationRequestId },
    });
    client.socket.close();
    await within(client.closed());
  });

  test("rejects invalid binary UTF-8 before Protocol-2 decoding", async () => {
    const client = await rawWebSocket(`ws://127.0.0.1:${server.port}/ws`);
    client.socket.send(new Uint8Array([0xc3, 0x28]));

    expect(await within(client.next())).toMatchObject({
      v: PROTOCOL_VERSION,
      t: "err",
      id: null,
      outcome: { code: "malformed" },
    });
    expect((await within(client.closed())).code).toBe(1002);
  });

  test("bounds malformed and one-byte-over frames, then lets Bun reject larger payloads", async () => {
    const malformed = await rawWebSocket(`ws://127.0.0.1:${server.port}/ws`);
    malformed.socket.send("{");
    expect(await within(malformed.next())).toMatchObject({
      v: PROTOCOL_VERSION,
      t: "err",
      id: null,
      outcome: { code: "malformed" },
    });
    expect((await within(malformed.closed())).code).toBe(1002);
    await eventually(() => server.status().connections === 0);

    const oneByteOver = await rawWebSocket(`ws://127.0.0.1:${server.port}/ws`);
    oneByteOver.socket.send("x".repeat(limits.maxFrameBytes + 1));
    expect(await within(oneByteOver.next())).toMatchObject({
      v: PROTOCOL_VERSION,
      t: "err",
      id: null,
      outcome: { code: "overloaded", resource: "connection" },
    });
    expect((await within(oneByteOver.closed())).code).toBe(1013);
    await eventually(() => server.status().connections === 0);

    const oversized = await rawWebSocket(`ws://127.0.0.1:${server.port}/ws`);
    oversized.socket.send("x".repeat(limits.maxFrameBytes + 2));
    const result = await within(Promise.race([
      oversized.next().then((frame) => ({ kind: "frame" as const, frame })),
      oversized.closed().then((event) => ({ kind: "closed" as const, event })),
    ]));
    expect(result.kind).toBe("closed");
    if (result.kind === "closed") expect(result.event.code).toBe(1006);
  });

  test("counts upgraded pre-hello sockets against connection admission", async () => {
    const first = await rawWebSocket(`ws://127.0.0.1:${server.port}/ws`);
    expect(server.status().connections).toBe(1);

    const second = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const opened = await within(new Promise<boolean>((resolve) => {
      second.onopen = () => resolve(true);
      second.onerror = () => resolve(false);
      second.onclose = () => resolve(false);
    }));
    expect(opened).toBe(false);
    expect(server.status().connections).toBe(1);

    first.socket.close();
    await within(first.closed());
    await eventually(() => server.status().connections === 0);
  });

  test("shares caller capacity across WebSocket connections, HTTP, and anonymous source", async () => {
    const fairDirectory = mkdtempSync(join(tmpdir(), "dbzz-ws-fairness-"));
    const fairEngine = new Engine(schema, join(fairDirectory, "data.db"));
    reconcile(fairEngine);
    const fairLimits = defineServiceLimits({
      ...limits,
      maxConnections: 4,
      maxOperations: 3,
      maxOperationsPerCaller: 2,
      maxOperationsPerConnection: 2,
      gracefulShutdownMs: 1_000,
    });
    const fairRuntime = new Runtime({
      engine: fairEngine,
      registry: new Registry(functions),
      limits: fairLimits,
      telemetry: false,
    });
    const fairServer = serve({ runtime: fairRuntime, verifier: new TestVerifier(), port: 0 });
    const fairBase = `http://127.0.0.1:${fairServer.port}`;
    const wsUrl = `ws://127.0.0.1:${fairServer.port}/ws`;
    const clients: WsClient[] = [];
    const body = (id: number, ref = "notes.echo", args: unknown = { value: "ok" }) =>
      encode({ v: PROTOCOL_VERSION, t: "call", id, ref, args });

    try {
      const first = await connectWebSocket(wsUrl, { kind: "bearer", token: "user-token" });
      const second = await connectWebSocket(wsUrl, { kind: "bearer", token: "user-rotated-token" });
      const excess = await connectWebSocket(wsUrl, { kind: "bearer", token: "user-token" });
      const cold = await connectWebSocket(wsUrl, { kind: "bearer", token: "user-two-token" });
      clients.push(first, second, excess, cold);
      blockedMutationStarted = deferred<void>();
      blockedMutationRelease = deferred<void>();
      sendHeldMutation(first, 101);
      await blockedMutationStarted.promise;
      sendHeldMutation(second, 102);
      await eventually(() => fairRuntime.status().activeOperations === 2);
      expect(fairRuntime.status()).toMatchObject({
        activeOperations: 2,
        activeOperationCallers: 1,
      });

      excess.send({ v: PROTOCOL_VERSION, t: "q", id: 103, ref: "notes.list", args: { rank: 1n } });
      expect(await within(excess.next())).toMatchObject({
        t: "err",
        id: 103,
        outcome: { code: "overloaded", retryable: true, resource: "operation" },
      });

      const samePrincipalHttp = await fetch(`${fairBase}/api/call`, {
        method: "POST",
        headers: { authorization: "Bearer user-rotated-token" },
        body: body(104),
      });
      expect(samePrincipalHttp.status).toBe(429);
      expect(parseCallResponse(decode(await samePrincipalHttp.text()))).toMatchObject({
        outcome: { code: "overloaded", retryable: true, resource: "operation" },
      });

      cold.send({ v: PROTOCOL_VERSION, t: "q", id: 105, ref: "notes.list", args: { rank: 1n } });
      expect(await within(cold.next())).toMatchObject({ t: "ok", id: 105, kind: "query", value: [] });
      expect(fairRuntime.status()).toMatchObject({
        activeOperations: 2,
        activeOperationCallers: 1,
      });

      blockedMutationRelease.resolve(undefined);
      expect(await within(first.next())).toMatchObject({ t: "ok", id: 101, kind: "mutation" });
      expect(await within(second.next())).toMatchObject({ t: "ok", id: 102, kind: "mutation" });
      await eventually(() =>
        fairRuntime.status().activeOperations === 0 &&
        fairRuntime.status().activeOperationCallers === 0
      );

      for (const client of clients.splice(0)) client.socket.close();
      await eventually(() =>
        fairServer.status().connections === 0 && fairRuntime.status().connections === 0
      );

      const anonymousFirst = await connectWebSocket(wsUrl);
      const anonymousSecond = await connectWebSocket(wsUrl);
      clients.push(anonymousFirst, anonymousSecond);
      blockedMutationStarted = deferred<void>();
      blockedMutationRelease = deferred<void>();
      sendHeldMutation(anonymousFirst, 201);
      await blockedMutationStarted.promise;
      sendHeldMutation(anonymousSecond, 202);
      await eventually(() => fairRuntime.status().activeOperations === 2);
      expect(fairRuntime.status().activeOperationCallers).toBe(1);

      const spoofedAnonymous = await fetch(`${fairBase}/api/call`, {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.99" },
        body: body(203),
      });
      expect(spoofedAnonymous.status).toBe(429);
      expect(parseCallResponse(decode(await spoofedAnonymous.text()))).toMatchObject({
        outcome: { code: "overloaded", retryable: true, resource: "operation" },
      });

      const verifiedCold = await fetch(`${fairBase}/api/call`, {
        method: "POST",
        headers: { authorization: "Bearer user-two-token" },
        body: body(204, "notes.echo", { value: "cold" }),
      });
      expect(verifiedCold.status).toBe(200);
      expect(parseCallResponse(decode(await verifiedCold.text()))).toMatchObject({ value: "cold" });

      blockedMutationRelease.resolve(undefined);
      expect(await within(anonymousFirst.next())).toMatchObject({ t: "ok", id: 201, kind: "mutation" });
      expect(await within(anonymousSecond.next())).toMatchObject({ t: "ok", id: 202, kind: "mutation" });
      await eventually(() =>
        fairRuntime.status().activeOperations === 0 &&
        fairRuntime.status().activeOperationCallers === 0
      );
    } finally {
      blockedMutationRelease?.resolve(undefined);
      for (const client of clients) client.socket.close();
      await fairServer.drain().catch(() => {});
      await fairRuntime.drain().catch(() => {});
      fairEngine.close("clean");
      rmSync(fairDirectory, { recursive: true, force: true });
    }
  });

  test("makes overlapping ownership retryable until the old session closes", async () => {
    const overlapDir = mkdtempSync(join(tmpdir(), "dbzz-overlap-"));
    const overlapEngine = new Engine(schema, join(overlapDir, "data.db"));
    reconcile(overlapEngine);
    const overlapRuntime = new Runtime({
      engine: overlapEngine,
      registry: new Registry(functions),
      limits: defineServiceLimits({ ...limits, maxConnections: 2 }),
      telemetry: false,
    });
    const overlapServer = serve({ runtime: overlapRuntime, port: 0 });
    const url = `ws://127.0.0.1:${overlapServer.port}/ws`;
    const sessionId = "overlapping-session";
    const open = async (): Promise<WsClient> => {
      const client = await rawWebSocket(url);
      client.send({
        v: PROTOCOL_VERSION,
        t: "hello",
        clientSessionId: sessionId,
        credential: { kind: "anonymous" },
      });
      return client;
    };

    try {
      const first = await open();
      expect(await within(first.next())).toMatchObject({ t: "welcome", clientSessionId: sessionId });

      const overlapping = await open();
      expect(await within(overlapping.next())).toMatchObject({
        t: "err",
        id: null,
        outcome: {
          code: "conflict",
          retryable: true,
          retryAfterMs: 0,
          resource: "connection",
        },
      });
      await within(overlapping.closed());
      expect(overlapRuntime.status().connections).toBe(1);

      first.socket.close();
      await within(first.closed());
      await eventually(() => overlapRuntime.status().connections === 0);

      const resumed = await open();
      expect(await within(resumed.next())).toMatchObject({ t: "welcome", clientSessionId: sessionId });
      resumed.socket.close();
      await within(resumed.closed());
    } finally {
      await overlapServer.drain().catch(() => {});
      overlapEngine.close("clean");
      rmSync(overlapDir, { recursive: true, force: true });
    }
  });
});

describe("lifecycle drain", () => {
  test("stops admission, terminates WS and SSE, drains Runtime, then stops", async () => {
    const client = await connectWebSocket(`ws://127.0.0.1:${server.port}/ws`);
    longSseStarted = deferred<void>();
    const response = await fetch(`${base}/api/sse`, {
      method: "POST",
      body: encode({ v: PROTOCOL_VERSION, t: "call", id: 1, ref: "notes.stayOpen", args: {} }),
    });
    await within(longSseStarted.promise);
    expect(response.status).toBe(200);
    const sse = readSse(response);
    const started = await within(sse.next());
    expect(started).toMatchObject({ t: "sse_chunk", value: { phase: "started" } });
    expect((await acknowledgeSse(base, sse.streamId, started!)).status).toBe(204);

    const drain = server.drain();
    expect(server.state).toBe("draining");
    expect(runtime.status().state).toBe("draining");

    expect(await within(client.next())).toMatchObject({
      t: "err",
      id: null,
      outcome: {
        code: "draining",
        retryable: true,
        retryAfterMs: 1_000,
        resource: "connection",
      },
    });
    const terminal = await within(sse.next());
    expect(terminal).toMatchObject({
      t: "sse_error",
      outcome: { code: "draining", retryable: true },
    });
    expect(server.state).toBe("draining");
    const drainCredit = await acknowledgeSse(base, sse.streamId, terminal!);
    expect(drainCredit.status).toBe(204);
    expect(await sse.next()).toBeNull();

    await within(drain);
    expect(server.state).toBe("stopped");
    expect(runtime.status().state).toBe("stopped");
    expect(server.status()).toMatchObject({
      connections: 0,
      httpIngress: 0,
      httpFairnessKeys: 0,
      outboundBytes: 0,
    });
  });

  test("force closes and preserves unclean storage when an admitted operation stalls", async () => {
    blockedProcedureStarted = deferred<void>();
    blockedProcedureRelease = deferred<void>();
    const transport = fetch(`${base}/api/call`, {
      method: "POST",
      body: encode({ v: PROTOCOL_VERSION, t: "call", id: 1, ref: "notes.block", args: {} }),
    }).then(
      (response) => ({ kind: "response" as const, response }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    await within(blockedProcedureStarted.promise);

    const startedAt = performance.now();
    const draining = server.drain();
    expect(await (await fetch(`${base}/live`)).json()).toEqual({ version: 1, live: true });
    const notReady = await fetch(`${base}/ready`);
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toEqual({ version: 1, ready: false, state: "draining" });
    const refusedDuringDrain = await fetch(`${base}/api/call`, {
      method: "POST",
      body: encode({ v: PROTOCOL_VERSION, t: "call", id: 2, ref: "notes.echo", args: { value: "x" } }),
    });
    expect(refusedDuringDrain.status).toBe(503);
    expect(parseCallResponse(decode(await refusedDuringDrain.text()))).toMatchObject({
      t: "err",
      outcome: { code: "draining", retryable: true, retryAfterMs: 1_000 },
    });
    let failure: unknown;
    try {
      await draining;
    } catch (error) {
      failure = error;
    }
    const elapsed = performance.now() - startedAt;

    expect(failure).toBeInstanceOf(DbzzError);
    expect(failure).toMatchObject({
      code: "deadline_exceeded",
      message: "runtime graceful shutdown deadline exceeded",
      resource: "operation",
    });
    expect(elapsed).toBeGreaterThanOrEqual(limits.gracefulShutdownMs - 15);
    expect(elapsed).toBeLessThan(limits.gracefulShutdownMs + 500);
    expect(server.state).toBe("failed");
    const refused = await within(fetch(`${base}/live`).then(
      () => false,
      () => true,
    ));
    expect(refused).toBe(true);

    blockedProcedureRelease.resolve();
    await expect(runtime.drain()).rejects.toBe(failure);
    await within(transport);
    expect(runtime.status().state).toBe("failed");
    engine.close("unclean");
    const persisted = new Database(join(dir, "data.db"), { readonly: true, safeIntegers: true });
    try {
      expect(
        persisted.query("SELECT clean_shutdown FROM _dbz_state WHERE singleton = 1").get(),
      ).toEqual({ clean_shutdown: 0n });
    } finally {
      persisted.close();
    }
  });

  test("keeps the connection deadline when only Session shutdown stalls", async () => {
    blockedCredentialStarted = deferred<void>();
    blockedCredentialRelease = deferred<void>();
    const client = await rawWebSocket(`ws://127.0.0.1:${server.port}/ws`);
    try {
      client.send({
        v: PROTOCOL_VERSION,
        t: "hello",
        clientSessionId: "stalled-session",
        credential: { kind: "bearer", token: "blocked-token" },
      });
      await within(blockedCredentialStarted.promise);

      const startedAt = performance.now();
      let failure: unknown;
      try {
        await server.drain();
      } catch (error) {
        failure = error;
      }
      const elapsed = performance.now() - startedAt;

      expect(failure).toBeInstanceOf(DbzzError);
      expect(failure).toMatchObject({
        code: "deadline_exceeded",
        message: "graceful shutdown deadline exceeded",
        resource: "connection",
      });
      expect(elapsed).toBeGreaterThanOrEqual(limits.gracefulShutdownMs - 15);
      expect(elapsed).toBeLessThan(limits.gracefulShutdownMs + 500);
      expect(server.state).toBe("failed");
      expect(runtime.status().state).toBe("stopped");
      await expect(runtime.drain()).resolves.toBeUndefined();

      blockedCredentialRelease.resolve(undefined);
      await within(client.closed());
    } finally {
      blockedCredentialRelease.resolve(undefined);
      client.socket.close();
      await within(client.closed()).catch(() => {});
    }
  });
});
