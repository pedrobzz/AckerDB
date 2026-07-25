import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  Err,
  Status,
  decode,
  encode,
  parseCallResponse,
  parseSseMessage,
  type MutationMessage,
  type ProcedureMessage,
  type SseMessage,
} from "@dbzz/core";
import {
  ANONYMOUS_PRINCIPAL,
  type Principal,
  type UserPrincipal,
} from "../../src/auth/credentials.ts";
import { callerFairnessKey } from "../../src/runtime/caller.ts";
import { v } from "../../src/validation/v.ts";
import { Engine } from "../../src/database/engine.ts";
import { DbzzError } from "../../src/shared/errors.ts";
import { mutation, procedure, query, sseProcedure } from "../../src/app/functions.ts";
import { PRODUCTION_LIMITS, type ServiceLimits } from "../../src/runtime/limits.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { Registry } from "../../src/app/registry.ts";
import { carryHttpRequestProvenance } from "../../src/runtime/request-provenance.ts";
import {
  Runtime,
  type RuntimeOptions,
  type RuntimeProcedureResponse,
  type RuntimeSseResponse,
} from "../../src/runtime/runtime.ts";
import { defineEventTable, defineSchema, defineTable } from "../../src/schema/definition.ts";
import type {
  RuntimePublication,
  RuntimePublicationBatch,
  RuntimeRequest,
  SessionApplicationMessage,
  SessionRuntimeContext,
} from "../../src/realtime/session.ts";
import {
  Telemetry,
  type TelemetryRecord,
  type TelemetrySpanRecord,
} from "../../src/telemetry/telemetry.ts";

const TEST_SOURCE = Object.freeze({ family: "test", address: "runtime" });

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

async function settle(): Promise<void> {
  for (let turn = 0; turn < 24; turn++) await Promise.resolve();
}

function uuidV7(now = Date.now(), sequence = 0): string {
  const timestamp = now.toString(16).padStart(12, "0");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

function request<Message>(message: Message, bytes = Buffer.byteLength(encode(message))): RuntimeRequest<Message> {
  return { message, bytes };
}

const userIdentities = new Map<string, UserPrincipal["identity"]>();
let nextUserIdentity = 0n;

function user(subject: string): UserPrincipal {
  let identity = userIdentities.get(subject);
  if (identity === undefined) {
    identity = ++nextUserIdentity as UserPrincipal["identity"];
    userIdentities.set(subject, identity);
  }

  return Object.freeze({
    kind: "user",
    identity,
    issuer: "https://issuer.example",
    subject,
    claims: Object.freeze({ role: "member" }),
    expiresAt: Date.now() + 60_000,
    tokenId: `token-${subject}`,
  });
}

const eventAccessInputs: Array<{ ctx: object; args: object }> = [];
const eventMatchInputs: Array<{ row: object; args: object }> = [];

const schema = defineSchema({
  messages: defineTable({
    id: v.primaryKey(),
    channelId: v.bigint(),
    body: v.string(),
  }).index(["channelId"]),
  log: defineTable({
    id: v.primaryKey(),
    line: v.string(),
  }),
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
    access: (ctx, args) => {
      eventAccessInputs.push({ ctx, args });
      return ctx.auth.kind === "user";
    },
    matches: (row, args) => {
      eventMatchInputs.push({ row, args });
      return row.channelId === args.channelId;
    },
  }),
  reminders: defineTable({
    id: v.primaryKey(),
    message: v.string(),
    attempt: v.int(),
    at: v.scheduleAt(),
  }).scheduled("reminders.fire"),
});

// Tests exercise runtime ownership, not generated application types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

let queryGate: Deferred<void> | null = null;
let queryFailureGate: Deferred<void> | null = null;
let queryFailureEntered: Deferred<void> | null = null;
let revalidationGate: Deferred<void> | null = null;
let revalidationEntered: Deferred<void> | null = null;
let externalProcedureStarted: Deferred<void> | null = null;
let externalProcedureRelease: Deferred<void> | null = null;
let externalSseStarted: Deferred<void> | null = null;
let externalSseReturned: Deferred<void> | null = null;
let nestedMutationEntered: Deferred<void> | null = null;
let nestedMutationRelease: Deferred<void> | null = null;
let scheduledAttempts = 0;
let scheduledAttempt: number | null = null;
let mutationResultReads = 0;
let mutationResultValue: object = {};
let writeThenErrCalls = 0;

