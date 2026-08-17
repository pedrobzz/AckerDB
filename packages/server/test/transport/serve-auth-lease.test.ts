import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACKERDB_VERSION,
  decode,
  encode,
  parseSseMessage,
  type SseMessage,
} from "@ackerdb/core";
import type {
  CredentialVerifier,
  PrincipalInvalidation,
  VerifiedCredential,
} from "../../src/auth/credentials.ts";
import { v } from "../../src/validation/v.ts";
import { Engine } from "../../src/database/engine.ts";
import { procedure, sseProcedure } from "../../src/app/functions.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { PRODUCTION_LIMITS } from "../../src/runtime/limits.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { AckerDBServer } from "../../src/transport/server.ts";
import { deferred, waitForAbort, within } from "ackerdb-test-support/async";

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
  return fetch(`${base}/_sse/ack`, {
    method: "POST",
    headers: authorization === undefined ? {} : { authorization },
    body: encode({
      v: ACKERDB_VERSION,
      t: "sse_ack",
      stream,
      seq: message.seq,
      proof: message.proof,
    }),
  });
}

const schema = defineSchema({
  state: defineTable({
    id: v.primaryKey(),
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
      http: true,
      args: {},
      handler: (ctx: Ctx) => ctx.auth.subject,
    }),
    block: procedure({
      access: "authenticated",
      http: true,
      args: {},
      handler: async (ctx: Ctx) => {
        blockedProcedureStarted.resolve();
        await waitForAbort(ctx.abortSignal);
        return "must not escape after revocation";
      },
    }),
    once: sseProcedure({
      access: "authenticated",
      http: true,
      args: {},
      yields: v.object({ phase: v.string() }),
      handler: async function* () {
        yield { phase: "once" };
      },
    }),
    stream: sseProcedure({
      access: "authenticated",
      http: true,
      args: {},
      yields: v.object({ phase: v.string() }),
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
  let server: AckerDBServer;
  let base: string;

  beforeEach(async () => {
    blockedProcedureStarted = deferred<void>();
    blockedSseStarted = deferred<void>();
    directory = mkdtempSync(join(tmpdir(), "ackerdb-serve-auth-lease-"));
    engine = new Engine(schema, join(directory, "data.db"));
    reconcile(engine);
    verifier = new LeaseVerifier();
    server = new AckerDBServer({ limits: PRODUCTION_LIMITS, port: 0 });
    runtime = new Runtime({
      engine,
      registry: server.loadFunctionModules(functions),
      verifier,
    });
    await runtime.start();
    server.activate(runtime);
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.drain().catch(() => {});
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  });

  /** Procedures and streams are both path-addressed calls with a raw args body. */
  const call = async (
    address: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<Response> =>
    fetch(`${base}/api/${address.replaceAll(".", "/")}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      ...(signal === undefined ? {} : { signal }),
      body: encode({}),
    });

  test("validates the Runtime-owned verifier before serving", () => {
    const invalid = Object.create(verifier) as LeaseVerifier;
    Object.defineProperty(invalid, "revocationBound", {
      value: { kind: "invalidation", deadlineMs: 5_001 },
    });
    expect(() => new Runtime({
      engine,
      registry: new Registry(functions),
      verifier: invalid,
    })).toThrow(
      "verifier invalidation deadlineMs cannot exceed revocationDeadlineMs",
    );
  });

  test("releases a successful procedure lease immediately after response handoff", async () => {
    const response = await call("auth.identity", "user-success");
    expect(response.status).toBe(200);
    expect(decode(await response.text())).toBe("user-success");
    expect(verifier.activeListeners).toBe(0);
    expect(verifier.subscribeCalls).toBe(1);
    expect(verifier.unsubscribeCalls).toBe(1);
  });

  test("ignores unrelated invalidation then fails a live procedure closed on a match", async () => {
    const pending = call("auth.block", "user-revoked");
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
    expect(decode(await response.text())).toMatchObject({
      code: "unauthenticated",
      message: "credential revoked",
    });
    expect(verifier.activeListeners).toBe(0);
  });

  test("aborts a live procedure at the verified expiration timestamp", async () => {
    verifier.expirations.set("user-expiring", Date.now() + 40);
    const pending = call("auth.block", "user-expiring");
    await within(blockedProcedureStarted.promise);

    const response = await within(pending);
    expect(response.status).toBe(401);
    expect(decode(await response.text())).toMatchObject({
      code: "unauthenticated",
      message: "credential expired",
    });
    expect(verifier.activeListeners).toBe(0);
  });

  test("owns an SSE lease through normal body completion", async () => {
    const complete = await call("auth.once", "user-complete");
    const streamId = complete.headers.get("x-ackerdb-sse-stream");
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
    const canceled = await call("auth.stream", "user-cancel", cancellation.signal);
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
    const revoked = await call("auth.stream", "user-stream-revoked");
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
    // The lease is released and the body ends. Note this is the same terminal
    // signal "owns an SSE lease through normal body completion" observes: at
    // the transport level a revoked stream is not distinguishable from a
    // finished one, so a consumer that must tell them apart has to read the
    // frames, not the body's end.
    expect(await within(revokedReader.read())).toMatchObject({ done: true });
  });
});
