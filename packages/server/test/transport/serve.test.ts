import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Err,
  ACKERDB_VERSION,
  Status,
  decode,
  encode,
  parseServerHandshake,
  parseServerMessage,
  parseSseMessage,
  type ServerMessage,
  type SseMessage,
} from "@ackerdb/core";
import type {
  CredentialVerifier,
  PrincipalInvalidation,
  VerifiedCredential,
} from "../../src/auth/credentials.ts";
import { v } from "../../src/validation/v.ts";
import { Engine } from "../../src/database/engine.ts";
import { AckerDBError } from "../../src/shared/errors.ts";
import { mutation, procedure, query, sseProcedure } from "../../src/app/functions.ts";
import { defineServiceLimits, PRODUCTION_LIMITS } from "../../src/runtime/limits.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineEventTable, defineSchema, defineTable } from "../../src/schema/definition.ts";
import { openApiBytes, openApiDocument } from "../../src/transport/openapi.ts";
import { AckerDBServer } from "../../src/transport/server.ts";
import { deferred, within, type Deferred } from "ackerdb-test-support/async";

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
    id: v.primaryKey(),
    body: v.string(),
    rank: v.bigint(),
  }).index(["rank"]),
  beeps: defineEventTable({
    id: v.primaryKey(),
    n: v.float(),
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
      http: true,
      args: { rank: v.bigint() },
      handler: (ctx: Ctx, args: Ctx) =>
        ctx.db.notes.query().where((row: Ctx) => row.rank.eq(args.rank)).collect(),
    }),
    add: mutation({
      access: "public",
      http: true,
      args: { body: v.string(), rank: v.bigint() },
      handler: async (ctx: Ctx, args: Ctx) => {
        const id = await ctx.db.notes.insert(args);
        await ctx.db.beeps.insert({ n: 1 });
        return id;
      },
    }),
    /** A second writer with the same args, so a key can differ by function alone. */
    beep: mutation({
      access: "public",
      http: true,
      args: { body: v.string(), rank: v.bigint() },
      handler: async (ctx: Ctx, args: Ctx) => {
        await ctx.db.beeps.insert({ n: Number(args.rank) });
        return args.body;
      },
    }),
    rejectMutation: mutation({
      access: "public",
      http: true,
      args: {},
      errors: {
        "notes.gone": { body: v.object({ reason: v.string() }), status: Status.Gone },
      },
      handler: () => Err("notes.gone", { reason: "purged" }, Status.Gone),
    }),
    /** Writes, then declares an error: `rollbackWhen` must discard the write. */
    rejectAfterWrite: mutation({
      access: "public",
      http: true,
      args: { body: v.string(), rank: v.bigint() },
      errors: {
        "notes.gone": { body: v.object({ reason: v.string() }), status: Status.Gone },
      },
      handler: async (ctx: Ctx, args: Ctx) => {
        await ctx.db.notes.insert(args);
        return Err("notes.gone", { reason: "purged" }, Status.Gone);
      },
    }),
    /** Writes, then returns a declared value no single frame can carry. */
    addOversized: mutation({
      access: "public",
      http: true,
      args: { body: v.string(), rank: v.bigint() },
      returns: v.string(),
      handler: async (ctx: Ctx, args: Ctx) => {
        await ctx.db.notes.insert(args);
        return "x".repeat(limits.maxFrameBytes * 2);
      },
    }),
    /** Writes, then returns a value no `returns` describes and no JSON carries. */
    addUnencodable: mutation({
      access: "public",
      http: true,
      args: { body: v.string(), rank: v.bigint() },
      handler: async (ctx: Ctx, args: Ctx) => {
        await ctx.db.notes.insert(args);
        return Number.NaN;
      },
    }),
    echo: procedure({
      access: "public",
      http: true,
      args: { value: v.string() },
      handler: (_ctx: Ctx, args: Ctx) => args.value,
    }),
    hidden: procedure({
      access: "public",
      args: { value: v.string() },
      handler: (_ctx: Ctx, args: Ctx) => args.value,
    }),
    numbers: procedure({
      access: "public",
      http: { openapi: false },
      args: { values: v.array(v.float()) },
      handler: (_ctx: Ctx, args: Ctx) => args.values.length,
    }),
    identity: procedure({
      access: "authenticated",
      http: true,
      args: {},
      handler: (ctx: Ctx) => ({
        kind: ctx.auth.kind,
        subject: ctx.auth.subject,
        identity: ctx.auth.kind === "user" ? ctx.auth.identity : null,
      }),
    }),
    identityQuery: query({
      access: "authenticated",
      http: true,
      args: {},
      handler: (ctx: Ctx) => ({
        kind: ctx.auth.kind,
        subject: ctx.auth.subject,
        identity: ctx.auth.kind === "user" ? ctx.auth.identity : null,
      }),
    }),
    conflict: procedure({
      access: "public",
      http: true,
      args: {},
      handler: () => {
        throw new AckerDBError("conflict", "already exists");
      },
    }),
    explode: procedure({
      access: "public",
      http: true,
      args: {},
      handler: () => {
        throw new Error("secret implementation detail");
      },
    }),
    chat: sseProcedure({
      access: "authenticated",
      http: true,
      args: { text: v.string() },
      yields: v.jsonb(),
      handler: async function* (_ctx: Ctx, args: Ctx) {
        yield { type: "text-delta", delta: args.text };
        yield { type: "usage", chunks: 1 };
      },
    }),
    hiddenChat: sseProcedure({
      access: "public",
      args: {},
      yields: v.jsonb(),
      handler: async function* () {
        yield { phase: "unreachable" };
      },
    }),
    badChunk: sseProcedure({
      access: "public",
      http: true,
      args: {},
      yields: v.object({ value: v.string() }),
      handler: async function* () {
        yield { value: "first" };
        yield { value: 2 as unknown as string };
      },
    }),
    failLate: sseProcedure({
      access: "public",
      http: true,
      args: {},
      yields: v.jsonb(),
      handler: async function* () {
        yield { phase: "started" };
        throw new AckerDBError("unavailable", "stream failed", { resource: "sse" });
      },
    }),
    stayOpen: sseProcedure({
      access: "public",
      http: true,
      args: {},
      yields: v.jsonb(),
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
      http: true,
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
  ops: {
    count: query({
      access: "public",
      http: true,
      args: {},
      handler: (ctx: Ctx) => ctx.db.notes.query().count(),
    }),
    purge: mutation({
      access: "system",
      http: true,
      args: {},
      handler: () => "purged",
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
        return { ...common, kind: "workload", claims: { scope: "metrics ackerdb:status" } };
      case "workload-alias-token":
        return { ...common, kind: "workload", claims: { scope: "ackerdb:status-extra" } };
      case "blocked-token":
        blockedCredentialStarted?.resolve(undefined);
        await blockedCredentialRelease?.promise;
        return { ...common, kind: "user", claims: { role: "member" } };
      default:
        throw new AckerDBError("unauthenticated", "invalid credential");
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
  // The reader mirrors the client's own two phases: nothing but the versioned
  // handshake pair decodes until a welcome has landed.
  let open = false;
  socket.onmessage = (event) => {
    const text = decode(String(event.data));
    const frame = open ? parseServerMessage(text) : parseServerHandshake(text);
    if (frame.t === "welcome") open = true;
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
    v: ACKERDB_VERSION,
    t: "hello",
    clientSessionId: `serve-test-${++sessionSequence}`,
    credential,
  });
  const welcome = await within(client.next());
  expect(welcome).toMatchObject({
    v: ACKERDB_VERSION,
    t: "welcome",
    authEpoch: 0,
    principal: credential.kind === "anonymous" ? "anonymous" : "user",
  });
  return client;
}

function sendHeldMutation(client: WsClient, id: number): void {
  client.send({
    t: "m",
    id,
    ref: "api.notes.hold",
    args: {},
    mutationRequestId: uuidV7(id),
    issuedAt: Date.now(),
  });
}

let dir: string;
let engine: Engine;
let runtime: Runtime;
let server: AckerDBServer;
let verifier: TestVerifier;
let base: string;

beforeEach(async () => {
  longSseStarted = null;
  blockedProcedureStarted = null;
  blockedProcedureRelease = null;
  blockedMutationStarted = null;
  blockedMutationRelease = null;
  blockedCredentialStarted = null;
  blockedCredentialRelease = null;
  dir = mkdtempSync(join(tmpdir(), "ackerdb-serve-"));
  engine = new Engine(schema, join(dir, "data.db"));
  reconcile(engine);
  verifier = new TestVerifier();
  server = new AckerDBServer({ limits, port: 0 });
  runtime = new Runtime({
    engine,
    registry: server.loadFunctionModules(functions),
    verifier,
    limits,
  });
  await runtime.start();
  server.activate(runtime);
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.drain().catch(() => {});
  await runtime.drain().catch(() => {});
  engine.close("clean");
  rmSync(dir, { recursive: true, force: true });
});

/** Address segments map directly to path segments: "api.notes.echo" -> "/api/notes/echo". */
function httpPath(address: string): string {
  return `/${address.replaceAll(".", "/")}`;
}

/**
 * The exposed surface speaks the standard JSON its OpenAPI document publishes,
 * so every call in this file uses `JSON`, never the Protocol-2 wire codec.
 */
async function call(
  address: string,
  args: unknown,
  authorization?: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`${base}${httpPath(address)}`, {
    method: "POST",
    headers: authorization === undefined ? {} : { authorization },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}

interface SseResponseReader {
  readonly streamId: string;
  next(): Promise<SseMessage | null>;
  cancel(reason?: unknown): Promise<void>;
}

function readSse(response: Response): SseResponseReader {
  const streamId = response.headers.get("x-ackerdb-sse-stream");
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
          return parseSseMessage(JSON.parse(event.slice(6)));
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
  return fetch(`${baseUrl}/_sse/ack`, {
    method: "POST",
    headers: authorization === undefined ? {} : { authorization },
    body: encode({
      v: ACKERDB_VERSION,
      t: "sse_ack",
      stream: overrides.stream ?? stream,
      seq: overrides.seq ?? message.seq,
      proof: overrides.proof ?? message.proof,
    }),
  });
}

describe("health and protected status", () => {
  test("owns its port through explicit startup phases and atomically activates one Runtime", async () => {
    const early = new AckerDBServer({ limits, port: 0 });
    const earlyBase = `http://127.0.0.1:${early.port}`;
    const earlyDir = mkdtempSync(join(tmpdir(), "ackerdb-serve-startup-"));
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

      const unavailable = {
        code: "unavailable",
        retryable: true,
        resource: "connection",
        message: "server is not ready",
      } as const;
      for (const path of ["/status", "/_ws"] as const) {
        const response = await fetch(`${earlyBase}${path}`);
        expect(response.status).toBe(503);
        expect(parseServerMessage(decode(await response.text()))).toEqual({
          v: ACKERDB_VERSION,
          t: "err",
          id: null,
          outcome: unavailable,
        });
      }

      // The application surface is envelope-free even before a registry
      // exists, and the deleted `/api/sse` is now one of its ordinary paths.
      for (const path of ["/api/notes/echo", "/api/sse"] as const) {
        const early503 = await fetch(`${earlyBase}${path}`, {
          method: "POST",
          body: JSON.stringify({ value: "x" }),
        });
        expect(early503.status).toBe(503);
        expect(JSON.parse(await early503.text())).toEqual(unavailable);
      }

      const socket = new WebSocket(`ws://127.0.0.1:${early.port}/_ws`);
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
      early.advanceStartup("loading-runtime");
      const loadingRuntime = await fetch(`${earlyBase}/ready`);
      expect(loadingRuntime.status).toBe(503);
      expect(await loadingRuntime.json()).toEqual({
        version: 1,
        ready: false,
        state: "starting",
        phase: "loading-runtime",
      });

      earlyEngine = new Engine(schema, join(earlyDir, "data.db"));
      reconcile(earlyEngine);
      earlyRuntime = new Runtime({
        engine: earlyEngine,
        registry: early.loadFunctionModules(functions),
        verifier,
        limits,
      });
      await earlyRuntime.start();
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
      },
    });
    expect(verifier.verified).toEqual(["user-token", "workload-alias-token", "workload-token"]);
  });

  test("validates configured status scope", () => {
    for (const statusScope of ["", "two scopes", "x".repeat(129)]) {
      expect(() => new AckerDBServer({ limits, port: 0, statusScope })).toThrow(TypeError);
    }
    expect(() => new AckerDBServer({
      limits: { ...runtime.limits, maxRequestBytes: Number.MAX_SAFE_INTEGER },
      fileMaxBytes: runtime.fileMaxBytes,
      port: 0,
    })).toThrow(
      "maxRequestBytes or configured File limit + 1 must be a safe integer",
    );
    expect(() => new AckerDBServer({
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
    expect(parseServerMessage(decode(text))).toEqual({
      v: ACKERDB_VERSION,
      t: "err",
      id: null,
      outcome: { code: "internal", retryable: false, message: "internal server error" },
    });
  });
});

describe("exposed HTTP procedures", () => {
  test("serves the plain return value at its per-function path for every admitted principal", async () => {
    expect(await call("api.notes.echo", { value: "hello" })).toEqual({
      status: 200,
      body: "hello",
    });
    // The Identity is a bigint, and this procedure declares no `returns`: an
    // undeclared value crosses as the same decimal string a declared one would.
    expect(await call("api.notes.identity", {}, "Bearer user-token")).toEqual({
      status: 200,
      body: { kind: "user", subject: "user-token", identity: "1" },
    });
    expect(verifier.verified).toEqual(["user-token"]);

    const response = await fetch(`${base}${httpPath("api.notes.echo")}`, {
      method: "POST",
      body: JSON.stringify({ value: "headers" }),
    });
    expect(response.headers.get("content-type")).toStartWith("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(JSON.parse(await response.text())).toBe("headers");
  });

  test("treats an absent or empty body as empty args", async () => {
    const absent = await fetch(`${base}${httpPath("api.notes.conflict")}`, { method: "POST" });
    expect(absent.status).toBe(409);
    expect(JSON.parse(await absent.text())).toMatchObject({ code: "conflict" });

    const empty = await fetch(`${base}${httpPath("api.notes.identity")}`, {
      method: "POST",
      headers: { authorization: "Bearer user-token" },
      body: "",
    });
    expect(empty.status).toBe(200);
    expect(JSON.parse(await empty.text())).toMatchObject({ kind: "user" });
  });

  test("hides unexposed functions behind the same 404 as a nonexistent path", async () => {
    const unexposed = await fetch(`${base}${httpPath("api.notes.hidden")}`, {
      method: "POST",
      body: JSON.stringify({ value: "x" }),
    });
    const missing = await fetch(`${base}${httpPath("api.notes.missing")}`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const otherModule = await fetch(`${base}/api/ghosts/list`, { method: "POST" });

    expect(unexposed.status).toBe(404);
    const body = await unexposed.text();
    // The bare outcome every other failure here answers: a caller that decodes
    // this surface reads `not_found`, never a plain-text body its decoder
    // reports as malformed. Forgetting `http` is the likeliest mistake here.
    expect(JSON.parse(body)).toEqual({
      code: "not_found",
      retryable: false,
      message: "no route at this path",
    });
    expect(unexposed.headers.get("content-type")).toBe("application/json; charset=utf-8");
    for (const response of [missing, otherModule]) {
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(body);
    }
    // The unexposed procedure keeps working over the WebSocket session.
    const client = await connectWebSocket(`ws://127.0.0.1:${server.port}/_ws`);
    client.send({ t: "p", id: 1, ref: "api.notes.hidden", args: { value: "ws" } });
    expect(await within(client.next())).toMatchObject({ t: "ok", id: 1, value: "ws" });
    client.socket.close();
    await within(client.closed());
  });

  test("serves one fixed application root, gated by access alone", async () => {
    const counted = await fetch(`${base}${httpPath("api.ops.count")}`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(counted.status).toBe(200);

    const wrongRoot = await fetch(`${base}${httpPath("other.ops.count")}`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(wrongRoot.status).toBe(404);

    // The system-only mutation answers exactly what its `access` says, to an
    // anonymous caller and to an authenticated user alike.
    const anonymous = await fetch(`${base}${httpPath("api.ops.purge")}`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(anonymous.status).toBe(401);
    const user = await fetch(`${base}${httpPath("api.ops.purge")}`, {
      method: "POST",
      headers: { authorization: "Bearer user-token" },
      body: JSON.stringify({}),
    });
    expect(user.status).toBe(403);

    // The same address reaches the function on both surfaces, and the same
    // policy answers.
    const client = await connectWebSocket(`ws://127.0.0.1:${server.port}/_ws`);
    client.send({ t: "q", id: 1, ref: "api.ops.count", args: {} });
    expect(await within(client.next())).toMatchObject({ t: "ok", id: 1 });
    client.send({
      t: "m",
      id: 2,
      ref: "api.ops.purge",
      args: {},
      mutationRequestId: uuidV7(2),
      issuedAt: Date.now(),
    });
    expect(await within(client.next())).toMatchObject({
      t: "err",
      id: 2,
      outcome: { code: "unauthenticated" },
    });
    client.socket.close();
    await within(client.closed());
  });

  test("answers a wrong method on an exposed path with 405 and its Allow header", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await fetch(`${base}${httpPath("api.notes.echo")}`, { method });
      expect(response.status).toBe(405);
      // Allow names every method the route registered, framework CORS
      // preflight included: the registry builds it from the route itself.
      expect(response.headers.get("allow")).toBe("POST, OPTIONS");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      // The same outcome shape as every other failure, at the status and with
      // the Allow header HTTP mandates.
      expect(JSON.parse(await response.text())).toEqual({
        code: "malformed",
        retryable: false,
        message: "method not allowed; allow: POST, OPTIONS",
      });
    }
    const preflight = await fetch(`${base}${httpPath("api.notes.echo")}`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
  });

  test("answers every websocket-door refusal with the same protocol frame", async () => {
    // Method selection belongs to the route table, so a wrong method on the
    // upgrade path answers the registry's bare Outcome like every other route.
    const wrongMethod = await fetch(`${base}/_ws`, { method: "POST" });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
    expect(JSON.parse(await wrongMethod.text())).toEqual({
      code: "malformed",
      retryable: false,
      message: "method not allowed; allow: GET",
    });

    // A plain GET on the upgrade path carries no upgrade headers, so Bun
    // refuses it and the door answers the same frame instead of plain text.
    const noUpgrade = await fetch(`${base}/_ws`);
    expect(noUpgrade.status).toBe(400);
    expect(parseServerMessage(decode(await noUpgrade.text()))).toEqual({
      v: ACKERDB_VERSION,
      t: "err",
      id: null,
      outcome: {
        code: "malformed",
        retryable: false,
        message: "websocket upgrade required",
      },
    });
  });

  test("varies cacheable responses by the credential that changes them", async () => {
    // A GET query is the cacheable form an operator is invited to front with a
    // CDN rule; without this it would serve one caller's rows to another.
    const get = await fetch(
      `${base}${httpPath("api.notes.identityQuery")}?args=${encodeURIComponent("{}")}`,
      { headers: { authorization: "Bearer user-token" } },
    );
    expect(get.status).toBe(200);
    expect(get.headers.get("vary")).toBe("authorization");

    const posted = await fetch(`${base}${httpPath("api.notes.echo")}`, {
      method: "POST",
      body: JSON.stringify({ value: "x" }),
    });
    expect(posted.headers.get("vary")).toBe("authorization");
  });

  test("resolves one durable Identity for the same user over HTTP and WebSocket", async () => {
    const http = await call("api.notes.identity", {}, "Bearer user-token");
    expect(http.status).toBe(200);

    const client = await connectWebSocket(`ws://127.0.0.1:${server.port}/_ws`, {
      kind: "bearer",
      token: "user-token",
    });
    client.send({ t: "q", id: 1, ref: "api.notes.identityQuery", args: {} });
    const websocket = await within(client.next());
    expect(websocket).toMatchObject({ t: "ok", id: 1, kind: "query" });
    if (websocket.t !== "ok") throw new Error("expected WebSocket query success");

    // One durable Identity, spelled by each transport's own wire format: the
    // session carries the bigint, the exposed surface its decimal string.
    expect(websocket.value).toEqual({
      kind: "user",
      subject: "user-token",
      identity: 1n,
    });
    expect(http.body).toEqual({
      kind: "user",
      subject: "user-token",
      identity: "1",
    });
    expect(engine.writer.query("SELECT COUNT(*) AS count FROM _ackerdb_identities").get())
      .toEqual({ count: 1n });
    expect(engine.writer.query("SELECT COUNT(*) AS count FROM _ackerdb_identity_accounts").get())
      .toEqual({ count: 1n });

    client.socket.close();
    await within(client.closed());
  });

  test("maps every outcome through its exact HTTP status as a plain outcome body", async () => {
    const invalidArgs = await call("api.notes.echo", { value: 1 });
    expect(invalidArgs.status).toBe(400);
    expect(invalidArgs.body).toMatchObject({ code: "validation" });

    const unauthenticated = await call("api.notes.identity", {});
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).toMatchObject({ code: "unauthenticated" });

    const conflict = await call("api.notes.conflict", {});
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: "conflict" });

    const internal = await call("api.notes.explode", {});
    expect(internal.status).toBe(500);
    expect(internal.body).toEqual({
      code: "internal",
      retryable: false,
      message: "internal server error",
    });
  });

  test("admits the received HTTP bytes without rejecting a larger canonical re-encoding", async () => {
    const exponents = Array.from({ length: 60 }, () => "1e9").join(",");
    const body = `{"values":[${exponents}]}`;
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(limits.maxRequestBytes);
    expect(Buffer.byteLength(JSON.stringify(JSON.parse(body)))).toBeGreaterThan(limits.maxRequestBytes);

    const response = await fetch(`${base}${httpPath("api.notes.numbers")}`, { method: "POST", body });
    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text())).toBe(60);
  });

  test("rejects malformed args bodies and malformed Authorization", async () => {
    const malformed = await fetch(`${base}${httpPath("api.notes.echo")}`, {
      method: "POST",
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(JSON.parse(await malformed.text())).toMatchObject({ code: "malformed" });

    const unknownArgument = await call("api.notes.echo", { value: "x", extra: true });
    expect(unknownArgument.status).toBe(400);
    expect(unknownArgument.body).toMatchObject({ code: "validation" });

    const basic = await fetch(`${base}${httpPath("api.notes.echo")}`, {
      method: "POST",
      headers: { authorization: "Basic secret" },
      body: JSON.stringify({ value: "x" }),
    });
    expect(basic.status).toBe(401);
    expect(JSON.parse(await basic.text())).toMatchObject({ code: "unauthenticated" });
  });

  test("rejects invalid credentials without reading a stalled request body", async () => {
    const response = await fetch(`${base}${httpPath("api.notes.identity")}`, {
      method: "POST",
      headers: { authorization: "Bearer invalid" },
      body: stalledBody(),
    });

    expect(response.status).toBe(401);
    expect(JSON.parse(await response.text())).toMatchObject({ code: "unauthenticated" });
    expect(verifier.verified.at(-1)).toBe("invalid");
  });

  test("bounds declared and streaming HTTP bodies before parsing them", async () => {
    const declared = await fetch(`${base}${httpPath("api.notes.echo")}`, {
      method: "POST",
      body: "x".repeat(limits.maxRequestBytes + 1),
    });
    expect(declared.status).toBe(429);
    expect(JSON.parse(await declared.text())).toMatchObject({
      code: "overloaded",
      resource: "operation",
    });

    const chunkedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(limits.maxRequestBytes));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const chunked = await fetch(`${base}${httpPath("api.notes.echo")}`, {
      method: "POST",
      body: chunkedBody,
    });
    expect(chunked.status).toBe(429);
    expect(JSON.parse(await chunked.text())).toMatchObject({
      code: "overloaded",
      resource: "operation",
    });

  });

  test("decodes UTF-8 split across request chunks without retaining a byte copy", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"'));
        controller.enqueue(new Uint8Array([0xc3]));
        controller.enqueue(new Uint8Array([0xa9]));
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      },
    });
    const response = await fetch(`${base}${httpPath("api.notes.echo")}`, {
      method: "POST",
      body,
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text())).toBe("é");
  });

  test("globally bounds pre-body HTTP admission and rejects node saturation as 503", async () => {
    const controllers = [new AbortController(), new AbortController()];
    const stalled = controllers.map((controller) =>
      fetch(`${base}${httpPath("api.notes.echo")}`, {
        method: "POST",
        body: stalledBody(),
        signal: controller.signal,
      }).then(
        (response) => ({ kind: "response" as const, response }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ));
    await eventually(() => server.status().httpIngress === limits.maxOperations);

    const excess = await call("api.notes.echo", { value: "x" });
    expect(excess.status).toBe(503);
    expect(excess.body).toMatchObject({
      code: "overloaded",
      retryable: true,
      resource: "connection",
    });

    for (const controller of controllers) controller.abort();
    await Promise.all(stalled);
    await eventually(() => server.status().httpIngress === 0);
  });

  test("reserves HTTP capacity across source, principal, handoff, and SSE body ownership", async () => {
    const fairDirectory = mkdtempSync(join(tmpdir(), "ackerdb-http-fairness-"));
    const fairEngine = new Engine(schema, join(fairDirectory, "data.db"));
    reconcile(fairEngine);
    const fairVerifier = new TestVerifier();
    const fairLimits = defineServiceLimits({
      ...limits,
      maxOperationsPerCaller: 1,
      readQueue: { ...limits.readQueue, maxAgeMs: 500 },
    });
    const fairServer = new AckerDBServer({ limits: fairLimits, port: 0 });
    const fairRuntime = new Runtime({
      engine: fairEngine,
      registry: fairServer.loadFunctionModules(functions),
      verifier: fairVerifier,
      limits: fairLimits,
    });
    await fairRuntime.start();
    fairServer.activate(fairRuntime);
    const fairBase = `http://127.0.0.1:${fairServer.port}`;
    const sourceController = new AbortController();
    const sseController = new AbortController();
    let heldProcedure: Promise<Response> | undefined;
    let heldSse: Response | undefined;
    let heldSseReader: SseResponseReader | undefined;

    try {
      const stalled = fetch(`${fairBase}${httpPath("api.notes.echo")}`, {
        method: "POST",
        body: stalledBody(),
        signal: sourceController.signal,
      }).catch(() => undefined);
      await eventually(() => fairServer.status().httpIngress === 1);

      const spoofedSource = await fetch(`${fairBase}${httpPath("api.notes.echo")}`, {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.99" },
        body: JSON.stringify({ value: "spoofed" }),
      });
      expect(spoofedSource.status).toBe(503);
      expect(JSON.parse(await spoofedSource.text())).toMatchObject({
        code: "overloaded",
        retryable: true,
        retryAfterMs: 0,
        resource: "connection",
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
      heldProcedure = fetch(`${fairBase}${httpPath("api.notes.block")}`, {
        method: "POST",
        headers: { authorization: "Bearer user-token" },
        body: JSON.stringify({}),
      });
      await blockedProcedureStarted.promise;

      const hot = await fetch(`${fairBase}${httpPath("api.notes.echo")}`, {
        method: "POST",
        headers: { authorization: "Bearer user-rotated-token" },
        body: JSON.stringify({ value: "hot" }),
      });
      expect(hot.status).toBe(429);
      expect(JSON.parse(await hot.text())).toMatchObject({
        code: "overloaded",
        retryable: true,
        resource: "operation",
      });

      const cold = await fetch(`${fairBase}${httpPath("api.notes.echo")}`, {
        method: "POST",
        headers: { authorization: "Bearer user-two-token" },
        body: JSON.stringify({ value: "cold" }),
      });
      expect(cold.status).toBe(200);
      expect(JSON.parse(await cold.text())).toBe("cold");
      expect(fairServer.status()).toMatchObject({ httpIngress: 1, httpFairnessKeys: 1 });

      blockedProcedureRelease.resolve(undefined);
      expect((await heldProcedure).status).toBe(200);
      heldProcedure = undefined;
      await eventually(() => fairServer.status().httpIngress === 0);

      longSseStarted = deferred<void>();
      heldSse = await fetch(`${fairBase}${httpPath("api.notes.stayOpen")}`, {
        method: "POST",
        headers: { authorization: "Bearer user-token" },
        body: JSON.stringify({}),
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

      const whileStreaming = await fetch(`${fairBase}${httpPath("api.notes.echo")}`, {
        method: "POST",
        headers: { authorization: "Bearer user-token" },
        body: JSON.stringify({ value: "streaming" }),
      });
      expect(whileStreaming.status).toBe(429);
      expect(JSON.parse(await whileStreaming.text())).toMatchObject({
        code: "overloaded",
        resource: "operation",
      });

      sseController.abort("test cancellation");
      await heldSseReader.cancel("test cancellation").catch(() => {});
      heldSseReader = undefined;
      heldSse = undefined;
      await eventually(() =>
        fairServer.status().httpIngress === 0 &&
        fairRuntime.status().activeOperationCallers === 0
      );
      const afterCancel = await fetch(`${fairBase}${httpPath("api.notes.echo")}`, {
        method: "POST",
        headers: { authorization: "Bearer user-token" },
        body: JSON.stringify({ value: "released" }),
      });
      expect(afterCancel.status).toBe(200);
      expect(JSON.parse(await afterCancel.text())).toBe("released");
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
    const response = await fetch(`${base}${httpPath("api.notes.echo")}`, {
      method: "POST",
      body: stalledBody(),
    });
    const elapsed = performance.now() - startedAt;

    expect(response.status).toBe(504);
    expect(JSON.parse(await response.text())).toMatchObject({
      code: "deadline_exceeded",
      resource: "operation",
    });
    expect(elapsed).toBeGreaterThanOrEqual(limits.readQueue.maxAgeMs - 15);
    expect(elapsed).toBeLessThan(limits.readQueue.maxAgeMs + 500);
    expect(server.status().httpIngress).toBe(0);
  });
});

describe("exposed HTTP queries", () => {
  /** A GET query carries its whole args object in one url-encoded parameter. */
  function queryUrl(address: string, args?: string): string {
    return `${base}${httpPath(address)}${args === undefined ? "" : `?args=${encodeURIComponent(args)}`}`;
  }

  test("answers one query identically through GET args and a POST body", async () => {
    expect((await call("api.notes.add", { body: "one", rank: "1" })).status).toBe(200);
    // A bigint crosses this surface as the decimal string the document
    // publishes, in both directions; a safe integer is accepted on the way in.
    const args = JSON.stringify({ rank: "1" });

    const get = await fetch(queryUrl("api.notes.list", args));
    const post = await fetch(`${base}${httpPath("api.notes.list")}`, {
      method: "POST",
      body: JSON.stringify({ rank: 1 }),
    });

    expect(get.status).toBe(200);
    expect(post.status).toBe(200);
    const value = JSON.parse(await get.text());
    expect(value).toEqual([{ id: "1", body: "one", rank: "1" }]);
    expect(JSON.parse(await post.text())).toEqual(value);
    expect(get.headers.get("content-type")).toStartWith("application/json");
    expect(get.headers.get("access-control-allow-origin")).toBe("*");
    // Caching policy belongs to the operator, so no Cache-Control is emitted.
    expect(get.headers.get("cache-control")).toBeNull();
  });

  test("treats an omitted args parameter and an empty body as empty args", async () => {
    const authorization = { authorization: "Bearer user-token" };
    const identity = { kind: "user", subject: "user-token", identity: "1" };

    const omitted = await fetch(queryUrl("api.notes.identityQuery"), { headers: authorization });
    expect(omitted.status).toBe(200);
    expect(JSON.parse(await omitted.text())).toEqual(identity);

    const emptyParameter = await fetch(queryUrl("api.notes.identityQuery", ""), {
      headers: authorization,
    });
    expect(emptyParameter.status).toBe(200);
    expect(JSON.parse(await emptyParameter.text())).toEqual(identity);

    const emptyBody = await fetch(`${base}${httpPath("api.notes.identityQuery")}`, {
      method: "POST",
      headers: authorization,
      body: "",
    });
    expect(emptyBody.status).toBe(200);
    expect(JSON.parse(await emptyBody.text())).toEqual(identity);
  });

  test("maps a GET caller error to its exact status and plain outcome body", async () => {
    const malformed = await fetch(queryUrl("api.notes.list", "{"));
    expect(malformed.status).toBe(400);
    expect(JSON.parse(await malformed.text())).toMatchObject({ code: "malformed" });

    const invalid = await fetch(queryUrl("api.notes.list", JSON.stringify({ rank: "one" })));
    expect(invalid.status).toBe(400);
    expect(JSON.parse(await invalid.text())).toMatchObject({ code: "validation" });

    // Per-field parameters are not a supported spelling: nothing coerces them.
    const perField = await fetch(`${base}${httpPath("api.notes.list")}?rank=1`);
    expect(perField.status).toBe(400);
    expect(JSON.parse(await perField.text())).toMatchObject({ code: "validation" });

    const oversized = await fetch(queryUrl("api.notes.list", "x".repeat(limits.maxRequestBytes + 1)));
    expect(oversized.status).toBe(429);
    expect(JSON.parse(await oversized.text())).toMatchObject({
      code: "overloaded",
      resource: "operation",
    });

    const unauthenticated = await fetch(queryUrl("api.notes.identityQuery"));
    expect(unauthenticated.status).toBe(401);
    expect(JSON.parse(await unauthenticated.text())).toMatchObject({ code: "unauthenticated" });
  });

  test("offers GET on query paths alone and names the allowed methods", async () => {
    const wrongMethod = await fetch(`${base}${httpPath("api.notes.list")}`, { method: "DELETE" });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET, POST, OPTIONS");

    const procedureGet = await fetch(`${base}${httpPath("api.notes.echo")}`);
    expect(procedureGet.status).toBe(405);
    expect(procedureGet.headers.get("allow")).toBe("POST, OPTIONS");

    const mutationGet = await fetch(`${base}${httpPath("api.notes.add")}`);
    expect(mutationGet.status).toBe(405);
    expect(mutationGet.headers.get("allow")).toBe("POST, OPTIONS");
  });
});

describe("exposed HTTP mutations", () => {
  interface MutationResponse {
    readonly status: number;
    readonly body: unknown;
    readonly receipt: Record<string, string | null>;
  }

  /** Every call is its own HTTP request: the key is the only replay identity. */
  async function mutate(
    address: string,
    args: unknown,
    headers: Record<string, string> = {},
  ): Promise<MutationResponse> {
    const response = await fetch(`${base}${httpPath(address)}`, {
      method: "POST",
      headers,
      body: JSON.stringify(args),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === "" ? undefined : JSON.parse(text),
      receipt: {
        commitVersion: response.headers.get("x-ackerdb-commit-version"),
        durability: response.headers.get("x-ackerdb-durability"),
        replay: response.headers.get("x-ackerdb-replay"),
        obligations: response.headers.get("x-ackerdb-obligations"),
      },
    };
  }

  function notes(rank: string): Promise<unknown> {
    return fetch(`${base}${httpPath("api.notes.list")}?args=${encodeURIComponent(JSON.stringify({ rank }))}`)
      .then((response) => response.text())
      .then((body) => JSON.parse(body));
  }

  test("executes a keyless mutation every time and answers its receipt on headers", async () => {
    const first = await mutate("api.notes.add", { body: "one", rank: "1" });
    expect(first.status).toBe(200);
    expect(first.body).toBe("1");
    expect(first.receipt.durability).toBe(engine.durability);
    expect(first.receipt.replay).toBe("false");
    // An HTTP caller holds no subscriptions, so it owes no convergence and its
    // empty obligation list has no header value to carry.
    expect(first.receipt.obligations).toBeNull();
    expect(BigInt(first.receipt.commitVersion!)).toBeGreaterThan(0n);

    // Without a key there is no replay protection: the same request writes again.
    const second = await mutate("api.notes.add", { body: "one", rank: "1" });
    expect(second.body).toBe("2");
    expect(second.receipt.replay).toBe("false");
    expect(BigInt(second.receipt.commitVersion!))
      .toBeGreaterThan(BigInt(first.receipt.commitVersion!));
    expect(await notes("1")).toHaveLength(2);
  });

  test("replays one key's stored result across separate HTTP requests", async () => {
    const key = { "idempotency-key": uuidV7(1) };
    const executed = await mutate("api.notes.add", { body: "one", rank: "1" }, key);
    expect(executed.status).toBe(200);
    expect(executed.receipt.replay).toBe("false");

    const replayed = await mutate("api.notes.add", { body: "one", rank: "1" }, key);
    expect(replayed.status).toBe(200);
    expect(replayed.body).toBe(executed.body);
    expect(replayed.receipt.replay).toBe("true");
    expect(replayed.receipt.commitVersion).toBe(executed.receipt.commitVersion);
    expect(replayed.receipt.durability).toBe(executed.receipt.durability);
    expect(await notes("1")).toHaveLength(1);
  });

  test("scopes a key to the caller that presented it", async () => {
    const key = { "idempotency-key": uuidV7(2) };
    const args = { body: "one", rank: "1" };
    const anonymous = await mutate("api.notes.add", args, key);
    expect(anonymous.receipt.replay).toBe("false");

    const authenticated = await mutate("api.notes.add", args, {
      ...key,
      authorization: "Bearer user-token",
    });
    expect(authenticated.receipt.replay).toBe("false");
    expect(authenticated.body).not.toBe(anonymous.body);
    expect(await notes("1")).toHaveLength(2);
  });

  test("replays for one identity even when its credential was reissued", async () => {
    const key = { "idempotency-key": uuidV7(5) };
    const args = { body: "one", rank: "1" };
    const executed = await mutate("api.notes.add", args, {
      ...key,
      authorization: "Bearer user-token",
    });
    expect(executed.receipt.replay).toBe("false");

    // Same Identity, freshly verified credential: the caller fingerprint is the
    // durable identity, so the retry replays rather than writing a second note.
    const replayed = await mutate("api.notes.add", args, {
      ...key,
      authorization: "Bearer user-rotated-token",
    });
    expect(replayed.body).toBe(executed.body);
    expect(replayed.receipt.replay).toBe("true");
    expect(await notes("1")).toHaveLength(1);
  });

  test("conflicts when one key is reused for different args or a different function", async () => {
    const key = { "idempotency-key": uuidV7(3) };
    expect((await mutate("api.notes.add", { body: "one", rank: "1" }, key)).status).toBe(200);

    const otherArgs = await mutate("api.notes.add", { body: "two", rank: "1" }, key);
    expect(otherArgs.status).toBe(409);
    expect(otherArgs.body).toMatchObject({ code: "conflict", resource: "idempotency" });

    const otherFunction = await mutate("api.notes.beep", { body: "one", rank: "1" }, key);
    expect(otherFunction.status).toBe(409);
    expect(otherFunction.body).toMatchObject({ code: "conflict", resource: "idempotency" });

    expect(await notes("1")).toHaveLength(1);
  });

  test("rejects a key that is not a UUIDv7", async () => {
    for (const candidate of ["not-a-uuid", "00000000-0000-4000-8000-000000000000", ""]) {
      const rejected = await mutate("api.notes.add", { body: "one", rank: "1" }, {
        "idempotency-key": candidate,
      });
      expect(rejected.status).toBe(400);
      expect(rejected.body).toMatchObject({ code: "validation", resource: "idempotency" });
    }
    expect(await notes("1")).toHaveLength(0);
  });

  test("carries the receipt on an idempotent application error", async () => {
    const key = { "idempotency-key": uuidV7(4) };
    const expected = {
      kind: "application",
      code: "notes.gone",
      body: { reason: "purged" },
      status: 410,
    };
    const rejected = await mutate("api.notes.rejectMutation", {}, key);
    expect(rejected.status).toBe(410);
    expect(rejected.body).toEqual(expected);
    expect(rejected.receipt.replay).toBe("false");
    expect(rejected.receipt.durability).toBe(engine.durability);
    expect(BigInt(rejected.receipt.commitVersion!)).toBeGreaterThanOrEqual(0n);

    const replayed = await mutate("api.notes.rejectMutation", {}, key);
    expect(replayed.status).toBe(410);
    expect(replayed.body).toEqual(expected);
    expect(replayed.receipt.replay).toBe("true");
    expect(replayed.receipt.commitVersion).toBe(rejected.receipt.commitVersion);
  });

  /**
   * Encoding the response is the mutation's last fallible step, so it runs
   * inside the transaction. A body that cannot be produced must roll the write
   * back: `Idempotency-Key` is opt-in, so a caller retrying the failure it was
   * answered with would otherwise write a second time.
   */
  test("rolls the write back when its success body cannot be produced", async () => {
    const oversized = await mutate("api.notes.addOversized", { body: "one", rank: "1" });
    expect(oversized.status).toBe(429);
    expect(oversized.body).toMatchObject({ code: "overloaded" });
    expect(oversized.receipt.commitVersion).toBeNull();
    expect(await notes("1")).toEqual([]);

    const unencodable = await mutate("api.notes.addUnencodable", { body: "two", rank: "2" });
    expect(unencodable.status).toBe(400);
    expect(unencodable.body).toMatchObject({ code: "validation" });
    expect(unencodable.receipt.commitVersion).toBeNull();
    expect(await notes("2")).toEqual([]);

    // The retry the caller is invited to make must not find a first write.
    expect((await mutate("api.notes.addOversized", { body: "one", rank: "1" })).status).toBe(429);
    expect(await notes("1")).toEqual([]);
  });

  test("commits nothing when the handler declares an application error", async () => {
    const rejected = await mutate("api.notes.rejectAfterWrite", { body: "one", rank: "1" });
    expect(rejected.status).toBe(410);
    expect(rejected.body).toEqual({
      kind: "application",
      code: "notes.gone",
      body: { reason: "purged" },
      status: 410,
    });
    expect(await notes("1")).toEqual([]);
  });

  test("names the receipt headers a browser caller may read", async () => {
    const preflight = await fetch(`${base}${httpPath("api.notes.add")}`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    const exposed = preflight.headers.get("access-control-expose-headers");
    expect(exposed).toContain("x-ackerdb-commit-version");
    expect(exposed).toContain("x-ackerdb-durability");
    expect(exposed).toContain("x-ackerdb-replay");
    expect(exposed).toContain("x-ackerdb-obligations");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("idempotency-key");
  });
});

describe("SSE", () => {
  test("routes capability ACKs without oracles and keeps the registry through terminal credit", async () => {
    const denied = await fetch(`${base}${httpPath("api.notes.chat")}`, {
      method: "POST",
      body: JSON.stringify({ text: "no" }),
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("content-type")).toStartWith("application/json");
    expect(JSON.parse(await denied.text())).toMatchObject({ code: "unauthenticated" });

    const success = await fetch(`${base}${httpPath("api.notes.chat")}`, {
      method: "POST",
      headers: { authorization: "Bearer user-token" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(success.status).toBe(200);
    expect(success.headers.get("content-type")).toStartWith("text/event-stream");
    expect(success.headers.get("x-vercel-ai-ui-message-stream")).toBeNull();
    expect(success.headers.get("x-ackerdb-sse-stream")).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(success.headers.get("x-ackerdb-sse-max-stall-ms")).toBe(String(limits.sse.maxStallMs));
    expect(success.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(success.headers.get("vary")).toBe("authorization");
    expect(success.headers.get("access-control-expose-headers")).toStartWith(
      "x-ackerdb-sse-stream, x-ackerdb-sse-max-stall-ms",
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

    const malformed = await fetch(`${base}/_sse/ack`, {
      method: "POST",
      body: encode({
        v: ACKERDB_VERSION,
        t: "sse_ack",
        stream: reader.streamId,
        seq: terminal!.seq,
        proof: terminal!.proof,
        extra: true,
      }),
    });
    expect(malformed.status).toBe(400);
    expect(parseServerMessage(decode(await malformed.text()))).toMatchObject({
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

    const preflight = await fetch(`${base}/_sse/ack`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-expose-headers")).toContain("x-ackerdb-sse-stream");
    const wrongMethod = await fetch(`${base}/_sse/ack`);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST, OPTIONS");

    // An absent body is empty args here exactly as it is for every other kind.
    const late = await fetch(`${base}${httpPath("api.notes.failLate")}`, { method: "POST" });
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

  test("serves streams only from per-function paths, and only for exposed functions", async () => {
    // The envelope route is gone; nothing owns `/api/sse` any more.
    const envelope = await fetch(`${base}/api/sse`, {
      method: "POST",
      body: encode({ t: "call", id: 1, ref: "api.notes.chat", args: { text: "no" } }),
    });
    expect(envelope.status).toBe(404);

    // Unexposed is indistinguishable from nonexistent, and there is no GET.
    const unexposed = await fetch(`${base}${httpPath("api.notes.hiddenChat")}`, { method: "POST" });
    expect(unexposed.status).toBe(404);

    // An sseProcedure that was never given `http` is the mistake this feature
    // makes most likely, so its 404 must decode as `not_found` rather than
    // reaching the client's frame parser as plain text.
    expect(JSON.parse(await unexposed.text())).toMatchObject({ code: "not_found" });

    const wrongMethod = await fetch(`${base}${httpPath("api.notes.chat")}`);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST, OPTIONS");
    expect(runtime.status().activeSse).toBe(0);
  });

  test("validates chunks against yields and rejects args the validator refuses", async () => {
    const invalid = await fetch(`${base}${httpPath("api.notes.chat")}`, {
      method: "POST",
      headers: { authorization: "Bearer user-token" },
      body: JSON.stringify({ text: 7 }),
    });
    expect(invalid.status).toBe(400);
    expect(JSON.parse(await invalid.text())).toMatchObject({ code: "validation" });
    expect(runtime.status().activeSse).toBe(0);

    // A chunk the yields validator refuses is still a terminal stream failure,
    // never an unvalidated value on the wire.
    const invalidChunk = await fetch(`${base}${httpPath("api.notes.badChunk")}`, { method: "POST" });
    expect(invalidChunk.status).toBe(200);
    const reader = readSse(invalidChunk);
    const first = await reader.next();
    expect(first).toMatchObject({ t: "sse_chunk", seq: 1, value: { value: "first" } });
    // Crediting the valid chunk advances the handler into the refused one.
    expect((await acknowledgeSse(base, reader.streamId, first!)).status).toBe(204);
    const failure = await reader.next();
    expect(failure).toMatchObject({ t: "sse_error", seq: 2, outcome: { code: "validation" } });
    expect((await acknowledgeSse(base, reader.streamId, failure!)).status).toBe(204);
    expect(await reader.next()).toBeNull();
  });
});

describe("the opt-in OpenAPI endpoint", () => {
  const info = { title: "notes-app", version: "4.2.0" } as const;
  const OPENAPI = "/_openapi.json";

  let owned: {
    readonly dir: string;
    readonly engine: Engine;
    readonly runtime: Runtime;
    server?: AckerDBServer;
  } | null = null;

  afterEach(async () => {
    if (owned === null) return;
    await owned.server?.drain().catch(() => {});
    await owned.runtime.drain().catch(() => {});
    owned.engine.close("clean");
    rmSync(owned.dir, { recursive: true, force: true });
    owned = null;
  });

  /** A second listener that asks for the document; the shared one never does. */
  async function documented(
    modules: Record<string, Record<string, unknown>> = functions,
  ): Promise<{ readonly base: string; readonly registry: Registry }> {
    const dir = mkdtempSync(join(tmpdir(), "ackerdb-openapi-"));
    const engine = new Engine(schema, join(dir, "data.db"));
    reconcile(engine);
    const documentedServer = new AckerDBServer({
      limits,
      port: 0,
      openapiEndpoint: info,
    });
    let registry: Registry;
    try {
      registry = documentedServer.loadFunctionModules(modules);
    } catch (error) {
      engine.close("clean");
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    const documentedRuntime = new Runtime({
      engine,
      registry,
      verifier: new TestVerifier(),
      limits,
    });
    // Recorded before activation so a refused document is still torn down.
    owned = { dir, engine, runtime: documentedRuntime, server: documentedServer };
    await documentedRuntime.start();
    documentedServer.activate(documentedRuntime);
    return { base: `http://127.0.0.1:${documentedServer.port}`, registry };
  }

  test("is unclaimed by default, on every method", async () => {
    const absent = await fetch(`${base}${OPENAPI}`);
    expect(absent.status).toBe(404);
    expect(JSON.parse(await absent.text())).toMatchObject({ code: "not_found" });
    // Not a method problem: nothing owns the path, exactly as before it existed.
    const posted = await fetch(`${base}${OPENAPI}`, { method: "POST", body: encode({}) });
    expect(posted.status).toBe(404);
  });

  test("serves the export's bytes, and only for GET", async () => {
    const { base: documentedBase } = await documented();
    const response = await fetch(`${documentedBase}${OPENAPI}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    // The endpoint and `acker openapi` publish one encoding of one document.
    const served = new Uint8Array(await response.arrayBuffer());
    expect(served).toEqual(
      Uint8Array.from(openApiBytes(openApiDocument(new Registry(functions), info))),
    );

    const document = JSON.parse(new TextDecoder().decode(served)) as Ctx;
    expect(document.info).toEqual({ title: "notes-app", version: "4.2.0" });
    expect(Object.keys(document.paths)).toContain(httpPath("api.notes.list"));
    // The same per-function flags the surface serves: hidden stays callable but
    // undocumented, and unexposed appears nowhere.
    expect(document.paths[httpPath("api.notes.numbers")]).toBeUndefined();
    expect(document.paths[httpPath("api.notes.hidden")]).toBeUndefined();

    const wrongMethod = await fetch(`${documentedBase}${OPENAPI}`, {
      method: "POST",
      body: encode({}),
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET, OPTIONS");
  });

  test("assembles the document while modules load, so it never fails a caller", async () => {
    // A non-finite literal crosses the wire as itself, so the codec registers
    // it; only a JSON Schema cannot express it, and module loading says so
    // rather than the first caller of a served path.
    await expect(documented({
      notes: {
        latest: query({
          access: "public",
          http: true,
          args: {},
          returns: v.literal(Number.NaN),
          handler: () => Number.NaN,
        }),
      },
    })).rejects.toThrow(/function "api\.notes\.latest" returns cannot be documented/);
  });

  test("serves the bytes it cached, never a fresh walk of the registry", async () => {
    const { base: documentedBase, registry } = await documented();
    const first = await (await fetch(`${documentedBase}${OPENAPI}`)).text();
    expect((JSON.parse(first) as Ctx).paths[httpPath("api.notes.list")]).toBeDefined();

    // The registry is immutable after load; emptying it is only a probe, and a
    // document assembled per request could not still describe what it lost.
    registry.exposed.clear();
    expect(await (await fetch(`${documentedBase}${OPENAPI}`)).text()).toBe(first);
  });
});

describe("WebSocket Session transport", () => {
  test("handles hello, query, subscription, mutation, and filtered event contracts", async () => {
    const client = await connectWebSocket(`ws://127.0.0.1:${server.port}/_ws`, {
      kind: "bearer",
      token: "user-token",
    });
    expect(verifier.verified).toEqual(["user-token"]);

    client.send({ t: "q", id: 1, ref: "api.notes.list", args: { rank: 1n } });
    expect(await within(client.next())).toEqual({
      t: "ok",
      id: 1,
      kind: "query",
      value: [],
    });

    client.send({ t: "sub", id: 2, ref: "api.notes.list", args: { rank: 1n } });
    expect(await within(client.next())).toMatchObject({
      t: "transition",
      id: 2,
      transition: { kind: "reset", value: [] },
    });

    client.send({ t: "sub", id: 3, ref: "api.events.beeps", args: {} });
    expect(await within(client.next())).toMatchObject({
      t: "event",
      id: 3,
      event: { kind: "reset" },
    });

    const mutationRequestId = uuidV7(1);
    client.send({
      t: "m",
      id: 4,
      ref: "api.notes.add",
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
    const client = await rawWebSocket(`ws://127.0.0.1:${server.port}/_ws`);
    client.send({
      v: ACKERDB_VERSION,
      t: "hello",
      clientSessionId: "raw-request-byte-limit",
      credential: { kind: "anonymous" },
    });
    expect(await within(client.next())).toMatchObject({ t: "welcome" });

    const canonical = encode({
      t: "q",
      id: 1,
      ref: "api.notes.list",
      args: { rank: 1n },
    });
    const canonicalBytes = Buffer.byteLength(canonical);
    expect(canonicalBytes).toBeLessThan(limits.maxRequestBytes);
    const exact = " ".repeat(limits.maxRequestBytes - canonicalBytes) + canonical;
    expect(Buffer.byteLength(exact)).toBe(limits.maxRequestBytes);

    client.socket.send(exact);
    expect(await within(client.next())).toMatchObject({
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
      v: ACKERDB_VERSION,
      t: "err",
      id: null,
      outcome: { code: "overloaded", resource: "operation" },
    });
    expect((await within(client.closed())).code).toBe(1013);
  });

  test("accepts valid binary UTF-8 at the exact request limit", async () => {
    const client = await rawWebSocket(`ws://127.0.0.1:${server.port}/_ws`);
    client.send({
      v: ACKERDB_VERSION,
      t: "hello",
      clientSessionId: "binary-request-byte-limit",
      credential: { kind: "anonymous" },
    });
    expect(await within(client.next())).toMatchObject({ t: "welcome" });

    const mutationRequestId = uuidV7(2);
    const canonical = encode({
      t: "m",
      id: 2,
      ref: "api.notes.add",
      args: { body: "é", rank: 1n },
      mutationRequestId,
      issuedAt: Date.now(),
    });
    const exact = " ".repeat(limits.maxRequestBytes - Buffer.byteLength(canonical)) + canonical;
    const binary = new TextEncoder().encode(exact);
    expect(binary.byteLength).toBe(limits.maxRequestBytes);

    client.socket.send(binary);
    expect(await within(client.next())).toMatchObject({
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
    const client = await rawWebSocket(`ws://127.0.0.1:${server.port}/_ws`);
    client.socket.send(new Uint8Array([0xc3, 0x28]));

    expect(await within(client.next())).toMatchObject({
      v: ACKERDB_VERSION,
      t: "err",
      id: null,
      outcome: { code: "malformed" },
    });
    expect((await within(client.closed())).code).toBe(1002);
  });

  test("bounds malformed and one-byte-over frames, then lets Bun reject larger payloads", async () => {
    const malformed = await rawWebSocket(`ws://127.0.0.1:${server.port}/_ws`);
    malformed.socket.send("{");
    expect(await within(malformed.next())).toMatchObject({
      v: ACKERDB_VERSION,
      t: "err",
      id: null,
      outcome: { code: "malformed" },
    });
    expect((await within(malformed.closed())).code).toBe(1002);
    await eventually(() => server.status().connections === 0);

    const oneByteOver = await rawWebSocket(`ws://127.0.0.1:${server.port}/_ws`);
    oneByteOver.socket.send("x".repeat(limits.maxFrameBytes + 1));
    expect(await within(oneByteOver.next())).toMatchObject({
      v: ACKERDB_VERSION,
      t: "err",
      id: null,
      outcome: { code: "overloaded", resource: "connection" },
    });
    expect((await within(oneByteOver.closed())).code).toBe(1013);
    await eventually(() => server.status().connections === 0);

    const oversized = await rawWebSocket(`ws://127.0.0.1:${server.port}/_ws`);
    oversized.socket.send("x".repeat(limits.maxFrameBytes + 2));
    const result = await within(Promise.race([
      oversized.next().then((frame) => ({ kind: "frame" as const, frame })),
      oversized.closed().then((event) => ({ kind: "closed" as const, event })),
    ]));
    expect(result.kind).toBe("closed");
    if (result.kind === "closed") expect(result.event.code).toBe(1006);
  });

  test("refuses another build's hello as a mixed install, before anything is dispatched", async () => {
    // The handshake parser is the whole pre-session surface, so a mismatched
    // build is turned away on its greeting and never reaches a dispatch.
    const mixed = await rawWebSocket(`ws://127.0.0.1:${server.port}/_ws`);
    mixed.socket.send(encode({
      v: "0.0.1",
      t: "hello",
      clientSessionId: "mixed-install",
      credential: { kind: "anonymous" },
    }));
    expect(await within(mixed.next())).toMatchObject({
      v: ACKERDB_VERSION,
      t: "err",
      id: null,
      outcome: {
        code: "version_mismatch",
        retryable: false,
        message: `this application runs AckerDB ${ACKERDB_VERSION} and this client is 0.0.1` +
          " — install matching versions",
      },
    });
    expect((await within(mixed.closed())).code).toBe(1002);
    await eventually(() => server.status().connections === 0);

    // A connection that opens with anything else never reaches the version
    // comparison, and should not pretend to: a session frame carries no
    // version, so the honest refusal is that it did not greet.
    const ungreeted = await rawWebSocket(`ws://127.0.0.1:${server.port}/_ws`);
    ungreeted.socket.send(encode({ t: "q", id: 1, ref: "api.notes.list", args: {} }));
    expect(await within(ungreeted.next())).toMatchObject({
      t: "err",
      id: null,
      outcome: { code: "malformed", message: "the first client frame must be a hello" },
    });
    expect((await within(ungreeted.closed())).code).toBe(1002);
    await eventually(() => server.status().connections === 0);
  });

  test("counts upgraded pre-hello sockets against connection admission", async () => {
    const first = await rawWebSocket(`ws://127.0.0.1:${server.port}/_ws`);
    expect(server.status().connections).toBe(1);

    const second = new WebSocket(`ws://127.0.0.1:${server.port}/_ws`);
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
    const fairDirectory = mkdtempSync(join(tmpdir(), "ackerdb-ws-fairness-"));
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
    const fairServer = new AckerDBServer({ limits: fairLimits, port: 0 });
    const fairRuntime = new Runtime({
      engine: fairEngine,
      registry: fairServer.loadFunctionModules(functions),
      verifier: new TestVerifier(),
      limits: fairLimits,
    });
    await fairRuntime.start();
    fairServer.activate(fairRuntime);
    const fairBase = `http://127.0.0.1:${fairServer.port}`;
    const wsUrl = `ws://127.0.0.1:${fairServer.port}/_ws`;
    const clients: WsClient[] = [];

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

      excess.send({ t: "q", id: 103, ref: "api.notes.list", args: { rank: 1n } });
      expect(await within(excess.next())).toMatchObject({
        t: "err",
        id: 103,
        outcome: { code: "overloaded", retryable: true, resource: "operation" },
      });

      const samePrincipalHttp = await fetch(`${fairBase}${httpPath("api.notes.echo")}`, {
        method: "POST",
        headers: { authorization: "Bearer user-rotated-token" },
        body: JSON.stringify({ value: "ok" }),
      });
      expect(samePrincipalHttp.status).toBe(429);
      expect(JSON.parse(await samePrincipalHttp.text())).toMatchObject({
        code: "overloaded",
        retryable: true,
        resource: "operation",
      });

      cold.send({ t: "q", id: 105, ref: "api.notes.list", args: { rank: 1n } });
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

      const spoofedAnonymous = await fetch(`${fairBase}${httpPath("api.notes.echo")}`, {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.99" },
        body: JSON.stringify({ value: "ok" }),
      });
      expect(spoofedAnonymous.status).toBe(429);
      expect(JSON.parse(await spoofedAnonymous.text())).toMatchObject({
        code: "overloaded",
        retryable: true,
        resource: "operation",
      });

      const verifiedCold = await fetch(`${fairBase}${httpPath("api.notes.echo")}`, {
        method: "POST",
        headers: { authorization: "Bearer user-two-token" },
        body: JSON.stringify({ value: "cold" }),
      });
      expect(verifiedCold.status).toBe(200);
      expect(JSON.parse(await verifiedCold.text())).toBe("cold");

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
    const overlapDir = mkdtempSync(join(tmpdir(), "ackerdb-overlap-"));
    const overlapEngine = new Engine(schema, join(overlapDir, "data.db"));
    reconcile(overlapEngine);
    const overlapLimits = defineServiceLimits({ ...limits, maxConnections: 2 });
    const overlapServer = new AckerDBServer({ limits: overlapLimits, port: 0 });
    const overlapRuntime = new Runtime({
      engine: overlapEngine,
      registry: overlapServer.loadFunctionModules(functions),
      limits: overlapLimits,
    });
    await overlapRuntime.start();
    overlapServer.activate(overlapRuntime);
    const url = `ws://127.0.0.1:${overlapServer.port}/_ws`;
    const sessionId = "overlapping-session";
    const open = async (): Promise<WsClient> => {
      const client = await rawWebSocket(url);
      client.send({
        v: ACKERDB_VERSION,
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
    const client = await connectWebSocket(`ws://127.0.0.1:${server.port}/_ws`);
    longSseStarted = deferred<void>();
    const response = await fetch(`${base}${httpPath("api.notes.stayOpen")}`, { method: "POST" });
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

  test("closes admission after Runtime drain and bounds an already-admitted slow ACK", async () => {
    const slowDirectory = mkdtempSync(join(tmpdir(), "ackerdb-slow-ack-drain-"));
    const slowEngine = new Engine(schema, join(slowDirectory, "data.db"));
    reconcile(slowEngine);
    const slowLimits = defineServiceLimits({
      ...limits,
      readQueue: { ...limits.readQueue, maxAgeMs: 500 },
    });
    const slowServer = new AckerDBServer({ limits: slowLimits, port: 0 });
    const slowRuntime = new Runtime({
      engine: slowEngine,
      registry: slowServer.loadFunctionModules(functions),
      limits: slowLimits,
    });
    await slowRuntime.start();
    slowServer.activate(slowRuntime);
    const slowBase = `http://127.0.0.1:${slowServer.port}`;
    const stalledCreditController = new AbortController();
    try {
      longSseStarted = deferred<void>();
      const response = await fetch(`${slowBase}${httpPath("api.notes.stayOpen")}`, { method: "POST" });
      await within(longSseStarted.promise);
      const sse = readSse(response);
      const started = await within(sse.next());
      expect((await acknowledgeSse(slowBase, sse.streamId, started!)).status).toBe(204);

      const startedAt = performance.now();
      const drain = slowServer.drain();
      const terminal = await within(sse.next());
      expect(terminal).toMatchObject({ t: "sse_error", outcome: { code: "draining" } });
      const stalledCredit = fetch(`${slowBase}/_sse/ack`, {
        method: "POST",
        body: stalledBody(),
        signal: stalledCreditController.signal,
      }).catch(() => undefined);
      await eventually(() => slowServer.status().httpIngress === 1);

      expect((await acknowledgeSse(slowBase, sse.streamId, terminal!)).status).toBe(204);
      expect(await sse.next()).toBeNull();
      await eventually(() => slowRuntime.status().state === "stopped");
      expect(slowServer.state).toBe("draining");
      expect(slowServer.status()).toMatchObject({ httpIngress: 1, httpFairnessKeys: 1 });

      const refusedCredit = await acknowledgeSse(slowBase, sse.streamId, terminal!);
      expect(refusedCredit.status).toBe(503);
      const failure = await drain.then(
        () => undefined,
        (error: unknown) => error,
      );
      const elapsed = performance.now() - startedAt;
      expect(failure).toMatchObject({
        code: "deadline_exceeded",
        message: "graceful shutdown deadline exceeded",
        resource: "connection",
      });
      expect(elapsed).toBeGreaterThanOrEqual(slowLimits.gracefulShutdownMs - 15);
      expect(elapsed).toBeLessThan(slowLimits.gracefulShutdownMs + 500);
      expect(slowServer.state).toBe("failed");
      expect(slowRuntime.status().state).toBe("stopped");
      await within(stalledCredit);
      await eventually(() => slowServer.status().httpIngress === 0);
    } finally {
      stalledCreditController.abort("slow ACK test complete");
      await slowServer.drain().catch(() => {});
      await slowRuntime.drain().catch(() => {});
      slowEngine.close("unclean");
      rmSync(slowDirectory, { recursive: true, force: true });
    }
  });

  test("force closes and preserves unclean storage when an admitted operation stalls", async () => {
    blockedProcedureStarted = deferred<void>();
    blockedProcedureRelease = deferred<void>();
    const transport = fetch(`${base}${httpPath("api.notes.block")}`, {
      method: "POST",
      body: JSON.stringify({}),
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
    const refusedDuringDrain = await fetch(`${base}${httpPath("api.notes.echo")}`, {
      method: "POST",
      body: JSON.stringify({ value: "x" }),
    });
    expect(refusedDuringDrain.status).toBe(503);
    expect(JSON.parse(await refusedDuringDrain.text())).toMatchObject({
      code: "draining",
      retryable: true,
      retryAfterMs: 1_000,
    });
    let failure: unknown;
    try {
      await draining;
    } catch (error) {
      failure = error;
    }
    const elapsed = performance.now() - startedAt;

    expect(failure).toBeInstanceOf(AckerDBError);
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
        persisted.query("SELECT clean_shutdown FROM _ackerdb_state WHERE singleton = 1").get(),
      ).toEqual({ clean_shutdown: 0n });
    } finally {
      persisted.close();
    }
  });

  test("keeps the connection deadline when only Session shutdown stalls", async () => {
    blockedCredentialStarted = deferred<void>();
    blockedCredentialRelease = deferred<void>();
    const client = await rawWebSocket(`ws://127.0.0.1:${server.port}/_ws`);
    try {
      client.send({
        v: ACKERDB_VERSION,
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

      expect(failure).toBeInstanceOf(AckerDBError);
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