const functions = {
  messages: {
    list: query({
      access: "public",
      args: { channelId: v.bigint() },
      handler: (ctx: Ctx, args: Ctx) =>
        ctx.db.messages.query().where((row: Ctx) => row.channelId.eq(args.channelId)).collect(),
    }),
    parallelList: query({
      access: "public",
      args: { channelId: v.bigint() },
      handler: async (ctx: Ctx, args: Ctx) => {
        const rows = await ctx.db.messages
          .query()
          .where((row: Ctx) => row.channelId.eq(args.channelId))
          .collect();
        if (args.channelId === 1n && revalidationGate) {
          revalidationEntered?.resolve(undefined);
          await revalidationGate.promise;
        }
        return rows;
      },
    }),
    secure: query({
      access: "authenticated",
      args: {},
      handler: (ctx: Ctx) => ({ kind: ctx.auth.kind, subject: ctx.auth.subject }),
    }),
    block: query({
      access: "public",
      args: {},
      handler: async () => {
        await queryGate?.promise;
        return "released";
      },
    }),
    blockFail: query({
      access: "public",
      args: {},
      handler: async () => {
        queryFailureEntered?.resolve(undefined);
        await queryFailureGate?.promise;
        throw new Error("stale query failure");
      },
    }),
    largeQuery: query({
      access: "public",
      args: { size: v.int() },
      handler: (_ctx: Ctx, args: Ctx) => "x".repeat(args.size),
    }),
    nonWireQuery: query({
      access: "public",
      args: {},
      handler: () => Number.NaN,
    }),
    missing: query({
      access: "public",
      args: { id: v.bigint() },
      handler: (_ctx: Ctx, args: Ctx) =>
        Err("message-not-found", { id: args.id }, Status.NotFound),
    }),
    send: mutation({
      access: "public",
      args: { channelId: v.bigint(), body: v.string() },
      handler: async (ctx: Ctx, args: Ctx) => {
        const id = await ctx.db.messages.insert(args);
        await ctx.db.typing.insert({ channelId: args.channelId });
        await ctx.db.privateTyping.insert({ channelId: args.channelId });
        return id;
      },
    }),
    rewrite: mutation({
      access: "public",
      args: { id: v.bigint() },
      handler: async (ctx: Ctx, args: Ctx) => {
        const row = await ctx.db.messages.get(args.id);
        await ctx.db.messages.patch(args.id, { body: row.body });
      },
    }),
    fetchInside: mutation({
      access: "public",
      args: {},
      handler: async (ctx: Ctx) => {
        await ctx.db.messages.insert({ channelId: 1n, body: "rollback" });
        await fetch("data:text/plain,forbidden");
      },
    }),
    composeFail: mutation({
      access: "public",
      args: { channelId: v.bigint() },
      handler: async (ctx: Ctx, args: Ctx) => {
        await functions.messages.send(ctx, { channelId: args.channelId, body: "rollback" });
        throw new Error("compose failed");
      },
    }),
    writeThenErr: mutation({
      access: "public",
      args: { channelId: v.bigint() },
      handler: async (ctx: Ctx, args: Ctx) => {
        writeThenErrCalls++;
        await ctx.db.messages.insert({ channelId: args.channelId, body: "child-rolled-back" });
        return Err("stock-unavailable", { channelId: args.channelId }, Status.Conflict);
      },
    }),
    handleChildErr: mutation({
      access: "public",
      args: { channelId: v.bigint() },
      handler: async (ctx: Ctx, args: Ctx): Promise<string> => {
        await ctx.db.messages.insert({ channelId: args.channelId, body: "parent-before" });
        const child = await functions.messages.writeThenErr(ctx, args);
        if (!child.ok) {
          await ctx.db.messages.insert({ channelId: args.channelId, body: "parent-after" });
          return "queued";
        }
        return "unexpected";
      },
    }),
    propagateChildErr: mutation({
      access: "public",
      args: { channelId: v.bigint() },
      handler: async (ctx: Ctx, args: Ctx): Promise<unknown> => {
        await ctx.db.messages.insert({ channelId: args.channelId, body: "parent-rolled-back" });
        return functions.messages.writeThenErr(ctx, args);
      },
    }),
    throwAfterWrite: mutation({
      access: "public",
      args: { channelId: v.bigint() },
      handler: async (ctx: Ctx, args: Ctx) => {
        await ctx.db.messages.insert({ channelId: args.channelId, body: "throw-rolled-back" });
        throw new Error("storage exploded");
      },
    }),
    catchNestedThrow: mutation({
      access: "public",
      args: { channelId: v.bigint() },
      handler: async (ctx: Ctx, args: Ctx) => {
        await ctx.db.messages.insert({ channelId: args.channelId, body: "root-rolled-back" });
        try {
          await functions.messages.throwAfterWrite(ctx, args);
        } catch {
          return "claimed success";
        }
        return "unreachable";
      },
    }),
    catchDatabaseThrow: mutation({
      access: "public",
      args: { channelId: v.bigint() },
      handler: async (ctx: Ctx, args: Ctx) => {
        await ctx.db.messages.insert({
          channelId: args.channelId,
          body: "root-must-roll-back",
        });
        try {
          await ctx.db.messages.patch(9_999n, { body: "missing" });
        } catch {
          return "claimed success";
        }
        return "unreachable";
      },
    }),
    waitThenErr: mutation({
      access: "public",
      args: { channelId: v.bigint() },
      handler: async (ctx: Ctx, args: Ctx) => {
        await ctx.db.messages.insert({
          channelId: args.channelId,
          body: "nested-rolled-back",
        });
        nestedMutationEntered?.resolve(undefined);
        await nestedMutationRelease?.promise;
        return Err("stock-unavailable", { channelId: args.channelId }, Status.Conflict);
      },
    }),
    overlapNestedMutation: mutation({
      access: "public",
      args: { channelId: v.bigint() },
      handler: async (ctx: Ctx, args: Ctx): Promise<unknown> => {
        const child: Promise<unknown> = functions.messages.waitThenErr(ctx, args);
        await nestedMutationEntered?.promise;
        try {
          await ctx.db.messages.insert({
            channelId: args.channelId,
            body: "must-not-cross-child-savepoint",
          });
        } finally {
          nestedMutationRelease?.resolve(undefined);
        }
        return child;
      },
    }),
    largeResult: mutation({
      access: "public",
      args: { channelId: v.bigint(), size: v.int() },
      handler: async (ctx: Ctx, args: Ctx) => {
        await ctx.db.messages.insert({ channelId: args.channelId, body: "must-roll-back" });
        return "x".repeat(args.size);
      },
    }),
    canaryResult: mutation({
      access: "public",
      args: {},
      handler: () => mutationResultValue,
    }),
  },
  reminders: {
    fire: mutation({
      access: "system",
      args: { id: v.bigint(), message: v.string(), attempt: v.int(), at: v.float() },
      handler: async (ctx: Ctx, args: Ctx) => {
        scheduledAttempts++;
        scheduledAttempt = args.attempt;
        await ctx.db.log.insert({ line: `fired:${args.message}` });
        if (args.message === "fail") throw new Error("scheduled failure");
      },
    }),
    schedule: mutation({
      access: "public",
      args: { message: v.string(), attempt: v.int(), at: v.float() },
      handler: (ctx: Ctx, args: Ctx) => ctx.db.reminders.insert(args),
    }),
  },
  ops: {
    echo: procedure({
      access: "public",
      args: { value: v.string() },
      handler: (_ctx: Ctx, args: Ctx) => args.value,
    }),
    reject: procedure({
      access: "public",
      args: { reason: v.string() },
      handler: (_ctx: Ctx, args: Ctx) =>
        Err("procedure-rejected", { reason: args.reason }, Status.UnprocessableContent),
    }),
    block: procedure({
      access: "public",
      args: {},
      handler: async () => {
        externalProcedureStarted?.resolve(undefined);
        await externalProcedureRelease?.promise;
        return "released";
      },
    }),
    pipeline: procedure({
      access: "public",
      args: { channelId: v.bigint() },
      handler: async (ctx: Ctx, args: Ctx) => {
        const external = await (await fetch("data:text/plain,external")).text();
        const transaction = await ctx.tx(async (tx: Ctx) => {
          const sent = await functions.messages.send(
            tx,
            { channelId: args.channelId, body: external },
          );
          if (!sent.ok) return sent;
          return (await tx.db.messages.get(sent.data)).body;
        });
        if (!transaction.ok) return transaction;
        return { external, body: transaction.data };
      },
    }),
    nestedTx: procedure({
      access: "public",
      args: {},
      handler: (ctx: Ctx) => ctx.tx(() => ctx.tx(() => 1)),
    }),
    catchTxThrow: procedure({
      access: "public",
      args: { channelId: v.bigint() },
      handler: async (ctx: Ctx, args: Ctx) => {
        try {
          await ctx.tx(async (tx: Ctx) => {
            await tx.db.messages.insert({
              channelId: args.channelId,
              body: "tx-must-roll-back",
            });
            throw new Error("transaction storage failed");
          });
        } catch {
          return "claimed success";
        }
        return "unreachable";
      },
    }),
    failEmoji: procedure({
      access: "public",
      args: {},
      handler: () => {
        throw new DbzzError("conflict", "💥".repeat(512));
      },
    }),
    stream: sseProcedure({
      access: "public",
      args: { count: v.int() },
      yields: v.jsonb(),
      handler: async function* (ctx: Ctx, args: Ctx) {
        for (let index = 0; index < args.count; index++) {
          yield { type: "delta", value: index };
        }
        yield { type: "merged" };
        await ctx.tx((tx: Ctx) => tx.db.log.insert({ line: "streamed" }));
      },
    }),
    streamed: sseProcedure({
      access: "public",
      args: {},
      yields: v.jsonb(),
      handler: () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "merged" });
            controller.close();
          },
        }),
    }),
    invalidChunk: sseProcedure({
      access: "public",
      args: {},
      yields: v.object({ value: v.string() }),
      handler: async function* () {
        yield { value: "first" };
        yield { value: 2 as unknown as string };
      },
    }),
    failingStream: sseProcedure({
      access: "public",
      args: {},
      yields: v.jsonb(),
      handler: () => {
        throw new Error("stream failed");
      },
    }),
    waitForAbort: sseProcedure({
      access: "public",
      args: {},
      yields: v.jsonb(),
      handler: async function* (ctx: Ctx) {
        yield { phase: "started" };
        if (ctx.abortSignal.aborted) return;
        await new Promise<void>((resolve) => {
          ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    }),
    holdSse: sseProcedure({
      access: "public",
      args: {},
      yields: v.jsonb(),
      handler: async function* () {
        try {
          externalSseStarted?.resolve(undefined);
          yield { phase: "held" };
          yield { phase: "unreachable without acknowledgment" };
        } finally {
          externalSseReturned?.resolve(undefined);
        }
      },
    }),
  },
};

class SessionHarness {
  readonly publications: SessionApplicationMessage[] = [];
  readonly preparedPublications: RuntimePublication[] = [];
  beforePublish: ((publication: RuntimePublication) => void | Promise<void>) | undefined;
  context!: SessionRuntimeContext;
  private controller = new AbortController();

  constructor(
    readonly runtime: Runtime,
    readonly clientSessionId: string,
  ) {}

  async open(principal: Principal = ANONYMOUS_PRINCIPAL): Promise<void> {
    this.context = this.makeContext(principal, 0, this.controller);
    await this.runtime.openSession(this.context);
  }

  async rotate(principal: Principal): Promise<readonly SessionApplicationMessage[]> {
    const batch = await this.rotateBatch(principal);
    try {
      return Object.freeze(batch.frames.map((publication) => publication.message));
    } finally {
      batch.release();
    }
  }

  async rotateBatch(principal: Principal): Promise<RuntimePublicationBatch> {
    const from = this.context;
    this.controller.abort();
    const nextController = new AbortController();
    const to = this.makeContext(principal, from.authEpoch + 1, nextController);
    const batch = await this.runtime.transitionAuth({
      attemptId: from.authEpoch + 1,
      reason: principal.kind === "anonymous" ? "sign-out" : "refresh",
      from,
      to,
    });
    this.controller = nextController;
    this.context = to;
    return batch;
  }

  mutation(
    id: number,
    ref: string,
    args: unknown,
    mutationRequestId = uuidV7(Date.now(), id),
    issuedAt = Date.now(),
  ) {
    const message: MutationMessage = {
      v: PROTOCOL_VERSION,
      t: "m",
      id,
      ref,
      args,
      mutationRequestId,
      issuedAt,
    };
    return this.runtime.mutation(this.context, request(message));
  }

  close(): Promise<void> {
    this.controller.abort(new DbzzError("draining", "session closed"));
    return this.runtime.closeSession(this.context, {
      code: "draining",
      retryable: false,
      message: "session closed",
    });
  }

  private makeContext(
    principal: Principal,
    authEpoch: number,
    controller: AbortController,
  ): SessionRuntimeContext {
    return Object.freeze({
      clientSessionId: this.clientSessionId,
      principal,
      fairnessKey: callerFairnessKey(principal, TEST_SOURCE),
      authEpoch,
      signal: controller.signal,
      publish: async (publication: RuntimePublication) => {
        if (controller.signal.aborted || this.context?.authEpoch !== authEpoch) return false;
        await this.beforePublish?.(publication);
        if (controller.signal.aborted || this.context?.authEpoch !== authEpoch) return false;
        this.preparedPublications.push(publication);
        this.publications.push(publication.message);
        return true;
      },
    });
  }
}

function limits(overrides: Partial<ServiceLimits> = {}): ServiceLimits {
  return { ...PRODUCTION_LIMITS, ...overrides };
}

async function collectSse(
  response: RuntimeSseResponse,
  acknowledge: (message: SseMessage) => void = (message) => {
    expect(runtime.ackSse({
      v: PROTOCOL_VERSION,
      t: "sse_ack",
      stream: response.streamId,
      seq: message.seq,
      proof: message.proof,
    })).toBe(true);
  },
): Promise<SseMessage[]> {
  const messages: SseMessage[] = [];
  for await (const bytes of response.stream as unknown as AsyncIterable<Uint8Array>) {
    const message = sseMessage(bytes);
    messages.push(message);
    acknowledge(message);
  }
  return messages;
}

function sseMessage(bytes: Uint8Array): SseMessage {
  const text = new TextDecoder().decode(bytes);
  expect(text).toStartWith("data: ");
  return parseSseMessage(decode(text.slice(6).trim()));
}

async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await Bun.sleep(2);
  }
}

