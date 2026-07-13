import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  parseCallResponse,
  parseServerMessage,
  type CallResponse,
  type ServerMessage,
} from "@dbzz/core";
import type {
  CredentialVerifier,
  PrincipalInvalidation,
  VerifiedPrincipal,
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
import { serve } from "../src/serve.ts";

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
    identity: procedure({
      access: "authenticated",
      args: {},
      handler: (ctx: Ctx) => ({ kind: ctx.auth.kind, subject: ctx.auth.subject }),
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
      handler: (ctx: Ctx, args: Ctx) => {
        ctx.stream.write({ type: "text-delta", delta: args.text });
      },
    }),
    failLate: sseProcedure({
      access: "public",
      args: {},
      handler: (ctx: Ctx) => {
        ctx.stream.write({ phase: "started" });
        throw new DbzzError("unavailable", "stream failed", { resource: "sse" });
      },
    }),
    stayOpen: sseProcedure({
      access: "public",
      args: {},
      handler: async (ctx: Ctx) => {
        ctx.stream.write({ phase: "started" });
        longSseStarted?.resolve();
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
  },
};

class TestVerifier implements CredentialVerifier {
  readonly revocationBound = { kind: "token-expiration" } as const;
  readonly verified: string[] = [];

  async verify(token: string): Promise<VerifiedPrincipal> {
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
      case "workload-token":
        return { ...common, kind: "workload", claims: { scope: "metrics dbzz:status" } };
      case "workload-alias-token":
        return { ...common, kind: "workload", claims: { scope: "dbzz:status-extra" } };
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
  engine.close();
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

describe("health and protected status", () => {
  test("exposes detail-free liveness/readiness, removes /health, and follows Runtime readiness", async () => {
    expect(await (await fetch(`${base}/live`)).json()).toEqual({ version: 1, live: true });
    expect(await (await fetch(`${base}/ready`)).json()).toEqual({ version: 1, ready: true });
    expect((await fetch(`${base}/health`)).status).toBe(404);

    await runtime.drain();
    const ready = await fetch(`${base}/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ version: 1, ready: false });
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
      runtime: { state: "ready" },
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
        value: { kind: "user", subject: "user-token" },
      },
    });
    expect(verifier.verified).toEqual(["user-token"]);
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
  test("keeps pre-stream HTTP errors distinct from terminal stream errors", async () => {
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
    expect(success.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    expect(await success.text()).toBe('data: {"type":"text-delta","delta":"hello"}\n\ndata: [DONE]\n\n');

    const late = await fetch(`${base}/api/sse`, {
      method: "POST",
      body: encode({ v: PROTOCOL_VERSION, t: "call", id: 3, ref: "notes.failLate", args: {} }),
    });
    expect(late.status).toBe(200);
    const terminal = await late.text();
    expect(terminal).toContain('data: {"phase":"started"}\n\n');
    expect(terminal).toContain("event: dbzz-error\n");
    expect(terminal).toContain('"code":"unavailable"');
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
    const stream = await response.text();
    expect(stream).toContain('data: {"phase":"started"}\n\n');
    expect(stream).toContain("event: dbzz-error\n");
    expect(stream).toContain('"code":"draining"');
    expect(stream).toContain('"retryable":true');

    await within(drain);
    expect(server.state).toBe("stopped");
    expect(runtime.status().state).toBe("stopped");
    expect(server.status().connections).toBe(0);
    expect(server.status().outboundBytes).toBe(0);
  });

  test("force closes and fails within the deadline when an admitted operation stalls", async () => {
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
    let failure: unknown;
    try {
      await server.drain();
    } catch (error) {
      failure = error;
    }
    const elapsed = performance.now() - startedAt;

    expect(failure).toBeInstanceOf(DbzzError);
    expect(failure).toMatchObject({ code: "deadline_exceeded", resource: "operation" });
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
  });
});
