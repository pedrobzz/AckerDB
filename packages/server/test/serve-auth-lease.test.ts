import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  parseCallResponse,
  parseSseMessage,
  type SseMessage,
} from "@dbzz/core";
import type {
  CredentialVerifier,
  PrincipalInvalidation,
  VerifiedCredential,
} from "../src/auth.ts";
import { dbz } from "../src/dbz.ts";
import { Engine } from "../src/engine.ts";
import { procedure, sseProcedure } from "../src/functions.ts";
import { reconcile } from "../src/reconcile.ts";
import { Registry } from "../src/registry.ts";
import { Runtime } from "../src/runtime.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import { serve, type DbzzServer } from "../src/serve.ts";

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

async function within<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error("operation timed out");
    }),
  ]);
}

async function eventually(check: () => boolean): Promise<void> {
  await within((async () => {
    while (!check()) await Bun.sleep(2);
  })());
}

async function readSseMessage(
  reader: { read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }> },
): Promise<SseMessage> {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const part = await within(reader.read());
    if (part.done || part.value === undefined) {
      throw new Error("SSE response ended before its next frame");
    }
    text += decoder.decode(part.value, { stream: true });
    const boundary = text.indexOf("\n\n");
    if (boundary < 0) continue;
    if (!text.startsWith("data: ") || text.length !== boundary + 2) {
      throw new Error(`invalid receiver-credited SSE frame ${JSON.stringify(text)}`);
    }
    return parseSseMessage(decode(text.slice(6, boundary)));
  }
}

function acknowledgeSse(
  base: string,
  stream: string,
  message: SseMessage,
  authorization?: string,
): Promise<Response> {
  return fetch(`${base}/api/sse/ack`, {
    method: "POST",
    headers: authorization === undefined ? {} : { authorization },
    body: encode({
      v: PROTOCOL_VERSION,
      t: "sse_ack",
      stream,
      seq: message.seq,
      proof: message.proof,
    }),
  });
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), {
    once: true,
  }));
}

const schema = defineSchema({
  state: defineTable({
    id: dbz.primaryKey(),
  }),
});

// Transport behavior is under test; generated application types are irrelevant here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

let blockedProcedureStarted = deferred<void>();
let blockedSseStarted = deferred<void>();

const functions = {
  auth: {
    identity: procedure({
      access: "authenticated",
      args: {},
      handler: (ctx: Ctx) => ctx.auth.subject,
    }),
    block: procedure({
      access: "authenticated",
      args: {},
      handler: async (ctx: Ctx) => {
        blockedProcedureStarted.resolve();
        await waitForAbort(ctx.abortSignal);
        return "must not escape after revocation";
      },
    }),
    once: sseProcedure({
      access: "authenticated",
      args: {},
      yields: dbz.object({ phase: dbz.string() }),
      handler: async function* () {
        yield { phase: "once" };
      },
    }),
    stream: sseProcedure({
      access: "authenticated",
      args: {},
      yields: dbz.object({ phase: dbz.string() }),
      handler: async function* (ctx: Ctx) {
        blockedSseStarted.resolve();
        yield { phase: "started" };
        await waitForAbort(ctx.abortSignal);
      },
    }),
  },
};

class LeaseVerifier implements CredentialVerifier {
  readonly revocationBound = { kind: "invalidation", deadlineMs: 1 } as const;
  readonly expirations = new Map<string, number>();
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  private readonly listeners = new Set<(invalidation: PrincipalInvalidation) => void>();

  get activeListeners(): number {
    return this.listeners.size;
  }

  async verify(token: string): Promise<VerifiedCredential> {
    return {
      kind: "user",
      issuer: "https://issuer.example",
      subject: token,
      claims: { role: "member" },
      expiresAt: this.expirations.get(token) ?? Date.now() + 60_000,
      tokenId: `id-${token}`,
    };
  }

  subscribeInvalidation(listener: (invalidation: PrincipalInvalidation) => void): () => void {
    this.subscribeCalls++;
    this.listeners.add(listener);
    return () => {
      this.unsubscribeCalls++;
      this.listeners.delete(listener);
    };
  }

  emit(invalidation: PrincipalInvalidation): void {
    for (const listener of [...this.listeners]) listener(invalidation);
  }
}