function publicationBytes(frames: readonly RuntimePublication[]): number {
  return frames.reduce((total, frame) => total + frame.bytes, 0);
}

let directory: string;
let engine: Engine;
let runtime: Runtime;
let session: SessionHarness;

class HangingTelemetry extends Telemetry {
  override flush(): Promise<void> {
    return new Promise(() => {});
  }
}

function start(
  customLimits = limits(),
  telemetry: RuntimeOptions["telemetry"] = false,
): void {
  engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  runtime = new Runtime({
    engine,
    registry: new Registry(functions),
    limits: customLimits,
    telemetry,
  });
  session = new SessionHarness(runtime, "session-a");
}

async function restart(
  customLimits: ServiceLimits,
  telemetry: RuntimeOptions["telemetry"] = false,
): Promise<void> {
  await runtime.drain().catch(() => {});
  engine.close("clean");
  rmSync(directory, { recursive: true, force: true });
  directory = mkdtempSync(join(tmpdir(), "dbzz-runtime-restart-"));
  start(customLimits, telemetry);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dbzz-runtime-"));
  queryGate = null;
  queryFailureGate = null;
  queryFailureEntered = null;
  revalidationGate = null;
  revalidationEntered = null;
  externalProcedureStarted = null;
  externalProcedureRelease = null;
  externalSseStarted = null;
  externalSseReturned = null;
  nestedMutationEntered = null;
  nestedMutationRelease = null;
  scheduledAttempts = 0;
  scheduledAttempt = null;
  mutationResultReads = 0;
  writeThenErrCalls = 0;
  mutationResultValue = Object.defineProperty({}, "payload", {
    enumerable: true,
    get() {
      mutationResultReads++;
      return "stable";
    },
  });
  eventAccessInputs.length = 0;
  eventMatchInputs.length = 0;
  start();
});

afterEach(async () => {
  await runtime.drain().catch(() => {});
  engine.close("clean");
  rmSync(directory, { recursive: true, force: true });
});

describe("runtime commit and replay ownership", () => {
  test("reuses the precommit mutation publication after idempotency encoding", async () => {
    await session.open();
    const result = await session.mutation(1, "messages.canaryResult", {});
    const publication = session.preparedPublications.at(-1);

    expect(result.value).toBe(mutationResultValue);
    expect(mutationResultReads).toBe(2);
    expect(publication?.message).toMatchObject({ t: "ok", kind: "mutation" });
    if (publication?.message.t !== "ok" || publication.message.kind !== "mutation") {
      throw new Error("expected mutation publication");
    }
    expect(publication.message.value).toBe(mutationResultValue);
  });

  test("publishes one safe error when a query result is not wire-representable", async () => {
    await session.open();
    await expect(runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 2,
      ref: "messages.nonWireQuery",
      args: {},
    }))).rejects.toMatchObject({ code: "validation" });

    expect(session.publications.filter((frame) => frame.id === 2)).toEqual([
      expect.objectContaining({
        t: "err",
        outcome: expect.objectContaining({ code: "validation" }),
      }),
    ]);
  });

  test("publishes application errors separately and uses a procedure's named HTTP status", async () => {
    await session.open();
    const queryResult = await runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 10,
      ref: "messages.missing",
      args: { id: 99n },
    }));
    expect(queryResult).toMatchObject({
      ok: false,
      error: { code: "message-not-found", body: { id: 99n }, status: 404 },
    });
    expect(session.publications.at(-1)).toMatchObject({
      t: "app_err",
      kind: "query",
      error: { code: "message-not-found", status: 404 },
    });

    const response = await runtime.runProcedure({
      id: 11,
      address: "ops.reject",
      args: { reason: "not now" },
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }) => new Response(body, { status }),
    });
    expect(response.status).toBe(422);
    expect(parseCallResponse(decode(await response.text()))).toMatchObject({
      t: "app_err",
      kind: "procedure",
      error: {
        code: "procedure-rejected",
        body: { reason: "not now" },
        status: 422,
      },
    });
  });

  test("validates queries and keeps failed transaction writes invisible", async () => {
    await session.open();
    const first = await session.mutation(1, "messages.send", { channelId: 1n, body: "hello" });
    expect(first.value).toBe(1n);
    expect(first.receipt).toMatchObject({ replay: "executed", durability: "production" });

    await expect(runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 2,
      ref: "messages.list",
      args: { channelId: 1 },
    }))).rejects.toMatchObject({ code: "validation" });
    await expect(session.mutation(3, "messages.fetchInside", {})).rejects.toThrow("fetch is not allowed");
    await expect(session.mutation(4, "messages.composeFail", { channelId: 2n })).rejects.toThrow("compose failed");

    const rolledBack = await runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 5,
      ref: "messages.list",
      args: { channelId: 2n },
    })) as unknown[];
    expect(rolledBack).toEqual([]);
  });

  test("rolls back returned Err scopes and poisons caught nested throws", async () => {
    await session.open();

    const handled = await session.mutation(20, "messages.handleChildErr", { channelId: 20n });
    expect(handled.value).toBe("queued");
    const handledRows = await runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 21,
      ref: "messages.list",
      args: { channelId: 20n },
    })) as Array<{ body: string }>;
    expect(handledRows.map((row) => row.body)).toEqual(["parent-before", "parent-after"]);

    const versionBeforeErr = engine.commitVersion();
    const recordsBeforeErr = engine.writer
      .query("SELECT COUNT(*) AS count FROM _dbzz_mutations")
      .get() as { count: bigint };
    const errIssuedAt = Date.now();
    const errRequestId = uuidV7(errIssuedAt, 22);
    const propagated = await session.mutation(
      22,
      "messages.propagateChildErr",
      { channelId: 22n },
      errRequestId,
      errIssuedAt,
    );
    expect(propagated.value).toMatchObject({
      ok: false,
      error: { code: "stock-unavailable", status: 409 },
    });
    expect(session.publications.at(-1)).toMatchObject({
      t: "app_err",
      kind: "mutation",
      error: { code: "stock-unavailable", status: 409 },
    });
    expect(engine.commitVersion()).toBe(versionBeforeErr);
    expect(propagated.receipt.commitVersion).toBe(versionBeforeErr);
    expect(
      (engine.writer.query("SELECT COUNT(*) AS count FROM _dbzz_mutations").get() as {
        count: bigint;
      }).count,
    ).toBe(recordsBeforeErr.count + 1n);
    const callsAfterErr = writeThenErrCalls;
    const replayedErr = await session.mutation(
      23,
      "messages.propagateChildErr",
      { channelId: 22n },
      errRequestId,
      errIssuedAt,
    );
    expect(replayedErr.value).toMatchObject({
      ok: false,
      error: { code: "stock-unavailable", status: 409 },
    });
    expect(replayedErr.receipt).toMatchObject({
      replay: "replayed",
      commitVersion: versionBeforeErr,
    });
    expect(writeThenErrCalls).toBe(callsAfterErr);
    expect(await runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 24,
      ref: "messages.list",
      args: { channelId: 22n },
    }))).toEqual([]);

    await expect(session.mutation(
      25,
      "messages.catchNestedThrow",
      { channelId: 24n },
    )).rejects.toThrow("storage exploded");
    expect(await runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 26,
      ref: "messages.list",
      args: { channelId: 24n },
    }))).toEqual([]);
  });

  test("rejects parent database work while a nested mutation owns the savepoint", async () => {
    await session.open();
    nestedMutationEntered = deferred<void>();
    nestedMutationRelease = deferred<void>();

    await expect(session.mutation(
      27,
      "messages.overlapNestedMutation",
      { channelId: 27n },
    )).rejects.toThrow(
      "concurrent database access crossed a nested mutation boundary",
    );
    expect(await runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 28,
      ref: "messages.list",
      args: { channelId: 27n },
    }))).toEqual([]);
  });

  test("a caught database failure still poisons and rolls back the mutation", async () => {
    await session.open();
    await expect(session.mutation(
      29,
      "messages.catchDatabaseThrow",
      { channelId: 29n },
    )).rejects.toThrow("row 9999 not found");
    expect(await runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 30,
      ref: "messages.list",
      args: { channelId: 29n },
    }))).toEqual([]);
  });

  test("replays one scoped mutation exactly and rejects semantic reuse", async () => {
    await session.open();
    const now = Date.now();
    const requestId = uuidV7(now, 99);
    const first = await session.mutation(
      1,
      "messages.send",
      { channelId: 5n, body: "once" },
      requestId,
      now,
    );
    engine.writer.query(
      "UPDATE _dbzz_mutations SET durability = 'balanced' WHERE session_id = ? AND request_id = ?",
    ).run(session.context.clientSessionId, requestId);
    const replay = await session.mutation(
      2,
      "messages.send",
      { channelId: 5n, body: "once" },
      requestId,
      now,
    );
    expect(replay.value).toBe(first.value);
    expect(replay.receipt).toMatchObject({ replay: "replayed", durability: "balanced" });
    await expect(session.mutation(
      3,
      "messages.send",
      { channelId: 5n, body: "different" },
      requestId,
      now,
    )).rejects.toMatchObject({ code: "conflict", resource: "idempotency" });

    const rows = await runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 4,
      ref: "messages.list",
      args: { channelId: 5n },
    })) as unknown[];
    expect(rows).toHaveLength(1);
  });
});

describe("ordered convergence", () => {
  test("orders same-id subscription controls while distinct ids enter independently", async () => {
    await session.open();
    revalidationGate = deferred<void>();
    revalidationEntered = deferred<void>();
    const subscribing = runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 40,
      ref: "messages.parallelList",
      args: { channelId: 1n },
    }));
    await revalidationEntered.promise;

    let resetSettled = false;
    let unsubscribeSettled = false;
    const resetting = runtime.reset(session.context, request({
      v: PROTOCOL_VERSION,
      t: "reset",
      id: 40,
      cursor: { generation: "stale", commitVersion: 0n, authEpoch: 0, identity: "stale" },
    })).finally(() => {
      resetSettled = true;
    });
    const unsubscribing = runtime.unsubscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "unsub",
      id: 40,
    })).finally(() => {
      unsubscribeSettled = true;
    });
    const independent = runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 41,
      ref: "messages.list",
      args: { channelId: 2n },
    }));
    await independent;
    await settle();

    expect(resetSettled).toBe(false);
    expect(unsubscribeSettled).toBe(false);
    expect(runtime.status()).toMatchObject({ activeOperations: 3 });

    revalidationGate.resolve(undefined);
    await Promise.all([subscribing, resetting, unsubscribing]);
    expect(runtime.status().reactive.queryListeners).toBe(1);
  });

  test("a mutation waits only subscription controls that arrived before it", async () => {
    await session.open();
    revalidationGate = deferred<void>();
    revalidationEntered = deferred<void>();
    const priorSubscription = runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 50,
      ref: "messages.parallelList",
      args: { channelId: 1n },
    }));
    await revalidationEntered.promise;

    const mutation = session.mutation(51, "messages.send", { channelId: 3n, body: "after-control" });
    const laterSubscription = runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 52,
      ref: "messages.list",
      args: { channelId: 2n },
    }));
    await laterSubscription;
    expect(engine.reader.query('SELECT COUNT(*) AS count FROM "messages"').get()).toEqual({ count: 0n });

    revalidationGate.resolve(undefined);
    await Promise.all([priorSubscription, mutation]);
    expect(engine.reader.query('SELECT COUNT(*) AS count FROM "messages"').get()).toEqual({ count: 1n });
  });

  test("auth transition waits the prior subscription-control frontier", async () => {
    await session.open(user("alice"));
    revalidationGate = deferred<void>();
    revalidationEntered = deferred<void>();
    const subscribing = runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 60,
      ref: "messages.parallelList",
      args: { channelId: 1n },
    }));
    await revalidationEntered.promise;

    let transitionSettled = false;
    const rotating = session.rotateBatch(user("bob")).finally(() => {
      transitionSettled = true;
    });
    await settle();
    expect(transitionSettled).toBe(false);

    revalidationGate.resolve(undefined);
    await expect(subscribing).rejects.toMatchObject({ code: "auth_stale" });
    const batch = await rotating;
    batch.release();
    expect(session.context).toMatchObject({ authEpoch: 1, principal: { subject: "bob" } });
  });

  test("does not encode an old-epoch error rejected by auth capture", async () => {
    const exported: TelemetryRecord[] = [];
    await restart(limits(), {
      localSink: false,
      exporter: { export: (records) => void exported.push(...records) },
    });
    await session.open(user("alice"));
    await runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 89,
      ref: "messages.parallelList",
      args: { channelId: 1n },
    }));
    queryFailureGate = deferred<void>();
    queryFailureEntered = deferred<void>();
    const failedQuery = runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 90,
      ref: "messages.blockFail",
      args: {},
    }));
    void failedQuery.catch(() => {});
    await queryFailureEntered.promise;

    revalidationGate = deferred<void>();
    revalidationEntered = deferred<void>();
    const nextController = new AbortController();
    const nextPrincipal = user("bob");
    const nextContext: SessionRuntimeContext = Object.freeze({
      ...session.context,
      principal: nextPrincipal,
      fairnessKey: callerFairnessKey(nextPrincipal, TEST_SOURCE),
      authEpoch: 1,
      signal: nextController.signal,
      publish: async () => true,
    });
    let transition: Promise<RuntimePublicationBatch> | undefined;
    try {
      transition = runtime.transitionAuth({
        attemptId: 1,
        reason: "refresh",
        from: session.context,
        to: nextContext,
      });
      await Promise.race([
        revalidationEntered.promise,
        transition.then(() => {
          throw new Error("auth transition completed before revalidation stalled");
        }),
      ]);
      queryFailureGate.resolve(undefined);
      await expect(failedQuery).rejects.toThrow("stale query failure");
      await runtime.telemetry.flush();
    } finally {
      queryFailureGate.resolve(undefined);
      revalidationGate.resolve(undefined);
      const batch = await transition;
      batch?.release();
      nextController.abort();
    }

    const requestSpans = exported.filter((record): record is TelemetrySpanRecord =>
      record.kind === "span" && record.requestId === "90"
    );
    expect(requestSpans.some((record) => record.stage === "handler" && record.outcome !== "ok")).toBe(true);
    expect(requestSpans.filter((record) =>
      record.stage === "encoding" && record.resource === "outbound"
    )).toEqual([]);
  });

  test("publishes initial reset and advances caller obligations before mutation resolution", async () => {
    await session.open();
    await runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 10,
      ref: "messages.list",
      args: { channelId: 1n },
    }));
    expect(session.publications[0]).toMatchObject({ t: "transition", id: 10, transition: { kind: "reset" } });

    const result = await session.mutation(1, "messages.send", { channelId: 1n, body: "new" });
    expect(result.receipt.obligations).toEqual([10]);
    const update = session.publications.findLast(
      (frame) => frame.t === "transition" && frame.id === 10,
    );
    expect(update).toMatchObject({
      t: "transition",
      transition: { kind: "update", to: { commitVersion: result.receipt.commitVersion } },
    });

    await session.mutation(2, "messages.rewrite", { id: result.value as bigint });
    expect(session.publications.findLast((frame) => frame.t === "transition")).toMatchObject({
      t: "transition",
      transition: { kind: "checkpoint" },
    });
  });

  test("uses isolated readers so a stalled revalidation cannot block an unrelated later mutation", async () => {
    await session.open();
    const secondSession = new SessionHarness(runtime, "session-b");
    await secondSession.open();
    await runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 60,
      ref: "messages.parallelList",
      args: { channelId: 1n },
    }));
    await runtime.subscribe(secondSession.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 61,
      ref: "messages.parallelList",
      args: { channelId: 2n },
    }));

    revalidationGate = deferred<void>();
    revalidationEntered = deferred<void>();
    const first = session.mutation(70, "messages.send", { channelId: 1n, body: "first" });
    await revalidationEntered.promise;
    let firstSettled = false;
    void first.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      },
    );

    const second = secondSession.mutation(71, "messages.send", { channelId: 2n, body: "second" });
    let secondResult: Awaited<typeof second>;
    try {
      secondResult = await Promise.race([
        second,
        Bun.sleep(500).then(() => {
          throw new Error("unrelated mutation was blocked by a stalled revalidation reader");
        }),
      ]);
      expect(firstSettled).toBe(false);
      expect(secondResult.receipt.obligations).toEqual([61]);
      expect(secondSession.publications.findLast(
        (frame) => frame.t === "transition" && frame.id === 61,
      )).toMatchObject({
        t: "transition",
        transition: { kind: "update", to: { commitVersion: secondResult.receipt.commitVersion } },
      });
      expect(runtime.status()).toMatchObject({
        reader: { concurrency: PRODUCTION_LIMITS.revalidationConcurrency, active: 1 },
        reactive: {
          revalidation: { concurrency: PRODUCTION_LIMITS.revalidationConcurrency, active: 1 },
        },
      });
    } finally {
      revalidationGate.resolve(undefined);
    }

    const firstResult = await first;
    expect(firstResult.receipt.obligations).toEqual([60]);
    expect(session.publications.findLast(
      (frame) => frame.t === "transition" && frame.id === 60,
    )).toMatchObject({
      t: "transition",
      transition: { kind: "update", to: { commitVersion: secondResult.receipt.commitVersion } },
    });
  });

  test("event subscriptions receive reset then committed rows", async () => {
    await session.open();
    await runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 20,
      ref: "events.typing",
      args: { channelId: 7n },
    }));
    await runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 21,
      ref: "events.typing",
      args: { channelId: 8n },
    }));
    await session.mutation(1, "messages.send", { channelId: 7n, body: "typing" });
    expect(session.publications.filter(
      (frame) => frame.t === "event" && frame.event.kind === "row",
    )).toMatchObject([
      { t: "event", id: 20, event: { row: { id: 1n, channelId: 7n } } },
    ]);
  });

  test("authorizes and freezes event subscriptions across refresh and terminal sign-out", async () => {
    await session.open(user("alice"));
    await expect(runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 22,
      ref: "events.privateTyping",
      args: { channelId: "wrong" },
    }))).rejects.toMatchObject({ code: "validation" });

    await runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 23,
      ref: "events.privateTyping",
      args: { channelId: 9n },
    }));
    expect(Object.isFrozen(eventAccessInputs.at(-1)!.ctx)).toBe(true);
    expect(Object.isFrozen(eventAccessInputs.at(-1)!.args)).toBe(true);
    expect("token" in eventAccessInputs.at(-1)!.ctx).toBe(false);
    expect("credential" in eventAccessInputs.at(-1)!.ctx).toBe(false);

    await session.mutation(1, "messages.send", { channelId: 9n, body: "private" });
    expect(Object.isFrozen(eventMatchInputs.at(-1)!.row)).toBe(true);
    expect(Object.isFrozen(eventMatchInputs.at(-1)!.args)).toBe(true);

    const refreshed = await session.rotate(user("bob"));
    expect(refreshed).toMatchObject([
      { t: "event", id: 23, event: { kind: "reset" } },
    ]);
    expect(refreshed.some((frame) => frame.t === "err")).toBe(false);

    const signedOut = await session.rotate(ANONYMOUS_PRINCIPAL);
    expect(signedOut).toMatchObject([
      { t: "err", id: 23, outcome: { code: "unauthenticated" } },
    ]);
    expect(runtime.status().reactive.eventListeners).toBe(0);
    expect(await session.rotate(user("alice"))).toEqual([]);
  });

  test("denies an event policy before listener attachment", async () => {
    await session.open();
    await expect(runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 24,
      ref: "events.privateTyping",
      args: { channelId: 1n },
    }))).rejects.toMatchObject({ code: "unauthenticated" });
    expect(runtime.status().reactive.eventListeners).toBe(0);
  });

  test("auth rotation revokes then re-evaluates saved subscriptions under the new identity", async () => {
    await session.open(user("alice"));
    await runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 30,
      ref: "messages.secure",
      args: {},
    }));
    expect(session.publications[0]).toMatchObject({
      t: "transition",
      transition: { kind: "reset", value: { subject: "alice" } },
    });

    const signedOut = await session.rotate(ANONYMOUS_PRINCIPAL);
    expect(signedOut).toMatchObject([
      { t: "transition", id: 30, transition: { kind: "revoked" } },
      { t: "err", id: 30, outcome: { code: "unauthenticated" } },
    ]);
    const signedIn = await session.rotate(user("bob"));
    expect(signedIn).toEqual([]);
  });

  test("reattaches the reactive-owned query and event definitions in id order", async () => {
    await session.open(user("alice"));
    await runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 32,
      ref: "messages.secure",
      args: {},
    }));
    await expect(runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 32,
      ref: "events.privateTyping",
      args: { channelId: 8n },
    }))).rejects.toMatchObject({ code: "conflict" });
    await runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 31,
      ref: "events.privateTyping",
      args: { channelId: 7n },
    }));

    expect(await session.rotate(user("bob"))).toMatchObject([
      { t: "transition", id: 32, transition: { kind: "revoked" } },
      { t: "event", id: 31, event: { kind: "reset" } },
      { t: "transition", id: 32, transition: { kind: "reset", value: { subject: "bob" } } },
    ]);
    expect(runtime.status().reactive).toMatchObject({ queryListeners: 1, eventListeners: 1 });

    expect(await session.rotate(ANONYMOUS_PRINCIPAL)).toMatchObject([
      { t: "transition", id: 32, transition: { kind: "revoked" } },
      { t: "err", id: 31, outcome: { code: "unauthenticated" } },
      { t: "err", id: 32, outcome: { code: "unauthenticated" } },
    ]);
    expect(runtime.status().reactive).toMatchObject({ queryListeners: 0, eventListeners: 0 });
    expect(await session.rotate(user("carol"))).toEqual([]);
  });

  test("disconnect releases query and event ownership at the reactive boundary", async () => {
    await session.open(user("alice"));
    await runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 33,
      ref: "messages.secure",
      args: {},
    }));
    await runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 34,
      ref: "events.privateTyping",
      args: { channelId: 9n },
    }));

    await session.close();

    expect(runtime.status()).toMatchObject({
      connections: 0,
      reactive: { queryListeners: 0, eventListeners: 0 },
    });
  });
});