describe("HTTP and SSE credential leases", () => {
  let directory: string;
  let engine: Engine;
  let runtime: Runtime;
  let verifier: LeaseVerifier;
  let server: DbzzServer;
  let base: string;
  let requestId: number;

  beforeEach(() => {
    blockedProcedureStarted = deferred<void>();
    blockedSseStarted = deferred<void>();
    directory = mkdtempSync(join(tmpdir(), "dbzz-serve-auth-lease-"));
    engine = new Engine(schema, join(directory, "data.db"));
    reconcile(engine);
    runtime = new Runtime({
      engine,
      registry: new Registry(functions),
      telemetry: false,
    });
    verifier = new LeaseVerifier();
    server = serve({ runtime, verifier, port: 0 });
    base = `http://127.0.0.1:${server.port}`;
    requestId = 0;
  });

  afterEach(async () => {
    await server.drain().catch(() => {});
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  });

  const request = async (
    path: "call" | "sse",
    ref: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<Response> =>
    fetch(`${base}/api/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      ...(signal === undefined ? {} : { signal }),
      body: encode({
        v: PROTOCOL_VERSION,
        t: "call",
        id: ++requestId,
        ref,
        args: {},
      }),
    });

  test("validates the verifier before opening another HTTP listener", () => {
    const invalid = Object.create(verifier) as LeaseVerifier;
    Object.defineProperty(invalid, "revocationBound", {
      value: { kind: "invalidation", deadlineMs: 5_001 },
    });
    expect(() => serve({ runtime, verifier: invalid, port: 0 })).toThrow(
      "verifier invalidation deadlineMs cannot exceed revocationDeadlineMs",
    );
  });

  test("releases a successful procedure lease immediately after response handoff", async () => {
    const response = await request("call", "auth.identity", "user-success");
    expect(response.status).toBe(200);
    expect(parseCallResponse(decode(await response.text()))).toMatchObject({
      t: "ok",
      kind: "procedure",
      value: "user-success",
    });
    expect(verifier.activeListeners).toBe(0);
    expect(verifier.subscribeCalls).toBe(1);
    expect(verifier.unsubscribeCalls).toBe(1);
  });

  test("ignores unrelated invalidation then fails a live procedure closed on a match", async () => {
    const pending = request("call", "auth.block", "user-revoked");
    await within(blockedProcedureStarted.promise);
    expect(verifier.activeListeners).toBe(1);

    verifier.emit({ issuer: "https://issuer.example", subject: "someone-else" });
    await Bun.sleep(5);
    expect(verifier.activeListeners).toBe(1);

    verifier.emit({
      issuer: "https://issuer.example",
      subject: "user-revoked",
      tokenId: "id-user-revoked",
    });
    const response = await within(pending);
    expect(response.status).toBe(401);
    expect(parseCallResponse(decode(await response.text()))).toMatchObject({
      t: "err",
      outcome: { code: "unauthenticated", message: "credential revoked" },
    });
    expect(verifier.activeListeners).toBe(0);
  });

  test("aborts a live procedure at the verified expiration timestamp", async () => {
    verifier.expirations.set("user-expiring", Date.now() + 40);
    const pending = request("call", "auth.block", "user-expiring");
    await within(blockedProcedureStarted.promise);

    const response = await within(pending);
    expect(response.status).toBe(401);
    expect(parseCallResponse(decode(await response.text()))).toMatchObject({
      t: "err",
      outcome: { code: "unauthenticated", message: "credential expired" },
    });
    expect(verifier.activeListeners).toBe(0);
  });

  test("owns an SSE lease through normal body completion", async () => {
    const complete = await request("sse", "auth.once", "user-complete");
    const streamId = complete.headers.get("x-dbzz-sse-stream");
    if (streamId === null || complete.body === null) throw new Error("missing SSE response ownership");
    const reader = complete.body.getReader();
    const chunk = await readSseMessage(reader);
    expect(chunk).toMatchObject({ t: "sse_chunk", value: { phase: "once" } });
    expect(verifier.activeListeners).toBe(1);

    const subscribed = verifier.subscribeCalls;
    expect((await acknowledgeSse(
      base,
      streamId,
      chunk,
      "Bearer ack-must-not-create-an-auth-lease",
    )).status).toBe(204);
    expect(verifier.subscribeCalls).toBe(subscribed);
    const terminal = await readSseMessage(reader);
    expect(terminal.t).toBe("sse_done");
    expect((await acknowledgeSse(base, streamId, terminal)).status).toBe(204);
    expect(await within(reader.read())).toEqual({ done: true, value: undefined });
    reader.releaseLock();
    await eventually(() => verifier.activeListeners === 0);
  });

  test("releases an SSE lease when the response consumer cancels", async () => {
    const cancellation = new AbortController();
    const canceled = await request("sse", "auth.stream", "user-cancel", cancellation.signal);
    await within(blockedSseStarted.promise);
    const canceledReader = canceled.body!.getReader();
    expect(new TextDecoder().decode((await within(canceledReader.read())).value)).toContain(
      '"phase":"started"',
    );
    expect(verifier.activeListeners).toBe(1);
    const closed = canceledReader.read().catch(() => ({ done: true as const }));
    cancellation.abort("test cancellation");
    await eventually(() => verifier.activeListeners === 0);
    await closed;
  });

  test("fails a live SSE body closed on matching invalidation", async () => {
    const revoked = await request("sse", "auth.stream", "user-stream-revoked");
    await within(blockedSseStarted.promise);
    const revokedReader = revoked.body!.getReader();
    expect(new TextDecoder().decode((await within(revokedReader.read())).value)).toContain(
      '"phase":"started"',
    );
    verifier.emit({
      issuer: "https://issuer.example",
      subject: "user-stream-revoked",
    });
    await eventually(() => verifier.activeListeners === 0);
    expect(await within(revokedReader.read())).toMatchObject({ done: true });
  });
});