describe("procedures and bounded SSE", () => {
  test("reports cancellation after handler execution as indeterminate", async () => {
    await session.open();
    externalProcedureStarted = deferred<void>();
    externalProcedureRelease = deferred<void>();
    const controller = new AbortController();
    const message: ProcedureMessage = {
      v: PROTOCOL_VERSION,
      t: "p",
      id: 1,
      ref: "ops.block",
      args: {},
    };
    const completion = runtime.procedure(
      session.context,
      { ...request(message), signal: controller.signal },
    );

    await externalProcedureStarted.promise;
    controller.abort(new DbzzError("unavailable", "procedure request was canceled", {
      resource: "operation",
    }));
    externalProcedureRelease.resolve(undefined);

    await expect(completion).rejects.toMatchObject({
      code: "indeterminate",
      message: "procedure completion is unknown after cancellation",
      resource: "operation",
    });
    expect(session.publications.filter((frame) => frame.id === message.id)).toEqual([
      expect.objectContaining({
        t: "err",
        outcome: expect.objectContaining({
          code: "indeterminate",
          resource: "operation",
        }),
      }),
    ]);
  });

  test("runs external work outside an atomic procedure transaction", async () => {
    const response = await runtime.runProcedure({
      id: 1,
      address: "ops.pipeline",
      args: { channelId: 4n },
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }) => new Response(body, { status }),
    });
    expect(response.status).toBe(200);
    expect(decode(await response.text())).toEqual({
      v: PROTOCOL_VERSION,
      t: "ok",
      id: 1,
      kind: "procedure",
      value: { external: "external", body: "external" },
    });
    const failed = await runtime.runProcedure({
      id: 2,
      address: "ops.nestedTx",
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }) => new Response(body, { status }),
    });
    expect(failed.status).toBe(400);
    expect(decode(await failed.text())).toMatchObject({
      v: PROTOCOL_VERSION,
      t: "err",
      id: 2,
      outcome: { code: "validation" },
    });
  });

  test("a caught ctx.tx throw still poisons the procedure and rolls back", async () => {
    const response = await runtime.runProcedure({
      id: 3,
      address: "ops.catchTxThrow",
      args: { channelId: 30n },
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }) => new Response(body, { status }),
    });
    expect(response.status).toBe(500);
    expect(decode(await response.text())).toMatchObject({
      t: "err",
      outcome: { code: "internal" },
    });

    await session.open();
    expect(await runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 31,
      ref: "messages.list",
      args: { channelId: 30n },
    }))).toEqual([]);
  });

  test("reserves Runtime operation capacity for an unrelated external caller", async () => {
    await restart(limits({
      maxOperations: 2,
      maxOperationsPerCaller: 1,
      maxOperationsPerConnection: 2,
    }));
    externalProcedureStarted = deferred<void>();
    externalProcedureRelease = deferred<void>();
    const hot = user("hot");
    const rotatedHot = Object.freeze({
      ...hot,
      expiresAt: hot.expiresAt + 1_000,
      tokenId: "rotated-token-hot",
    });
    const cold = user("cold");
    const invoke = (id: number, address: string, args: unknown, principal: Principal) =>
      runtime.runProcedure({
        id,
        address,
        args,
        principal,
        respond: ({ body, status }) => new Response(body, { status }),
      });

    const held = invoke(10, "ops.block", {}, hot);
    try {
      await externalProcedureStarted.promise;
      expect(runtime.status()).toMatchObject({
        activeOperations: 1,
        activeOperationCallers: 1,
      });

      const rejected = await invoke(11, "ops.echo", { value: "same" }, rotatedHot);
      expect(rejected.status).toBe(429);
      expect(decode(await rejected.text())).toMatchObject({
        outcome: {
          code: "overloaded",
          retryable: true,
          retryAfterMs: 0,
          resource: "operation",
        },
      });

      const admitted = await invoke(12, "ops.echo", { value: "cold" }, cold);
      expect(admitted.status).toBe(200);
      expect(decode(await admitted.text())).toMatchObject({ value: "cold" });
    } finally {
      externalProcedureRelease.resolve(undefined);
    }
    expect((await held).status).toBe(200);
    expect(runtime.status()).toMatchObject({ activeOperations: 0, activeOperationCallers: 0 });
  });

  test("fits a tight all-emoji procedure failure to a parser-valid fallback", async () => {
    const id = 89;
    const fallback = {
      v: PROTOCOL_VERSION,
      t: "err" as const,
      id,
      outcome: { code: "conflict" as const, retryable: false, message: "err" },
    };
    const maxFrameBytes = new TextEncoder().encode(encode(fallback)).byteLength;
    await restart(limits({ maxFrameBytes }));

    const response = await runtime.runProcedure({
      id,
      address: "ops.failEmoji",
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }) => new Response(body, { status }),
    });
    const body = await response.text();
    expect(response.status).toBe(409);
    expect(new TextEncoder().encode(body).byteLength).toBe(maxFrameBytes);
    expect(parseCallResponse(decode(body))).toEqual(fallback);
  });

  test("streams generator chunks receiver-credited and a terminal marker", async () => {
    const response = await runtime.runSse({
      id: 1,
      address: "ops.stream",
      args: { count: 2 },
      principal: ANONYMOUS_PRINCIPAL,
    });
    expect(response.streamId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const messages = await collectSse(response, (message) => {
      // The producer is receiver-credited: exactly one unacknowledged frame.
      expect(runtime.sseSnapshot(response.streamId)?.unackedFrames).toBe(1);
      if (message.seq === 2) {
        const before = runtime.status().sseBudget.bytes;
        expect(runtime.status().activeSse).toBe(1);
        expect(runtime.ackSse({
          v: PROTOCOL_VERSION,
          t: "sse_ack",
          stream: "AAAAAAAAAAAAAAAAAAAAAA",
          seq: message.seq,
          proof: message.proof,
        })).toBe(false);
        expect(runtime.ackSse({
          v: PROTOCOL_VERSION,
          t: "sse_ack",
          stream: response.streamId,
          seq: message.seq,
          proof: `${message.proof}x`,
        })).toBe(false);
        expect(runtime.ackSse({
          v: PROTOCOL_VERSION,
          t: "sse_ack",
          stream: response.streamId,
          seq: message.seq + 100,
          proof: message.proof,
        })).toBe(false);
        expect(runtime.status().sseBudget.bytes).toBe(before);
      }
      if (message.t !== "sse_chunk") expect(runtime.status().activeSse).toBe(1);
      expect(runtime.ackSse({
        v: PROTOCOL_VERSION,
        t: "sse_ack",
        stream: response.streamId,
        seq: message.seq,
        proof: message.proof,
      })).toBe(true);
    });
    expect(messages.filter((message) => message.t === "sse_chunk").map((message) => message.value)).toEqual([
      { type: "delta", value: 0 },
      { type: "delta", value: 1 },
      { type: "merged" },
    ]);
    expect(messages.at(-1)?.t).toBe("sse_done");
    expect(runtime.ackSse({
      v: PROTOCOL_VERSION,
      t: "sse_ack",
      stream: response.streamId,
      seq: messages.at(-1)!.seq,
      proof: messages.at(-1)!.proof,
    })).toBe(false);
    expect(runtime.status().activeSse).toBe(0);
    expect(runtime.status().sseBudget.bytes).toBe(0);
  });

  test("streams a handler-returned ReadableStream to completion", async () => {
    const response = await runtime.runSse({
      id: 1,
      address: "ops.streamed",
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
    });
    const messages = await collectSse(response);
    expect(messages.map((message) => message.t)).toEqual(["sse_chunk", "sse_done"]);
    expect(messages[0]).toMatchObject({ value: { type: "merged" } });
  });

  test("fails a stream on the first invalid chunk with the exact validation error", async () => {
    const response = await runtime.runSse({
      id: 1,
      address: "ops.invalidChunk",
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
    });
    const messages = await collectSse(response);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ t: "sse_chunk", value: { value: "first" } });
    expect(messages[1]).toMatchObject({
      t: "sse_error",
      outcome: { code: "validation", message: "chunk.value: expected string, got number" },
    });
  });

  test("turns a post-start SSE failure into a terminal dbzz-error event", async () => {
    const response = await runtime.runSse({
      id: 1,
      address: "ops.failingStream",
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
    });
    const messages = await collectSse(response);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      t: "sse_error",
      outcome: { code: "internal" },
    });
  });
});

describe("direct ingress", () => {
  test("rejects canonically oversized direct requests despite forged low byte counts", async () => {
    await restart(limits({ maxRequestBytes: 256 }));
    await session.open();
    const oversized = "x".repeat(512);
    const expected = {
      code: "overloaded",
      resource: "operation",
      message: "request exceeds maxRequestBytes",
    };

    await expect(runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 81,
      ref: oversized,
      args: {},
    }, 0))).rejects.toMatchObject(expected);
    await expect(runtime.mutation(session.context, request({
      v: PROTOCOL_VERSION,
      t: "m",
      id: 82,
      ref: "messages.send",
      args: { channelId: 1n, body: oversized },
      mutationRequestId: uuidV7(Date.now(), 82),
      issuedAt: Date.now(),
    }, 0))).rejects.toMatchObject(expected);
    const procedure = {
      id: 85,
      address: oversized,
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }: RuntimeProcedureResponse) => new Response(body, { status }),
      bytes: 0,
    };
    await expect(runtime.runProcedure(procedure)).rejects.toMatchObject(expected);
    const sse = {
      id: 86,
      address: oversized,
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
      bytes: 0,
    };
    await expect(runtime.runSse(sse)).rejects.toMatchObject(expected);

    expect(runtime.status()).toMatchObject({
      activeOperations: 0,
      writer: { active: 0, admitted: 0, queue: { queuedItems: 0 } },
      reactive: { queryListeners: 0, eventListeners: 0 },
    });
    expect(engine.commitVersion()).toBe(0n);
  });

  test("accepts canonical direct requests despite forged high byte counts", async () => {
    await restart(limits({ maxRequestBytes: 256 }));
    await session.open();

    await expect(runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 87,
      ref: "messages.list",
      args: { channelId: 1n },
    }, 257))).resolves.toEqual([]);

    const procedureRequest = {
      id: 88,
      address: "ops.echo",
      args: { value: "accepted" },
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }: RuntimeProcedureResponse) => new Response(body, { status }),
      bytes: 257,
    };
    const procedure = await runtime.runProcedure(procedureRequest);
    expect(procedure.status).toBe(200);

    const sseRequest = {
      id: 89,
      address: "ops.stream",
      args: { count: 0 },
      principal: ANONYMOUS_PRINCIPAL,
      bytes: 257,
    };
    const sse = await runtime.runSse(sseRequest);
    expect((await collectSse(sse)).at(-1)?.t).toBe("sse_done");
  });

  test("claims transport provenance once across request spreads", async () => {
    await restart(limits({ maxRequestBytes: 256 }));
    const carried = carryHttpRequestProvenance({
      id: 90,
      address: "ops.echo",
      args: { value: "accepted canonically after the claim" },
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }: RuntimeProcedureResponse) => new Response(body, { status }),
    }, 257, undefined);

    await expect(runtime.runProcedure({ ...carried })).rejects.toMatchObject({
      code: "overloaded",
      resource: "operation",
    });
    expect((await runtime.runProcedure({ ...carried })).status).toBe(200);
  });
});

describe("scheduler and lifecycle", () => {
  test("runs the handler and deletes the due row in one commit", async () => {
    await session.open();
    const dueAt = Date.now() + 100_000;
    const attempt = Number.MAX_SAFE_INTEGER;
    await session.mutation(1, "reminders.schedule", { message: "ok", attempt, at: dueAt });
    const materialized: string[] = [];
    const decodeRow = engine.rowFromSql.bind(engine);
    engine.rowFromSql = (plan, sqlRow) => {
      if (plan.name === "reminders") materialized.push(typeof sqlRow["attempt"]);
      return decodeRow(plan, sqlRow);
    };
    expect(await runtime.runScheduled(dueAt)).toBe(1);
    expect(scheduledAttempt).toBe(attempt);
    expect(materialized).toEqual(["number"]);
    expect(engine.reader.query('SELECT line FROM "log"').all()).toEqual([{ line: "fired:ok" }]);
    expect(engine.reader.query('SELECT COUNT(*) AS count FROM "reminders"').get()).toEqual({ count: 0n });
  });

  test("rolls handler writes and deletion back together on failure", async () => {
    await session.open();
    const dueAt = Date.now() + 100_000;
    await session.mutation(1, "reminders.schedule", { message: "fail", attempt: 1, at: dueAt });
    await expect(runtime.runScheduled(dueAt)).rejects.toThrow("scheduled failure");
    expect(engine.reader.query('SELECT COUNT(*) AS count FROM "log"').get()).toEqual({ count: 0n });
    expect(engine.reader.query('SELECT COUNT(*) AS count FROM "reminders"').get()).toEqual({ count: 1n });
  });

  test("backs a failing due job off instead of retrying in a hot loop", async () => {
    await session.open();
    await session.mutation(1, "reminders.schedule", {
      message: "fail",
      attempt: 1,
      at: Date.now() - 1,
    });
    for (let turn = 0; turn < 20 && scheduledAttempts === 0; turn++) await Bun.sleep(5);
    expect(scheduledAttempts).toBe(1);
    await Bun.sleep(50);
    expect(scheduledAttempts).toBe(1);
  });

  test("bounds stale scheduler attempts and rolls each no-op back before version allocation", async () => {
    await restart(limits({ schedulerBatchSize: 3 }));
    const scheduler = runtime as unknown as {
      nextScheduledCandidate(now: number): Promise<{
        table: string;
        address: string;
        primaryKey: unknown;
      } | null>;
    };
    let attempts = 0;
    scheduler.nextScheduledCandidate = async () => {
      attempts++;
      return { table: "reminders", address: "reminders.fire", primaryKey: 999n };
    };

    expect(await runtime.runScheduled(Date.now())).toBe(0);
    expect(attempts).toBe(3);
    expect(scheduledAttempts).toBe(0);
    expect(engine.commitVersion()).toBe(0n);
    expect(runtime.status().publication).toMatchObject({
      items: 0,
      highWater: 0n,
      processed: 0,
    });
  });

  test("fails an open SSE immediately and completes Runtime drain", async () => {
    const response = await runtime.runSse({
      id: 85,
      address: "ops.waitForAbort",
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
    });
    await eventually(() => runtime.sseSnapshot(response.streamId)?.unackedFrames === 1);

    const [messages] = await Promise.all([collectSse(response), runtime.drain()]);
    expect(messages[0]).toMatchObject({ t: "sse_chunk", value: { phase: "started" } });
    expect(messages.some((message) => message.t === "sse_error")).toBe(true);
    expect(runtime.status()).toMatchObject({ state: "stopped", activeSse: 0, activeOperations: 0 });
  });

  test("stall and cancel release the handler's iterator, capability, and admission together", async () => {
    await restart(limits({
      sse: { ...PRODUCTION_LIMITS.sse, maxStallMs: 100 },
    }));
    const beginHeld = async (id: number) => {
      const started = deferred<void>();
      const returned = deferred<void>();
      externalSseStarted = started;
      externalSseReturned = returned;
      const response = await runtime.runSse({
        id,
        address: "ops.holdSse",
        args: {},
        principal: ANONYMOUS_PRINCIPAL,
      });
      await started.promise;
      return { response, returned };
    };

    // An unacknowledged chunk stalls out; the terminal ACK closes the stream,
    // returns the suspended generator, and releases operation admission.
    const acknowledged = await beginHeld(90);
    const acknowledgedReader = acknowledged.response.stream.getReader();
    expect(sseMessage((await acknowledgedReader.read()).value!)).toMatchObject({
      t: "sse_chunk",
      value: { phase: "held" },
    });
    const acknowledgedTerminal = sseMessage((await acknowledgedReader.read()).value!);
    expect(acknowledgedTerminal).toMatchObject({
      t: "sse_error",
      outcome: { code: "slow_consumer" },
    });
    expect(runtime.status()).toMatchObject({ activeSse: 1, activeOperations: 1 });
    expect(runtime.ackSse({
      v: PROTOCOL_VERSION,
      t: "sse_ack",
      stream: acknowledged.response.streamId,
      seq: acknowledgedTerminal.seq,
      proof: acknowledgedTerminal.proof,
    })).toBe(true);
    expect((await acknowledgedReader.read()).done).toBe(true);
    acknowledgedReader.releaseLock();
    await acknowledged.returned.promise;
    await eventually(() => runtime.status().activeSse === 0);
    await eventually(() => runtime.status().activeOperations === 0);

    // A terminal frame that never gets credited force-closes on the second
    // stall; the stream capability is expired afterwards.
    const forced = await beginHeld(91);
    const forcedReader = forced.response.stream.getReader();
    expect(sseMessage((await forcedReader.read()).value!).t).toBe("sse_chunk");
    const forcedTerminal = sseMessage((await forcedReader.read()).value!);
    expect(forcedTerminal.t).toBe("sse_error");
    expect(runtime.status()).toMatchObject({ activeSse: 1, activeOperations: 1 });
    await expect(forcedReader.read()).rejects.toMatchObject({ code: "slow_consumer" });
    forcedReader.releaseLock();
    await forced.returned.promise;
    await eventually(() => runtime.status().activeSse === 0);
    await eventually(() => runtime.status().activeOperations === 0);
    expect(runtime.ackSse({
      v: PROTOCOL_VERSION,
      t: "sse_ack",
      stream: forced.response.streamId,
      seq: forcedTerminal.seq,
      proof: forcedTerminal.proof,
    })).toBe(false);

    // Consumer cancellation between chunks settles the same way, promptly.
    const canceled = await beginHeld(92);
    const canceledReader = canceled.response.stream.getReader();
    expect(sseMessage((await canceledReader.read()).value!).t).toBe("sse_chunk");
    await canceledReader.cancel("consumer stopped");
    await canceled.returned.promise;
    await eventually(() => runtime.status().activeSse === 0);
    await eventually(() => runtime.status().activeOperations === 0);
  });

  test("keeps a closing session owned until a blocked subscription attach finalizes", async () => {
    await session.open();
    revalidationGate = deferred<void>();
    revalidationEntered = deferred<void>();
    const attaching = runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 85,
      ref: "messages.parallelList",
      args: { channelId: 1n },
    }));
    await revalidationEntered.promise;

    const closing = session.close();
    expect(runtime.status()).toMatchObject({
      connections: 1,
      activeOperations: 1,
    });
    await expect(runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 86,
      ref: "messages.list",
      args: { channelId: 1n },
    }))).rejects.toMatchObject({ code: "auth_stale" });

    revalidationGate.resolve(undefined);
    await expect(attaching).rejects.toMatchObject({ code: "auth_stale" });
    await closing;
    expect(session.publications).toEqual([]);
    expect(runtime.status()).toMatchObject({
      connections: 0,
      activeOperations: 0,
      reactive: { queryListeners: 0, eventListeners: 0 },
    });
  });

  test("owns a finite deadline across stalled active reader and publication work", async () => {
    await restart(limits({ gracefulShutdownMs: 500 }));
    await session.open();
    await runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 86,
      ref: "messages.parallelList",
      args: { channelId: 1n },
    }));
    revalidationGate = deferred<void>();
    revalidationEntered = deferred<void>();
    const mutation = session.mutation(87, "messages.send", { channelId: 1n, body: "blocked" });
    await revalidationEntered.promise;

    const startedAt = performance.now();
    const drain = runtime.drain(Date.now() + 20);
    expect(runtime.status()).toMatchObject({
      state: "draining",
      connections: 1,
      reader: { queue: { closed: true } },
      writer: { queue: { closed: true } },
      publication: { closed: true },
      reactive: { queryListeners: 1, eventListeners: 0 },
    });
    await expect(runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 88,
      ref: "messages.list",
      args: { channelId: 1n },
    }))).rejects.toMatchObject({
      code: "draining",
      retryable: true,
      retryAfterMs: 1_000,
      resource: "operation",
    });
    await expect(drain).rejects.toMatchObject({
      code: "deadline_exceeded",
      resource: "operation",
    });
    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(15);
    expect(elapsed).toBeLessThan(250);
    expect(runtime.status().state).toBe("failed");

    revalidationGate.resolve(undefined);
    await mutation.catch(() => {});
    await eventually(() => runtime.status().connections === 0);
    expect(runtime.status().reactive).toMatchObject({ queryListeners: 0, eventListeners: 0 });
    expect(runtime.status().state).toBe("failed");
  });

  test("a hanging external telemetry flush cannot exceed Runtime's deadline", async () => {
    await restart(
      limits({ gracefulShutdownMs: 20 }),
      new HangingTelemetry({ localSink: false }),
    );

    const startedAt = performance.now();
    await expect(runtime.drain()).rejects.toMatchObject({
      code: "deadline_exceeded",
      resource: "operation",
    });
    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(15);
    expect(elapsed).toBeLessThan(250);
    expect(runtime.status().state).toBe("failed");
  });

  test("includes the stopped lifecycle event in its owned telemetry drain", async () => {
    const exported: unknown[] = [];
    await restart(limits(), {
      localSink: false,
      exporter: {
        export: (records) => {
          exported.push(...records);
        },
      },
    });

    await runtime.drain();

    expect(exported.filter(
      (record): record is { kind: string; name: string; lifecycleState: string } =>
        typeof record === "object" &&
        record !== null &&
        "kind" in record &&
        "name" in record &&
        "lifecycleState" in record &&
        record.kind === "event" &&
        record.name === "lifecycle",
    ).map((record) => record.lifecycleState)).toEqual(["ready", "draining", "stopped"]);
  });

  test("stops admission, waits for accepted work, and becomes stopped", async () => {
    await session.open();
    queryGate = deferred<void>();
    const accepted = runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 1,
      ref: "messages.block",
      args: {},
    }));
    await Promise.resolve();
    const drain = runtime.drain();
    expect(runtime.status().state).toBe("draining");
    await expect(runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 2,
      ref: "messages.block",
      args: {},
    }))).rejects.toMatchObject({ code: "draining" });
    queryGate.resolve(undefined);
    await expect(accepted).resolves.toBe("released");
    await drain;
    expect(runtime.status().state).toBe("stopped");
  });

  test("rejects duplicate live client-session ownership", async () => {
    await session.open();
    const duplicate = new SessionHarness(runtime, "session-a");
    await expect(duplicate.open()).rejects.toMatchObject({
      code: "conflict",
      retryable: true,
      retryAfterMs: 0,
      resource: "connection",
    });
    expect(runtime.status().connections).toBe(1);
  });
});

describe("configured capacity", () => {
  beforeEach(async () => {
    await runtime.drain();
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
    directory = mkdtempSync(join(tmpdir(), "dbzz-runtime-capacity-"));
    start(limits({ maxConnections: 1, maxFrameBytes: 256 }));
  });

  test("reports the selected durability and disabled telemetry state", () => {
    expect(runtime.status()).toMatchObject({
      state: "ready",
      connections: 0,
      telemetry: { enabled: false },
      storage: { durability: "production", synchronous: "FULL" },
    });
  });

  test("bounds connection admission", async () => {
    await session.open();
    const second = new SessionHarness(runtime, "session-b");
    await expect(second.open()).rejects.toMatchObject({ code: "overloaded", resource: "connection" });
  });

  test("sheds each Runtime operation limit in order and recovers all capacity", async () => {
    await restart(limits({
      maxConnections: 5,
      maxOperations: 3,
      maxOperationsPerCaller: 2,
      maxOperationsPerConnection: 1,
    }));
    const hotPeer = new SessionHarness(runtime, "session-hot-peer");
    const hotExcess = new SessionHarness(runtime, "session-hot-excess");
    const cold = new SessionHarness(runtime, "session-cold");
    const globalExcess = new SessionHarness(runtime, "session-global-excess");
    await Promise.all([
      session.open(user("hot")),
      hotPeer.open(user("hot")),
      hotExcess.open(user("hot")),
      cold.open(user("cold")),
      globalExcess.open(user("global-excess")),
    ]);
    const gate = deferred<void>();
    queryGate = gate;
    const blocked = (owner: SessionHarness, id: number) =>
      runtime.query(owner.context, request({
        v: PROTOCOL_VERSION,
        t: "q",
        id,
        ref: "messages.block",
        args: {},
      }));
    const held: Promise<unknown>[] = [];
    const overload = {
      code: "overloaded",
      retryable: true,
      retryAfterMs: 0,
      resource: "operation",
    } as const;
    const scenarios = [
      [session, session, "per-connection operation capacity is full"],
      [hotPeer, hotExcess, "per-caller operation capacity is full"],
      [cold, globalExcess, "operation capacity is full"],
    ] as const;

    try {
      for (const [index, [admitted, rejected, message]] of scenarios.entries()) {
        held.push(blocked(admitted, 60 + index * 2));
        await eventually(() => runtime.status().activeOperations === index + 1);
        await expect(blocked(rejected, 61 + index * 2)).rejects.toMatchObject({
          ...overload,
          message,
        });
      }
      expect(runtime.status()).toMatchObject({
        activeOperations: 3,
        activeOperationCallers: 2,
        reader: { active: 3, queue: { queuedItems: 0, queuedBytes: 0 } },
      });
    } finally {
      gate.resolve(undefined);
    }

    await expect(Promise.all(held)).resolves.toEqual(["released", "released", "released"]);
    expect(runtime.status()).toMatchObject({
      activeOperations: 0,
      activeOperationCallers: 0,
      reader: { active: 0, queue: { queuedItems: 0, queuedBytes: 0 } },
    });
    await expect(blocked(globalExcess, 66)).resolves.toBe("released");
  });

  test("retains subscription ordering only after operation admission succeeds", async () => {
    await restart(limits({ maxOperationsPerConnection: 1 }));
    await session.open();
    queryGate = deferred<void>();
    const rejectedPublication = deferred<void>();
    const releaseRejectedPublication = deferred<void>();
    session.beforePublish = async (publication) => {
      if (publication.message.id !== 71) return;
      rejectedPublication.resolve(undefined);
      await releaseRejectedPublication.promise;
    };

    const held = runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 70,
      ref: "messages.block",
      args: {},
    }));
    await eventually(() => runtime.status().activeOperations === 1);
    const rejectedControl = runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 71,
      ref: "messages.list",
      args: { channelId: 1n },
    }));
    void rejectedControl.catch(() => {});
    await rejectedPublication.promise;

    try {
      queryGate.resolve(undefined);
      await held;
      let mutationSettled = false;
      let mutationValue: unknown;
      let mutationError: unknown;
      const mutation = session.mutation(72, "messages.send", {
        channelId: 1n,
        body: "not behind rejected control",
      }).then(
        (result) => {
          mutationValue = result.value;
          mutationSettled = true;
        },
        (error) => {
          mutationError = error;
          mutationSettled = true;
        },
      );
      await eventually(() => mutationSettled);
      await mutation;
      expect(mutationError).toBeUndefined();
      expect(mutationValue).toBe(1n);
    } finally {
      releaseRejectedPublication.resolve(undefined);
    }
    await expect(rejectedControl).rejects.toMatchObject({
      code: "overloaded",
      resource: "operation",
    });
  });

  test("sheds per-connection and global subscription saturation then reuses released capacity", async () => {
    await restart(limits({
      maxConnections: 3,
      maxSubscriptionsPerConnection: 1,
      maxSubscriptions: 2,
    }));
    const second = new SessionHarness(runtime, "session-b");
    const third = new SessionHarness(runtime, "session-c");
    await Promise.all([session.open(), second.open(), third.open()]);
    const subscribe = (owner: SessionHarness, id: number, channelId: bigint) =>
      runtime.subscribe(owner.context, request({
        v: PROTOCOL_VERSION,
        t: "sub",
        id,
        ref: "messages.list",
        args: { channelId },
      }));
    const unsubscribe = (owner: SessionHarness, id: number) =>
      runtime.unsubscribe(owner.context, request({
        v: PROTOCOL_VERSION,
        t: "unsub",
        id,
      }));
    const overload = {
      code: "overloaded",
      retryable: true,
      retryAfterMs: 0,
      resource: "subscription",
    } as const;
    for (const [admitted, admittedId, admittedChannel, rejected, rejectedId, rejectedChannel, message] of [
      [session, 1, 1n, session, 2, 2n, "Per-connection subscription capacity is full"],
      [second, 1, 2n, third, 1, 3n, "Global subscription capacity is full"],
    ] as const) {
      await subscribe(admitted, admittedId, admittedChannel);
      await expect(subscribe(rejected, rejectedId, rejectedChannel)).rejects.toMatchObject({
        ...overload,
        message,
      });
    }
    const saturated = runtime.status();
    expect(saturated.reactive).toMatchObject({
      queryListeners: 2,
      evaluatingEntries: 0,
      revalidation: { active: 0, queue: { queuedItems: 0, queuedBytes: 0 } },
    });
    expect(saturated.reactive.queryListeners).toBe(runtime.limits.maxSubscriptions);
    expect(saturated.reactive.resultBytes).toBeLessThanOrEqual(runtime.limits.maxSharedResultBytes);

    await unsubscribe(session, 1);
    await expect(subscribe(third, 1, 3n)).resolves.toBeUndefined();
    expect(third.publications.findLast(
      (frame) => frame.t === "transition" && frame.id === 1,
    )).toMatchObject({
      transition: { kind: "reset", value: [] },
    });
    expect(runtime.status().reactive).toMatchObject({ queryListeners: 2 });

    await Promise.all([unsubscribe(second, 1), unsubscribe(third, 1)]);
    expect(runtime.status().reactive).toMatchObject({ queryListeners: 0 });
  });

  test("rejects an oversized mutation response before its write commits", async () => {
    await session.open();
    await expect(session.mutation(1, "messages.largeResult", {
      channelId: 9n,
      size: 512,
    })).rejects.toMatchObject({ code: "overloaded", resource: "operation" });
    expect(engine.commitVersion()).toBe(0n);
    const rows = await runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 2,
      ref: "messages.list",
      args: { channelId: 9n },
    }));
    expect(rows).toEqual([]);
  });

  test("publishes an error instead of an oversized query success frame", async () => {
    await session.open();
    await expect(runtime.query(session.context, request({
      v: PROTOCOL_VERSION,
      t: "q",
      id: 3,
      ref: "messages.largeQuery",
      args: { size: 512 },
    }))).rejects.toMatchObject({ code: "overloaded", resource: "operation" });

    expect(session.publications.filter((frame) => frame.id === 3)).toEqual([
      expect.objectContaining({
        t: "err",
        outcome: expect.objectContaining({ code: "overloaded", resource: "operation" }),
      }),
    ]);
  });

  test("removes runtime ownership when an auth transition cannot fit its capture", async () => {
    await runtime.drain();
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
    directory = mkdtempSync(join(tmpdir(), "dbzz-runtime-auth-capture-"));
    start(limits({
      maxFrameBytes: 1_024,
      webSocket: {
        ...PRODUCTION_LIMITS.webSocket,
        maxBytesPerConnection: 1_025,
      },
    }));
    await session.open(user("alice"));
    await runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 50,
      ref: "messages.secure",
      args: {},
    }));

    await expect(session.rotate(user("bob"))).rejects.toMatchObject({ code: "unavailable" });
    expect(runtime.status()).toMatchObject({
      connections: 0,
      reactive: { queryListeners: 0, eventListeners: 0 },
      authCaptureBudget: { bytes: 0, applicationBytes: 0 },
    });
  });

  test("globally bounds concurrent auth capture leases and releases their exact bytes", async () => {
    const maxFrameBytes = 1_024;
    await restart(limits({ maxConnections: 2, maxFrameBytes }));
    await session.open(user("alice"));
    await runtime.subscribe(session.context, request({
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 51,
      ref: "messages.secure",
      args: {},
    }));
    const calibration = await session.rotateBatch(user("robin"));
    const exactCaptureBytes = calibration.bytes;
    expect(exactCaptureBytes).toBe(publicationBytes(calibration.frames));
    expect(runtime.status().authCaptureBudget.bytes).toBe(exactCaptureBytes);
    calibration.release();
    expect(runtime.status().authCaptureBudget.bytes).toBe(0);

    const globalBytes = exactCaptureBytes + maxFrameBytes;
    await restart(limits({
      maxConnections: 2,
      maxFrameBytes,
      webSocket: {
        ...PRODUCTION_LIMITS.webSocket,
        maxBytesPerConnection: globalBytes,
        maxBytes: globalBytes,
      },
    }));
    const first = session;
    const second = new SessionHarness(runtime, "session-b");
    await Promise.all([first.open(user("alice")), second.open(user("alice"))]);
    for (const owner of [first, second]) {
      await runtime.subscribe(owner.context, request({
        v: PROTOCOL_VERSION,
        t: "sub",
        id: 51,
        ref: "messages.secure",
        args: {},
      }));
    }

    const firstBatch = await first.rotateBatch(user("robin"));
    expect(firstBatch.bytes).toBe(exactCaptureBytes);
    expect(runtime.status().authCaptureBudget).toMatchObject({
      bytes: exactCaptureBytes,
      applicationBytes: exactCaptureBytes,
      controlBytes: 0,
      maxBytes: globalBytes,
      reservedControlBytes: maxFrameBytes,
    });
    await expect(second.rotateBatch(user("robin"))).rejects.toMatchObject({
      code: "unavailable",
      resource: "subscription",
    });
    expect(runtime.status()).toMatchObject({
      connections: 1,
      authCaptureBudget: { bytes: exactCaptureBytes, applicationBytes: exactCaptureBytes },
    });

    firstBatch.release();
    firstBatch.release();
    expect(runtime.status().authCaptureBudget).toMatchObject({ bytes: 0, applicationBytes: 0 });
  });
});
