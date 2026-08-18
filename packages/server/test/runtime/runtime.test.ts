import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACKERDB_VERSION,
  Err,
  Status,
  encode,
  parseSseMessage,
  type MutationMessage,
  type ProcedureMessage,
  type SseMessage,
} from "@ackerdb/core";
import {
  ANONYMOUS_PRINCIPAL,
  type Principal,
  type UserPrincipal,
} from "../../src/auth/credentials.ts";
import { callerFairnessKey } from "../../src/runtime/caller.ts";
import { v } from "../../src/validation/v.ts";
import { Engine } from "../../src/database/engine.ts";
import { AckerDBError } from "../../src/shared/errors.ts";
import { mutation, procedure, query, sseProcedure } from "../../src/app/functions.ts";
import { channel } from "../../src/channels/definition.ts";
import { PRODUCTION_LIMITS, type ServiceLimits } from "../../src/runtime/limits.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { Registry } from "../../src/app/registry.ts";
import { carryHttpRequestProvenance } from "../../src/runtime/request-provenance.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type {
  RuntimeHttpResponse,
  RuntimeSseResponse,
} from "../../src/runtime/contracts/requests.ts";
import { defineEventTable, defineSchema, defineTable } from "../../src/schema/definition.ts";
import { declareJobs, job } from "../../src/jobs/definition.ts";
import { JOB_RUNS_TABLE, JOBS_TABLE } from "../../src/jobs/table.ts";
import type {
  RuntimePublication,
  RuntimePublicationBatch,
  RuntimeRequest,
  SessionApplicationMessage,
  SessionRuntimeContext,
} from "../../src/subscriptions/session/contract.ts";
import { deferred, type Deferred } from "ackerdb-test-support/async";
import { exposedHttpCodec } from "../support/http.ts";

const TEST_SOURCE = Object.freeze({ family: "test", address: "runtime" });

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
    scopes: [],
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
});

// Tests exercise runtime ownership, not generated application types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const declaredJobs = () => declareJobs({
  reminders: {
    fire: job({
      mode: "mutation",
      args: { message: v.string(), attempt: v.int() },
      handler: async (tx: Ctx, args: Ctx) => {
        scheduledAttempts++;
        scheduledAttempt = args.attempt;
        await tx.db.log.insert({ line: `fired:${args.message}` });
        if (args.message === "fail") throw new Error("scheduled failure");
      },
    }),
  },
});

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
let currentTime: number | null = null;
let mutationResultReads = 0;
let mutationResultValue: object = {};
let writeThenErrCalls = 0;

const functions = {
  messages: {
    list: query({
      access: "public",
      http: true,
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
      http: true,
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
  chat: {
    room: channel({
      args: { threadId: v.bigint() },
      room: v.string(),
      clientEvents: { message: v.string() },
      serverEvents: {
        message: v.object({ body: v.string(), principal: v.string() }),
      },
      access: "public",
      on: {
        message: async (ctx: Ctx, body: string) => {
          await ctx.tx((tx: Ctx) =>
            tx.db.messages.insert({ channelId: ctx.args.threadId, body })
          );
          await ctx.publish("message", {
            body,
            principal: ctx.auth.kind,
          });
        },
      },
    }),
  },
  reminders: {
    pending: query({
      access: "public",
      args: {},
      handler: (ctx: Ctx) =>
        ctx.jobs.reminders.fire
          .query()
          .where((row: Ctx) => row.state.eq("pending"))
          .collect(),
    }),
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
      http: true,
      args: { message: v.string(), attempt: v.int(), at: v.float() },
      handler: (ctx: Ctx, args: Ctx) =>
        ctx.jobs.reminders.fire.enqueue(
          { message: args.message, attempt: args.attempt },
          { at: args.at },
        ),
    }),
  },
  ops: {
    echo: procedure({
      access: "public",
      http: true,
      args: { value: v.string() },
      handler: (_ctx: Ctx, args: Ctx) => args.value,
    }),
    enterSystem: procedure({
      access: "public",
      http: true,
      args: {},
      handler: async (ctx: Ctx): Promise<unknown> => {
        const nested: unknown = await runtime.system.run(
          "test.from-procedure",
          async (systemCtx): Promise<unknown> => {
            const echoed: unknown = await functions.ops.echo(
              systemCtx,
              { value: systemCtx.auth.kind },
            );
            return { principal: systemCtx.auth.kind, echoed };
          },
        );
        return { caller: ctx.auth.kind, nested };
      },
    }),
    reject: procedure({
      access: "public",
      http: true,
      args: { reason: v.string() },
      handler: (_ctx: Ctx, args: Ctx) =>
        Err("procedure-rejected", { reason: args.reason }, Status.UnprocessableContent),
    }),
    block: procedure({
      access: "public",
      http: true,
      args: {},
      handler: async () => {
        externalProcedureStarted?.resolve(undefined);
        await externalProcedureRelease?.promise;
        return "released";
      },
    }),
    blockRejectingCancellation: procedure({
      access: "public",
      http: true,
      args: {},
      handler: async (ctx: Ctx) => {
        externalProcedureStarted?.resolve(undefined);
        await externalProcedureRelease?.promise;
        if (ctx.signal.aborted) throw ctx.signal.reason;
        return "released";
      },
    }),
    pipeline: procedure({
      access: "public",
      http: true,
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
      http: true,
      args: {},
      handler: (ctx: Ctx) => ctx.tx(() => ctx.tx(() => 1)),
    }),
    catchTxThrow: procedure({
      access: "public",
      http: true,
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
      http: true,
      args: {},
      handler: () => {
        throw new AckerDBError("conflict", "💥".repeat(512));
      },
    }),
    stream: sseProcedure({
      access: "public",
      http: true,
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
      http: true,
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
      http: true,
      args: {},
      yields: v.object({ value: v.string() }),
      handler: async function* () {
        yield { value: "first" };
        yield { value: 2 as unknown as string };
      },
    }),
    failingStream: sseProcedure({
      access: "public",
      http: true,
      args: {},
      yields: v.jsonb(),
      handler: () => {
        throw new Error("stream failed");
      },
    }),
    waitForAbort: sseProcedure({
      access: "public",
      http: true,
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
      http: true,
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
    this.controller.abort(new AckerDBError("draining", "session closed"));
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
      v: ACKERDB_VERSION,
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
  return parseSseMessage(JSON.parse(text.slice(6).trim()));
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

async function start(customLimits = limits()): Promise<void> {
  engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  runtime = new Runtime({
    engine,
    registry: new Registry(functions),
    limits: customLimits,
    jobs: declaredJobs(),
    now: () => currentTime ?? Date.now(),
  });
  await runtime.start();
  session = new SessionHarness(runtime, "session-a");
}

async function restart(customLimits: ServiceLimits): Promise<void> {
  await runtime.drain().catch(() => {});
  engine.close("clean");
  rmSync(directory, { recursive: true, force: true });
  directory = mkdtempSync(join(tmpdir(), "ackerdb-runtime-restart-"));
  await start(customLimits);
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "ackerdb-runtime-"));
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
  currentTime = null;
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
  await start();
});

afterEach(async () => {
  await runtime.drain().catch(() => {});
  engine.close("clean");
  rmSync(directory, { recursive: true, force: true });
});

describe("application channels", () => {
  test("joins room audiences, runs typed handlers with transactions, and releases membership", async () => {
    const second = new SessionHarness(runtime, "session-b");
    const otherRoom = new SessionHarness(runtime, "session-c");
    await Promise.all([session.open(), second.open(), otherRoom.open()]);

    for (const [target, id, room] of [
      [session, 1, "support"],
      [second, 2, "support"],
      [otherRoom, 3, "sales"],
    ] as const) {
      await runtime.joinChannel(target.context, request({
        t: "channel_join",
        id,
        ref: "api.chat.room",
        args: { threadId: 7n },
        room,
      }));
      expect(target.publications.at(-1)).toMatchObject({
        t: "channel_ready",
        id,
        authEpoch: 0,
      });
    }

    await runtime.sendChannel(session.context, request({
      t: "channel_send",
      id: 1,
      event: "message",
      payload: "hello",
    }));

    expect(session.publications.at(-1)).toMatchObject({
      t: "channel_event",
      id: 1,
      event: "message",
      payload: { body: "hello", principal: "anonymous" },
    });
    expect(second.publications.at(-1)).toMatchObject({
      t: "channel_event",
      id: 2,
      event: "message",
      payload: { body: "hello", principal: "anonymous" },
    });
    expect(otherRoom.publications.filter((message) =>
      message.t === "channel_event"
    )).toEqual([]);

    const stored = await runtime.query(session.context, request({
      t: "q",
      id: 4,
      ref: "api.messages.list",
      args: { channelId: 7n },
    }));
    expect(stored).toEqual([
      { id: 1n, channelId: 7n, body: "hello" },
    ]);

    await runtime.leaveChannel(second.context, request({
      t: "channel_leave",
      id: 2,
    }));
    await runtime.sendChannel(session.context, request({
      t: "channel_send",
      id: 1,
      event: "message",
      payload: "after-leave",
    }));
    expect(second.publications.filter((message) =>
      message.t === "channel_event"
    )).toHaveLength(1);

    await Promise.all([second.close(), otherRoom.close()]);
  });
});

describe("runtime commit and replay ownership", () => {
  test("reuses the precommit mutation publication after idempotency encoding", async () => {
    await session.open();
    const result = await session.mutation(1, "api.messages.canaryResult", {});
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
      t: "q",
      id: 2,
      ref: "api.messages.nonWireQuery",
      args: {},
    }))).rejects.toMatchObject({ code: "validation" });

    expect(session.publications.filter((frame) => frame.id === 2)).toEqual([
      expect.objectContaining({
        t: "err",
        outcome: expect.objectContaining({ code: "validation" }),
      }),
    ]);
  });

  test("answers one query's declared error identically over the session and HTTP", async () => {
    await session.open();
    const framed = await runtime.query(session.context, request({
      t: "q",
      id: 20,
      ref: "api.messages.missing",
      args: { id: 7n },
    }));
    const response = await runtime.runQuery({
      id: 21,
      address: "api.messages.missing",
      args: { id: 7n },
      codec: exposedHttpCodec(runtime, "api.messages.missing"),
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }) => new Response(body, { status }),
    });

    expect(framed).toMatchObject({ ok: false, error: { code: "message-not-found" } });
    expect(response.status).toBe(404);
    // The HTTP body is the same ApplicationError the session frame carries,
    // spelled in the standard JSON this surface publishes: the declared bigint
    // body crosses as its decimal string, never as a wire escape object.
    expect(JSON.parse(await response.text())).toEqual({
      kind: "application",
      code: "message-not-found",
      body: { id: "7" },
      status: 404,
    });

    const value = await runtime.runQuery({
      id: 22,
      address: "api.messages.list",
      args: { channelId: 1n },
      codec: exposedHttpCodec(runtime, "api.messages.list"),
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }) => new Response(body, { status }),
    });
    expect(value.status).toBe(200);
    expect(JSON.parse(await value.text())).toEqual([]);

    // Kind dispatch is the registry's, so a procedure address is never a query.
    const mismatched = await runtime.runQuery({
      id: 23,
      address: "api.ops.echo",
      args: { value: "x" },
      codec: exposedHttpCodec(runtime, "api.ops.echo"),
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }) => new Response(body, { status }),
    });
    expect(mismatched.status).toBe(400);
    expect(JSON.parse(await mismatched.text())).toMatchObject({ code: "validation" });
  });

  test("refuses to run a query on a clock that stopped returning milliseconds", async () => {
    currentTime = Number.NaN;
    let response: Response;
    try {
      response = await runtime.runQuery({
        id: 24,
        address: "api.messages.list",
        args: { channelId: 1n },
        codec: exposedHttpCodec(runtime, "api.messages.list"),
        principal: ANONYMOUS_PRINCIPAL,
        respond: ({ body, status }) => new Response(body, { status }),
      });
    } finally {
      currentTime = null;
    }
    expect(response.status).toBe(500);
    expect(JSON.parse(await response.text())).toMatchObject({ code: "internal" });
  });

  test("publishes application errors separately and uses a procedure's named HTTP status", async () => {
    await session.open();
    const queryResult = await runtime.query(session.context, request({
      t: "q",
      id: 10,
      ref: "api.messages.missing",
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
      address: "api.ops.reject",
      args: { reason: "not now" },
      codec: exposedHttpCodec(runtime, "api.ops.reject"),
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }) => new Response(body, { status }),
    });
    expect(response.status).toBe(422);
    // The HTTP body is the plain ApplicationError, never a protocol frame.
    expect(JSON.parse(await response.text())).toEqual({
      kind: "application",
      code: "procedure-rejected",
      body: { reason: "not now" },
      status: 422,
    });
  });

  test("validates queries and keeps failed transaction writes invisible", async () => {
    await session.open();
    const first = await session.mutation(1, "api.messages.send", { channelId: 1n, body: "hello" });
    expect(first.value).toBe(1n);
    expect(first.receipt).toMatchObject({ replay: "executed", durability: "production" });

    await expect(runtime.query(session.context, request({
      t: "q",
      id: 2,
      ref: "api.messages.list",
      args: { channelId: 1 },
    }))).rejects.toMatchObject({ code: "validation" });
    await expect(session.mutation(3, "api.messages.fetchInside", {})).rejects.toThrow("fetch is not allowed");
    await expect(session.mutation(4, "api.messages.composeFail", { channelId: 2n })).rejects.toThrow("compose failed");

    const rolledBack = await runtime.query(session.context, request({
      t: "q",
      id: 5,
      ref: "api.messages.list",
      args: { channelId: 2n },
    })) as unknown[];
    expect(rolledBack).toEqual([]);
  });

  test("rolls back returned Err scopes and poisons caught nested throws", async () => {
    await session.open();

    const handled = await session.mutation(20, "api.messages.handleChildErr", { channelId: 20n });
    expect(handled.value).toBe("queued");
    const handledRows = await runtime.query(session.context, request({
      t: "q",
      id: 21,
      ref: "api.messages.list",
      args: { channelId: 20n },
    })) as Array<{ body: string }>;
    expect(handledRows.map((row) => row.body)).toEqual(["parent-before", "parent-after"]);

    const versionBeforeErr = engine.commitVersion();
    const recordsBeforeErr = engine.writer
      .query("SELECT COUNT(*) AS count FROM _ackerdb_mutations")
      .get() as { count: bigint };
    const errIssuedAt = Date.now();
    const errRequestId = uuidV7(errIssuedAt, 22);
    const propagated = await session.mutation(
      22,
      "api.messages.propagateChildErr",
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
      (engine.writer.query("SELECT COUNT(*) AS count FROM _ackerdb_mutations").get() as {
        count: bigint;
      }).count,
    ).toBe(recordsBeforeErr.count + 1n);
    const callsAfterErr = writeThenErrCalls;
    const replayedErr = await session.mutation(
      23,
      "api.messages.propagateChildErr",
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
      t: "q",
      id: 24,
      ref: "api.messages.list",
      args: { channelId: 22n },
    }))).toEqual([]);

    await expect(session.mutation(
      25,
      "api.messages.catchNestedThrow",
      { channelId: 24n },
    )).rejects.toThrow("storage exploded");
    expect(await runtime.query(session.context, request({
      t: "q",
      id: 26,
      ref: "api.messages.list",
      args: { channelId: 24n },
    }))).toEqual([]);
  });

  test("rejects parent database work while a nested mutation owns the savepoint", async () => {
    await session.open();
    nestedMutationEntered = deferred<void>();
    nestedMutationRelease = deferred<void>();

    await expect(session.mutation(
      27,
      "api.messages.overlapNestedMutation",
      { channelId: 27n },
    )).rejects.toThrow(
      "concurrent database access crossed a nested mutation boundary",
    );
    expect(await runtime.query(session.context, request({
      t: "q",
      id: 28,
      ref: "api.messages.list",
      args: { channelId: 27n },
    }))).toEqual([]);
  });

  test("a caught database failure still poisons and rolls back the mutation", async () => {
    await session.open();
    await expect(session.mutation(
      29,
      "api.messages.catchDatabaseThrow",
      { channelId: 29n },
    )).rejects.toThrow("row 9999 not found");
    expect(await runtime.query(session.context, request({
      t: "q",
      id: 30,
      ref: "api.messages.list",
      args: { channelId: 29n },
    }))).toEqual([]);
  });

  test("replays one scoped mutation exactly and rejects semantic reuse", async () => {
    await session.open();
    const now = Date.now();
    const requestId = uuidV7(now, 99);
    const first = await session.mutation(
      1,
      "api.messages.send",
      { channelId: 5n, body: "once" },
      requestId,
      now,
    );
    engine.writer.query(
      "UPDATE _ackerdb_mutations SET durability = 'balanced' WHERE session_id = ? AND request_id = ?",
    ).run(session.context.clientSessionId, requestId);
    const replay = await session.mutation(
      2,
      "api.messages.send",
      { channelId: 5n, body: "once" },
      requestId,
      now,
    );
    expect(replay.value).toBe(first.value);
    expect(replay.receipt).toMatchObject({ replay: "replayed", durability: "balanced" });
    await expect(session.mutation(
      3,
      "api.messages.send",
      { channelId: 5n, body: "different" },
      requestId,
      now,
    )).rejects.toMatchObject({ code: "conflict", resource: "idempotency" });

    const rows = await runtime.query(session.context, request({
      t: "q",
      id: 4,
      ref: "api.messages.list",
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
      t: "sub",
      id: 40,
      ref: "api.messages.parallelList",
      args: { channelId: 1n },
    }));
    await revalidationEntered.promise;

    let resetSettled = false;
    let unsubscribeSettled = false;
    const resetting = runtime.reset(session.context, request({
      t: "reset",
      id: 40,
      cursor: { generation: "stale", commitVersion: 0n, authEpoch: 0, identity: "stale" },
    })).finally(() => {
      resetSettled = true;
    });
    const unsubscribing = runtime.unsubscribe(session.context, request({
      t: "unsub",
      id: 40,
    })).finally(() => {
      unsubscribeSettled = true;
    });
    const independent = runtime.subscribe(session.context, request({
      t: "sub",
      id: 41,
      ref: "api.messages.list",
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
      t: "sub",
      id: 50,
      ref: "api.messages.parallelList",
      args: { channelId: 1n },
    }));
    await revalidationEntered.promise;

    const mutation = session.mutation(51, "api.messages.send", { channelId: 3n, body: "after-control" });
    const laterSubscription = runtime.subscribe(session.context, request({
      t: "sub",
      id: 52,
      ref: "api.messages.list",
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
      t: "sub",
      id: 60,
      ref: "api.messages.parallelList",
      args: { channelId: 1n },
    }));
    await revalidationEntered.promise;
    // An in-flight query is not a subscription control: the transition must
    // not wait for it, and it still settles with its own handler failure.
    queryFailureGate = deferred<void>();
    queryFailureEntered = deferred<void>();
    const failedQuery = runtime.query(session.context, request({
      t: "q",
      id: 61,
      ref: "api.messages.blockFail",
      args: {},
    }));
    void failedQuery.catch(() => {});
    await queryFailureEntered.promise;

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

    queryFailureGate.resolve(undefined);
    await expect(failedQuery).rejects.toThrow("stale query failure");
  });

  test("publishes initial reset and advances caller obligations before mutation resolution", async () => {
    await session.open();
    await runtime.subscribe(session.context, request({
      t: "sub",
      id: 10,
      ref: "api.messages.list",
      args: { channelId: 1n },
    }));
    expect(session.publications[0]).toMatchObject({ t: "transition", id: 10, transition: { kind: "reset" } });

    const result = await session.mutation(1, "api.messages.send", { channelId: 1n, body: "new" });
    expect(result.receipt.obligations).toEqual([10]);
    const update = session.publications.findLast(
      (frame) => frame.t === "transition" && frame.id === 10,
    );
    expect(update).toMatchObject({
      t: "transition",
      transition: { kind: "update", to: { commitVersion: result.receipt.commitVersion } },
    });

    await session.mutation(2, "api.messages.rewrite", { id: result.value as bigint });
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
      t: "sub",
      id: 60,
      ref: "api.messages.parallelList",
      args: { channelId: 1n },
    }));
    await runtime.subscribe(secondSession.context, request({
      t: "sub",
      id: 61,
      ref: "api.messages.parallelList",
      args: { channelId: 2n },
    }));

    revalidationGate = deferred<void>();
    revalidationEntered = deferred<void>();
    const first = session.mutation(70, "api.messages.send", { channelId: 1n, body: "first" });
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

    const second = secondSession.mutation(71, "api.messages.send", { channelId: 2n, body: "second" });
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
      t: "sub",
      id: 20,
      ref: "api.events.typing",
      args: { channelId: 7n },
    }));
    await runtime.subscribe(session.context, request({
      t: "sub",
      id: 21,
      ref: "api.events.typing",
      args: { channelId: 8n },
    }));
    await session.mutation(1, "api.messages.send", { channelId: 7n, body: "typing" });
    expect(session.publications.filter(
      (frame) => frame.t === "event" && frame.event.kind === "row",
    )).toMatchObject([
      { t: "event", id: 20, event: { row: { id: 1n, channelId: 7n } } },
    ]);
  });

  test("authorizes and freezes event subscriptions across refresh and terminal sign-out", async () => {
    await session.open(user("alice"));
    await expect(runtime.subscribe(session.context, request({
      t: "sub",
      id: 22,
      ref: "api.events.privateTyping",
      args: { channelId: "wrong" },
    }))).rejects.toMatchObject({ code: "validation" });

    await runtime.subscribe(session.context, request({
      t: "sub",
      id: 23,
      ref: "api.events.privateTyping",
      args: { channelId: 9n },
    }));
    expect(Object.isFrozen(eventAccessInputs.at(-1)!.ctx)).toBe(true);
    expect(Object.isFrozen(eventAccessInputs.at(-1)!.args)).toBe(true);
    expect("token" in eventAccessInputs.at(-1)!.ctx).toBe(false);
    expect("credential" in eventAccessInputs.at(-1)!.ctx).toBe(false);

    await session.mutation(1, "api.messages.send", { channelId: 9n, body: "private" });
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
      t: "sub",
      id: 24,
      ref: "api.events.privateTyping",
      args: { channelId: 1n },
    }))).rejects.toMatchObject({ code: "unauthenticated" });
    expect(runtime.status().reactive.eventListeners).toBe(0);
  });

  test("auth rotation revokes then re-evaluates saved subscriptions under the new identity", async () => {
    await session.open(user("alice"));
    await runtime.subscribe(session.context, request({
      t: "sub",
      id: 30,
      ref: "api.messages.secure",
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
      t: "sub",
      id: 32,
      ref: "api.messages.secure",
      args: {},
    }));
    await expect(runtime.subscribe(session.context, request({
      t: "sub",
      id: 32,
      ref: "api.events.privateTyping",
      args: { channelId: 8n },
    }))).rejects.toMatchObject({ code: "conflict" });
    await runtime.subscribe(session.context, request({
      t: "sub",
      id: 31,
      ref: "api.events.privateTyping",
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
      t: "sub",
      id: 33,
      ref: "api.messages.secure",
      args: {},
    }));
    await runtime.subscribe(session.context, request({
      t: "sub",
      id: 34,
      ref: "api.events.privateTyping",
      args: { channelId: 9n },
    }));

    await session.close();

    expect(runtime.status()).toMatchObject({
      connections: 0,
      reactive: { queryListeners: 0, eventListeners: 0 },
    });
  });
});

describe("system execution root", () => {
  test("composes external work, procedures, queries, and mutations in one system context", async () => {
    const result = await runtime.system.run("test.pipeline", async (ctx) => {
      expect(ctx.auth).toEqual({ kind: "system" });
      const timestamp = ctx.timestamp;
      const external = await (await fetch("data:text/plain,external")).text();
      const echoed = await functions.ops.echo(ctx, { value: external });
      if (!echoed.ok) return echoed;
      return ctx.tx(async (tx: Ctx) => {
        expect(tx.auth).toBe(ctx.auth);
        expect(tx.timestamp).toBe(timestamp);
        const sent = await functions.messages.send(tx, {
          channelId: 7n,
          body: echoed.data,
        });
        if (!sent.ok) return sent;
        return functions.messages.list(tx, { channelId: 7n });
      });
    });

    expect(result).toMatchObject({
      ok: true,
      data: [{ channelId: 7n, body: "external" }],
    });
  });

  test("does not inherit authority from the invocation that triggered it", async () => {
    const response = await runtime.runProcedure({
      id: 301,
      address: "api.ops.enterSystem",
      args: {},
      codec: exposedHttpCodec(runtime, "api.ops.enterSystem"),
      principal: user("system-caller"),
      respond: ({ body, status }) => new Response(body, { status }),
    });

    expect(JSON.parse(await response.text())).toMatchObject({
      caller: "user",
      nested: {
        principal: "system",
        echoed: { ok: true, data: "system" },
      },
    });
  });

  test("starts pristine but rejects writer re-entry from a transaction-owned caller", async () => {
    const cancellation = new AbortController();
    let nestedPrincipal: string | undefined;
    const result = await runtime.system.run("test.reentrant.outer", (ctx) =>
      ctx.tx(async () => {
        const inner = runtime.system.run(
          "test.reentrant.inner",
          async (innerCtx) => {
            nestedPrincipal = innerCtx.auth.kind;
            const echoed = await functions.ops.echo(innerCtx, { value: "nested" });
            if (!echoed.ok) return echoed;
            return innerCtx.tx(() => "completed");
          },
          { signal: cancellation.signal },
        );
        const outcome = inner.then(
          () => "settled",
          (error: unknown) => error instanceof AckerDBError ? error.code : "unknown",
        );
        const first = await Promise.race([
          outcome,
          Bun.sleep(25).then(() => "blocked"),
        ]);
        if (first === "blocked") {
          cancellation.abort(new AckerDBError("unavailable", "diagnostic cleanup"));
          await outcome;
        }
        return first;
      })
    );

    expect(nestedPrincipal).toBe("system");
    expect(result).toMatchObject({ ok: true, data: "validation" });
  });

  test("rejects unsafe operation names before entering application code", async () => {
    for (const name of [
      "",
      "1starts-with-a-number",
      "contains spaces",
      "job.123456789",
      "job.550e8400-e29b-41d4-a716-446655440000",
      "x".repeat(129),
    ]) {
      let entered = false;
      await expect(runtime.system.run(name, () => {
        entered = true;
      })).rejects.toThrow("system operation name");
      expect(entered).toBe(false);
    }
  });

  test("returns values as-is and rejects with the callback's exact thrown failure", async () => {
    const value = Object.freeze({ direct: true });
    await expect(runtime.system.run("test.value", () => value)).resolves.toBe(value);

    const failure = new Error("system callback failed");
    await expect(runtime.system.run("test.failure", () => {
      throw failure;
    })).rejects.toBe(failure);
  });

  test("keeps canceled system work owned until the callback settles", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const controller = new AbortController();
    const completion = runtime.system.run("test.cancel", async (ctx) => {
      entered.resolve(undefined);
      await release.promise;
      expect(ctx.abortSignal.aborted).toBe(true);
      return "completed after cancellation";
    }, { signal: controller.signal });
    const outcome = completion.catch((error: unknown) => error);
    let delivered = false;
    void outcome.then(() => {
      delivered = true;
    });

    await entered.promise;
    controller.abort(new AckerDBError("unavailable", "caller canceled", {
      resource: "operation",
    }));
    await settle();
    expect(delivered).toBe(false);
    expect(runtime.status().activeOperations).toBe(1);

    release.resolve(undefined);
    expect(await outcome).toMatchObject({
      code: "indeterminate",
      message: "system callback completion is unknown after cancellation",
      resource: "operation",
    });
    expect(runtime.status().activeOperations).toBe(0);
  });

  test("refuses pre-canceled and excess system work before entering application code", async () => {
    await restart(limits({
      maxOperations: 2,
      maxOperationsPerCaller: 1,
      maxOperationsPerConnection: 2,
    }));
    const controller = new AbortController();
    const canceled = new AckerDBError("unavailable", "caller canceled", {
      resource: "operation",
    });
    controller.abort(canceled);
    let canceledEntered = false;
    await expect(runtime.system.run("test.pre-canceled", () => {
      canceledEntered = true;
    }, { signal: controller.signal })).rejects.toBe(canceled);
    expect(canceledEntered).toBe(false);

    const racing = new AbortController();
    const beforeEntry = new AckerDBError("unavailable", "canceled before entry", {
      resource: "operation",
    });
    let racingEntered = false;
    const racingCompletion = runtime.system.run("test.before-entry", () => {
      racingEntered = true;
    }, { signal: racing.signal });
    racing.abort(beforeEntry);
    await expect(racingCompletion).rejects.toBe(beforeEntry);
    expect(racingEntered).toBe(false);

    const entered = deferred<void>();
    const release = deferred<void>();
    const held = runtime.system.run("test.held", async () => {
      entered.resolve(undefined);
      await release.promise;
      return "released";
    });
    await entered.promise;
    const saturatedCanceled = new AbortController();
    const saturatedReason = new AckerDBError("unavailable", "canceled before admission", {
      resource: "operation",
    });
    saturatedCanceled.abort(saturatedReason);
    let saturatedCanceledEntered = false;
    await expect(runtime.system.run("test.saturated-canceled", () => {
      saturatedCanceledEntered = true;
    }, { signal: saturatedCanceled.signal })).rejects.toBe(saturatedReason);
    expect(saturatedCanceledEntered).toBe(false);

    let excessEntered = false;
    await expect(runtime.system.run("test.excess", () => {
      excessEntered = true;
    })).rejects.toMatchObject({
      code: "overloaded",
      message: "per-caller operation capacity is full",
      retryable: true,
      retryAfterMs: 0,
      resource: "operation",
    });
    expect(excessEntered).toBe(false);

    release.resolve(undefined);
    await expect(held).resolves.toBe("released");
    expect(runtime.status()).toMatchObject({
      activeOperations: 0,
      activeOperationCallers: 0,
    });
  });

  test("cancels work waiting for the writer without entering its transaction", async () => {
    const writerEntered = deferred<void>();
    const releaseWriter = deferred<void>();
    const held = runtime.system.run("test.writer-owner", (ctx) =>
      ctx.tx(async (tx: Ctx) => {
        writerEntered.resolve(undefined);
        await releaseWriter.promise;
        return tx.db.messages.insert({ channelId: 14n, body: "owner" });
      })
    );
    await writerEntered.promise;

    const controller = new AbortController();
    let transactionEntered = false;
    const waiting = runtime.system.run("test.writer-wait", async (ctx) => {
      return ctx.tx(async (tx: Ctx) => {
        transactionEntered = true;
        return tx.db.messages.insert({ channelId: 14n, body: "canceled" });
      });
    }, { signal: controller.signal });
    await eventually(() => runtime.status().writer.queue.queuedItems === 1);
    controller.abort(new AckerDBError("unavailable", "writer wait canceled", {
      resource: "operation",
    }));
    await expect(waiting).rejects.toMatchObject({
      code: "indeterminate",
      message: "system callback completion is unknown after cancellation",
      resource: "operation",
    });
    expect(transactionEntered).toBe(false);

    releaseWriter.resolve(undefined);
    await expect(held).resolves.toMatchObject({ ok: true });
    await session.open();
    expect(await runtime.query(session.context, request({
      t: "q",
      id: 305,
      ref: "api.messages.list",
      args: { channelId: 14n },
    }))).toMatchObject([{ body: "owner" }]);
  });

  test("preserves a system invocation queued for the writer", async () => {
    const writerEntered = deferred<void>();
    const releaseWriter = deferred<void>();
    const held = runtime.system.run("test.queued-owner", (ctx) =>
      ctx.tx(async () => {
        writerEntered.resolve(undefined);
        await releaseWriter.promise;
      })
    );
    await writerEntered.promise;

    const waiting = runtime.system.run("test.queued-writer", (ctx) =>
      ctx.tx((tx: Ctx) => tx.db.messages.insert({ channelId: 16n, body: "queued" }))
    );
    await eventually(() => runtime.status().writer.queue.queuedItems === 1);
    releaseWriter.resolve(undefined);

    await expect(held).resolves.toMatchObject({ ok: true });
    await expect(waiting).resolves.toMatchObject({ ok: true });
  });

  test("reports late cancellation honestly without rolling back a durable commit", async () => {
    const committed = deferred<void>();
    const release = deferred<void>();
    const controller = new AbortController();
    const completion = runtime.system.run("test.late-cancel", async (ctx) => {
      const result = await ctx.tx((tx: Ctx) =>
        tx.db.messages.insert({ channelId: 15n, body: "committed" })
      );
      expect(result.ok).toBe(true);
      committed.resolve(undefined);
      await release.promise;
      return "finished";
    }, { signal: controller.signal });
    await committed.promise;
    controller.abort(new AckerDBError("unavailable", "late cancellation", {
      resource: "operation",
    }));
    release.resolve(undefined);
    await expect(completion).rejects.toMatchObject({
      code: "indeterminate",
      message: "system callback completion is unknown after cancellation",
      resource: "operation",
    });

    await session.open();
    expect(await runtime.query(session.context, request({
      t: "q",
      id: 306,
      ref: "api.messages.list",
      args: { channelId: 15n },
    }))).toMatchObject([{ body: "committed" }]);
  });

  test("enforces registered access policies with the canonical system principal", async () => {
    const outcome = await runtime.system.run("test.system-access", (ctx) =>
      ctx.tx((tx: Ctx) => functions.reminders.fire(tx, {
        id: 1n,
        message: "direct-system",
        attempt: 1,
        at: Date.now() + 60_000,
      }))
    );
    expect(outcome.ok).toBe(true);
    expect(engine.reader.query('SELECT line FROM "log"').all()).toEqual([
      { line: "fired:direct-system" },
    ]);

    await session.open(user("not-system"));
    await expect(session.mutation(307, "api.reminders.fire", {
      id: 2n,
      message: "denied",
      attempt: 1,
      at: Date.now() + 60_000,
    })).rejects.toMatchObject({ code: "unauthorized" });
    expect(engine.reader.query('SELECT line FROM "log"').all()).toEqual([
      { line: "fired:direct-system" },
    ]);
  });

  test("cannot hide a thrown transaction failure by catching it in the system callback", async () => {
    await expect(runtime.system.run("test.poison", async (ctx) => {
      try {
        await ctx.tx(async (tx: Ctx) => {
          await tx.db.messages.insert({
            channelId: 13n,
            body: "must-roll-back",
          });
          throw new Error("system transaction failed");
        });
      } catch {
        return "claimed success";
      }
      return "unreachable";
    })).rejects.toThrow("system transaction failed");

    await session.open();
    expect(await runtime.query(session.context, request({
      t: "q",
      id: 304,
      ref: "api.messages.list",
      args: { channelId: 13n },
    }))).toEqual([]);
  });


  test("signals accepted system work, refuses new work, and drains only after settlement", async () => {
    const entered = deferred<void>();
    const observedShutdown = deferred<void>();
    const release = deferred<void>();
    const completion = runtime.system.run("test.drain", async (ctx) => {
      entered.resolve(undefined);
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) resolve();
        else ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      observedShutdown.resolve(undefined);
      await release.promise;
      return "settled";
    });
    const outcome = completion.catch((error: unknown) => error);
    await entered.promise;

    const drain = runtime.drain();
    let drained = false;
    void drain.then(() => {
      drained = true;
    });
    await observedShutdown.promise;
    expect(runtime.status()).toMatchObject({
      state: "draining",
      activeOperations: 1,
    });
    expect(drained).toBe(false);
    let rejectedEntered = false;
    await expect(runtime.system.run("test.after-drain", () => {
      rejectedEntered = true;
    })).rejects.toMatchObject({ code: "draining" });
    expect(rejectedEntered).toBe(false);

    release.resolve(undefined);
    await expect(outcome).resolves.toMatchObject({
      code: "indeterminate",
      message: "system callback completion is unknown after cancellation",
      resource: "operation",
    });
    await drain;
    expect(runtime.status()).toMatchObject({
      state: "stopped",
      activeOperations: 0,
      activeOperationCallers: 0,
    });
  });

  test("rolls back application Err and publishes successful transaction effects", async () => {
    await session.open();
    await runtime.subscribe(session.context, request({
      t: "sub",
      id: 302,
      ref: "api.messages.list",
      args: { channelId: 12n },
    }));
    const transitionsBefore = session.publications.filter((frame) =>
      frame.t === "transition" && frame.id === 302
    ).length;

    const failed = await runtime.system.run("test.rollback", (ctx) =>
      ctx.tx((tx: Ctx) => functions.messages.writeThenErr(tx, { channelId: 12n }))
    );
    expect(failed).toMatchObject({
      ok: false,
      error: { code: "stock-unavailable" },
    });
    expect(await runtime.query(session.context, request({
      t: "q",
      id: 303,
      ref: "api.messages.list",
      args: { channelId: 12n },
    }))).toEqual([]);
    expect(session.publications.filter((frame) =>
      frame.t === "transition" && frame.id === 302
    )).toHaveLength(transitionsBefore);

    const committed = await runtime.system.run("test.commit", (ctx) =>
      ctx.tx((tx: Ctx) => functions.messages.send(tx, {
        channelId: 12n,
        body: "published",
      }))
    );
    expect(committed.ok).toBe(true);
    await eventually(() => session.publications.filter((frame) =>
      frame.t === "transition" && frame.id === 302
    ).length > transitionsBefore);
    expect(session.publications.findLast((frame) =>
      frame.t === "transition" && frame.id === 302
    )).toMatchObject({
      t: "transition",
      transition: { kind: "update" },
    });
  });
});

describe("procedures and bounded SSE", () => {
  test("reports cancellation after every handler completion path as indeterminate", async () => {
    await session.open();
    for (const [index, ref] of ["api.ops.block", "api.ops.blockRejectingCancellation"].entries()) {
      externalProcedureStarted = deferred<void>();
      externalProcedureRelease = deferred<void>();
      const controller = new AbortController();
      const message: ProcedureMessage = {
        t: "p",
        id: index + 1,
        ref,
        args: {},
      };
      const completion = runtime.procedure(
        session.context,
        { ...request(message), signal: controller.signal },
      );

      await externalProcedureStarted.promise;
      controller.abort(new AckerDBError("unavailable", "procedure request was canceled", {
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
    }

    for (const [index, ref] of ["api.ops.block", "api.ops.blockRejectingCancellation"].entries()) {
      externalProcedureStarted = deferred<void>();
      externalProcedureRelease = deferred<void>();
      const controller = new AbortController();
      const response = runtime.runProcedure({
        id: index + 10,
        address: ref,
        args: {},
        codec: exposedHttpCodec(runtime, ref),
        principal: ANONYMOUS_PRINCIPAL,
        signal: controller.signal,
        respond: ({ body, status }) => new Response(body, { status }),
      });

      await externalProcedureStarted.promise;
      controller.abort(new AckerDBError("unavailable", "procedure request was canceled", {
        resource: "operation",
      }));
      externalProcedureRelease.resolve(undefined);

      expect(JSON.parse(await (await response).text())).toMatchObject({
        code: "indeterminate",
        message: "procedure completion is unknown after cancellation",
        resource: "operation",
      });
    }
  });

  test("runs external work outside an atomic procedure transaction", async () => {
    const response = await runtime.runProcedure({
      id: 1,
      address: "api.ops.pipeline",
      args: { channelId: 4n },
      codec: exposedHttpCodec(runtime, "api.ops.pipeline"),
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }) => new Response(body, { status }),
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text())).toEqual({ external: "external", body: "external" });
    const failed = await runtime.runProcedure({
      id: 2,
      address: "api.ops.nestedTx",
      args: {},
      codec: exposedHttpCodec(runtime, "api.ops.nestedTx"),
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }) => new Response(body, { status }),
    });
    expect(failed.status).toBe(400);
    expect(JSON.parse(await failed.text())).toMatchObject({ code: "validation" });
  });

  test("a caught ctx.tx throw still poisons the procedure and rolls back", async () => {
    const response = await runtime.runProcedure({
      id: 3,
      address: "api.ops.catchTxThrow",
      args: { channelId: 30n },
      codec: exposedHttpCodec(runtime, "api.ops.catchTxThrow"),
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }) => new Response(body, { status }),
    });
    expect(response.status).toBe(500);
    expect(JSON.parse(await response.text())).toMatchObject({ code: "internal" });

    await session.open();
    expect(await runtime.query(session.context, request({
      t: "q",
      id: 31,
      ref: "api.messages.list",
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
        codec: exposedHttpCodec(runtime, address),
        principal,
        respond: ({ body, status }) => new Response(body, { status }),
      });

    const held = invoke(10, "api.ops.block", {}, hot);
    try {
      await externalProcedureStarted.promise;
      expect(runtime.status()).toMatchObject({
        activeOperations: 1,
        activeOperationCallers: 1,
      });

      const rejected = await invoke(11, "api.ops.echo", { value: "same" }, rotatedHot);
      expect(rejected.status).toBe(429);
      expect(JSON.parse(await rejected.text())).toMatchObject({
        code: "overloaded",
        retryable: true,
        retryAfterMs: 0,
        resource: "operation",
      });

      const admitted = await invoke(12, "api.ops.echo", { value: "cold" }, cold);
      expect(admitted.status).toBe(200);
      expect(JSON.parse(await admitted.text())).toBe("cold");
    } finally {
      externalProcedureRelease.resolve(undefined);
    }
    expect((await held).status).toBe(200);
    expect(runtime.status()).toMatchObject({ activeOperations: 0, activeOperationCallers: 0 });
  });

  test("fits a tight all-emoji procedure failure to a parser-valid fallback", async () => {
    const fallback = { code: "conflict" as const, retryable: false, message: "err" };
    const maxFrameBytes = new TextEncoder().encode(JSON.stringify(fallback)).byteLength;
    await restart(limits({ maxFrameBytes }));

    const response = await runtime.runProcedure({
      id: 89,
      address: "api.ops.failEmoji",
      args: {},
      codec: exposedHttpCodec(runtime, "api.ops.failEmoji"),
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }) => new Response(body, { status }),
    });
    const body = await response.text();
    expect(response.status).toBe(409);
    expect(new TextEncoder().encode(body).byteLength).toBe(maxFrameBytes);
    expect(JSON.parse(body)).toEqual(fallback);
  });

  test("streams generator chunks receiver-credited and a terminal marker", async () => {
    const response = await runtime.runSse({
      id: 1,
      address: "api.ops.stream",
      args: { count: 2 },
      codec: exposedHttpCodec(runtime, "api.ops.stream"),
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
          v: ACKERDB_VERSION,
          t: "sse_ack",
          stream: "AAAAAAAAAAAAAAAAAAAAAA",
          seq: message.seq,
          proof: message.proof,
        })).toBe(false);
        expect(runtime.ackSse({
          v: ACKERDB_VERSION,
          t: "sse_ack",
          stream: response.streamId,
          seq: message.seq,
          proof: `${message.proof}x`,
        })).toBe(false);
        expect(runtime.ackSse({
          v: ACKERDB_VERSION,
          t: "sse_ack",
          stream: response.streamId,
          seq: message.seq + 100,
          proof: message.proof,
        })).toBe(false);
        expect(runtime.status().sseBudget.bytes).toBe(before);
      }
      if (message.t !== "sse_chunk") expect(runtime.status().activeSse).toBe(1);
      expect(runtime.ackSse({
        v: ACKERDB_VERSION,
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
      v: ACKERDB_VERSION,
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
      address: "api.ops.streamed",
      args: {},
      codec: exposedHttpCodec(runtime, "api.ops.streamed"),
      principal: ANONYMOUS_PRINCIPAL,
    });
    const messages = await collectSse(response);
    expect(messages.map((message) => message.t)).toEqual(["sse_chunk", "sse_done"]);
    expect(messages[0]).toMatchObject({ value: { type: "merged" } });
  });

  test("fails a stream on the first invalid chunk with the exact validation error", async () => {
    const response = await runtime.runSse({
      id: 1,
      address: "api.ops.invalidChunk",
      args: {},
      codec: exposedHttpCodec(runtime, "api.ops.invalidChunk"),
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

  test("turns a post-start SSE failure into a terminal ackerdb-error event", async () => {
    const response = await runtime.runSse({
      id: 1,
      address: "api.ops.failingStream",
      args: {},
      codec: exposedHttpCodec(runtime, "api.ops.failingStream"),
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
      t: "q",
      id: 81,
      ref: oversized,
      args: {},
    }, 0))).rejects.toMatchObject(expected);
    await expect(runtime.mutation(session.context, request({
      t: "m",
      id: 82,
      ref: "api.messages.send",
      args: { channelId: 1n, body: oversized },
      mutationRequestId: uuidV7(Date.now(), 82),
      issuedAt: Date.now(),
    }, 0))).rejects.toMatchObject(expected);
    const procedure = {
      id: 85,
      address: oversized,
      args: {},
      codec: exposedHttpCodec(runtime, "api.ops.echo"),
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }: RuntimeHttpResponse) => new Response(body, { status }),
      bytes: 0,
    };
    await expect(runtime.runProcedure(procedure)).rejects.toMatchObject(expected);
    const sse = {
      id: 86,
      address: oversized,
      args: {},
      codec: exposedHttpCodec(runtime, "api.ops.stream"),
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
      t: "q",
      id: 87,
      ref: "api.messages.list",
      args: { channelId: 1n },
    }, 257))).resolves.toEqual([]);

    const procedureRequest = {
      id: 88,
      address: "api.ops.echo",
      args: { value: "accepted" },
      codec: exposedHttpCodec(runtime, "api.ops.echo"),
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }: RuntimeHttpResponse) => new Response(body, { status }),
      bytes: 257,
    };
    const procedure = await runtime.runProcedure(procedureRequest);
    expect(procedure.status).toBe(200);

    const sseRequest = {
      id: 89,
      address: "api.ops.stream",
      args: { count: 0 },
      codec: exposedHttpCodec(runtime, "api.ops.stream"),
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
      address: "api.ops.echo",
      args: { value: "accepted canonically after the claim" },
      codec: exposedHttpCodec(runtime, "api.ops.echo"),
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }: RuntimeHttpResponse) => new Response(body, { status }),
    }, 257, undefined);

    await expect(runtime.runProcedure({ ...carried })).rejects.toMatchObject({
      code: "overloaded",
      resource: "operation",
    });
    expect((await runtime.runProcedure({ ...carried })).status).toBe(200);
  });

  test("charges every kind one request shape: the addressed function and its args", async () => {
    // What a direct caller is charged is the request this surface carries — the
    // addressed function and its args, no protocol envelope — so the same args
    // cost the same admission bytes whichever kind answers them.
    const respond = ({ body, status }: RuntimeHttpResponse) => new Response(body, { status });
    const run = {
      query: async (input: Ctx) =>
        (await runtime.runQuery({ ...input, codec: exposedHttpCodec(runtime, input.address), respond })).status,
      mutation: async (input: Ctx) =>
        (await runtime.runMutation({ ...input, codec: exposedHttpCodec(runtime, input.address), respond })).status,
      procedure: async (input: Ctx) =>
        (await runtime.runProcedure({ ...input, codec: exposedHttpCodec(runtime, input.address), respond })).status,
      sse: async (input: Ctx) => {
        const response = await runtime.runSse({
          ...input,
          codec: exposedHttpCodec(runtime, input.address),
        });
        expect((await collectSse(response)).at(-1)?.t).toBe("sse_done");
        return 200;
      },
    };
    const calls = [
      { kind: "query", address: "api.messages.list", args: { channelId: 1n } },
      {
        kind: "mutation",
        address: "api.reminders.schedule",
        args: { message: "soon", attempt: 1, at: Date.now() + 100_000 },
      },
      { kind: "procedure", address: "api.ops.echo", args: { value: "hello" } },
      { kind: "sse", address: "api.ops.stream", args: { count: 0 } },
    ] as const;

    for (const [index, { kind, address, args }] of calls.entries()) {
      const bytes = Buffer.byteLength(encode({ ref: address, args }));
      const input = { address, args, principal: ANONYMOUS_PRINCIPAL };

      await restart(limits({ maxRequestBytes: bytes - 1 }));
      await expect(run[kind]({ ...input, id: 200 + index })).rejects.toMatchObject({
        code: "overloaded",
        message: "request exceeds maxRequestBytes",
      });

      await restart(limits({ maxRequestBytes: bytes }));
      expect(await run[kind]({ ...input, id: 300 + index })).toBe(200);
    }
  });
});

describe("jobs runner and lifecycle", () => {
  const jobRows = () =>
    engine.reader
      .query(`SELECT state, runCount FROM "${JOBS_TABLE}" ORDER BY id`)
      .all() as { state: string; runCount: number | bigint }[];

  test("runs a due mutation-mode Job exactly once in one commit", async () => {
    await session.open();
    const dueAt = Date.now() + 100_000;
    const attempt = Number.MAX_SAFE_INTEGER;
    await session.mutation(1, "api.reminders.schedule", { message: "ok", attempt, at: dueAt });
    expect(jobRows()).toMatchObject([{ state: "pending" }]);
    currentTime = dueAt;
    await runtime.runJobs();
    expect(scheduledAttempt).toBe(attempt);
    expect(scheduledAttempts).toBe(1);
    expect(engine.reader.query('SELECT line FROM "log"').all()).toEqual([{ line: "fired:ok" }]);
    expect(jobRows()).toMatchObject([{ state: "completed", runCount: 1n }]);
  });

  test("rolls handler writes back on failure and records the failed run", async () => {
    await session.open();
    const dueAt = Date.now() + 100_000;
    await session.mutation(1, "api.reminders.schedule", { message: "fail", attempt: 1, at: dueAt });
    currentTime = dueAt;
    await runtime.runJobs();
    // The handler's log insert rolled back whole; the failed run settled in the
    // same transaction and failed the Job (no retry policy declared).
    expect(engine.reader.query('SELECT COUNT(*) AS count FROM "log"').get()).toEqual({ count: 0n });
    expect(jobRows()).toMatchObject([{ state: "failed", runCount: 1n }]);
    expect(
      engine.reader.query(`SELECT number, state, errorText FROM "${JOB_RUNS_TABLE}"`).all(),
    ).toMatchObject([{ number: 1n, state: "failed", errorText: "Error: scheduled failure" }]);
  });

  test("arms the runner for a due job an HTTP mutation committed", async () => {
    // Arming belongs to the commit, not to the session that asked for it: a due
    // job enqueued over HTTP must fire without a WebSocket ever opening.
    const response = await runtime.runMutation({
      id: 96,
      address: "api.reminders.schedule",
      args: { message: "http", attempt: 1, at: Date.now() - 1 },
      codec: exposedHttpCodec(runtime, "api.reminders.schedule"),
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }: RuntimeHttpResponse) => new Response(body, { status }),
    });

    expect(response.status).toBe(200);
    await eventually(() => scheduledAttempts === 1);
    expect(engine.reader.query('SELECT line FROM "log"').all()).toEqual([{ line: "fired:http" }]);
  });

  test("a poisoned job cannot block other due work", async () => {
    await session.open();
    const dueAt = Date.now() + 100_000;
    await session.mutation(1, "api.reminders.schedule", { message: "fail", attempt: 1, at: dueAt - 10 });
    await session.mutation(2, "api.reminders.schedule", { message: "after", attempt: 2, at: dueAt });
    currentTime = dueAt;
    await runtime.runJobs();
    // The earlier-due failing job failed; the later job still ran.
    expect(scheduledAttempts).toBe(2);
    expect(engine.reader.query('SELECT line FROM "log"').all()).toEqual([{ line: "fired:after" }]);
    expect(jobRows()).toMatchObject([{ state: "failed" }, { state: "completed" }]);
  });

  test("job rows are live: a subscription over the jobs table updates on enqueue and settle", async () => {
    await session.open();
    await runtime.subscribe(session.context, request({
      t: "sub",
      id: 70,
      ref: "api.reminders.pending",
      args: {},
    }));
    const pendingRows = (): Ctx => {
      const last = [...session.publications].reverse().find(
        (message: Ctx) => message.id === 70 && message.transition !== undefined,
      ) as Ctx;
      return last?.transition?.value;
    };
    expect(pendingRows()).toEqual([]);

    const dueAt = Date.now() + 100_000;
    await session.mutation(1, "api.reminders.schedule", { message: "live", attempt: 1, at: dueAt });
    await eventually(() => pendingRows()?.length === 1);
    expect(pendingRows()[0]).toMatchObject({ name: "reminders.fire", state: "pending" });

    currentTime = dueAt;
    await runtime.runJobs();
    // Settling flips the row out of pending; the live query converges to empty.
    await eventually(() => pendingRows()?.length === 0);
  });

  test("bounds one runner batch at jobs.claimBatchSize", async () => {
    await restart(limits({ jobs: { maxRunning: 64, claimBatchSize: 3, leaseMs: 60_000 } }));
    await session.open();
    const dueAt = Date.now() + 100_000;
    for (let index = 0; index < 5; index++) {
      await session.mutation(1 + index, "api.reminders.schedule", {
        message: `batch-${index}`,
        attempt: index,
        at: dueAt + index,
      });
    }
    currentTime = dueAt + 10_000;
    await runtime.runJobs();
    expect(scheduledAttempts).toBe(3);
    await runtime.runJobs();
    expect(scheduledAttempts).toBe(5);
  });

  test("fails an open SSE immediately and completes Runtime drain", async () => {
    const response = await runtime.runSse({
      id: 85,
      address: "api.ops.waitForAbort",
      args: {},
      codec: exposedHttpCodec(runtime, "api.ops.waitForAbort"),
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
        address: "api.ops.holdSse",
        args: {},
        codec: exposedHttpCodec(runtime, "api.ops.holdSse"),
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
      v: ACKERDB_VERSION,
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
      v: ACKERDB_VERSION,
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
      t: "sub",
      id: 85,
      ref: "api.messages.parallelList",
      args: { channelId: 1n },
    }));
    await revalidationEntered.promise;

    const closing = session.close();
    expect(runtime.status()).toMatchObject({
      connections: 1,
      activeOperations: 1,
    });
    await expect(runtime.query(session.context, request({
      t: "q",
      id: 86,
      ref: "api.messages.list",
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
      t: "sub",
      id: 86,
      ref: "api.messages.parallelList",
      args: { channelId: 1n },
    }));
    revalidationGate = deferred<void>();
    revalidationEntered = deferred<void>();
    const mutation = session.mutation(87, "api.messages.send", { channelId: 1n, body: "blocked" });
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
      t: "q",
      id: 88,
      ref: "api.messages.list",
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


  test("stops admission, waits for accepted work, and becomes stopped", async () => {
    await session.open();
    queryGate = deferred<void>();
    const accepted = runtime.query(session.context, request({
      t: "q",
      id: 1,
      ref: "api.messages.block",
      args: {},
    }));
    await Promise.resolve();
    const drain = runtime.drain();
    expect(runtime.status().state).toBe("draining");
    await expect(runtime.query(session.context, request({
      t: "q",
      id: 2,
      ref: "api.messages.block",
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
    directory = mkdtempSync(join(tmpdir(), "ackerdb-runtime-capacity-"));
    await start(limits({ maxConnections: 1, maxFrameBytes: 256 }));
  });

  test("reports the selected durability", () => {
    expect(runtime.status()).toMatchObject({
      state: "ready",
      connections: 0,
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
        t: "q",
        id,
        ref: "api.messages.block",
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
      t: "q",
      id: 70,
      ref: "api.messages.block",
      args: {},
    }));
    await eventually(() => runtime.status().activeOperations === 1);
    const rejectedControl = runtime.subscribe(session.context, request({
      t: "sub",
      id: 71,
      ref: "api.messages.list",
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
      const mutation = session.mutation(72, "api.messages.send", {
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
        t: "sub",
        id,
        ref: "api.messages.list",
        args: { channelId },
      }));
    const unsubscribe = (owner: SessionHarness, id: number) =>
      runtime.unsubscribe(owner.context, request({
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

  test("applies one subscription budget to reactive listeners and channels", async () => {
    await restart(limits({
      maxConnections: 2,
      maxSubscriptionsPerConnection: 2,
      maxSubscriptions: 2,
    }));
    const second = new SessionHarness(runtime, "session-b");
    await Promise.all([session.open(), second.open()]);

    await runtime.joinChannel(session.context, request({
      t: "channel_join",
      id: 1,
      ref: "api.chat.room",
      args: { threadId: 7n },
      room: "support",
    }));
    await runtime.subscribe(session.context, request({
      t: "sub",
      id: 2,
      ref: "api.messages.list",
      args: { channelId: 7n },
    }));

    await expect(runtime.joinChannel(session.context, request({
      t: "channel_join",
      id: 3,
      ref: "api.chat.room",
      args: { threadId: 8n },
      room: "sales",
    }))).rejects.toMatchObject({
      code: "overloaded",
      message: "Per-connection subscription capacity is full",
      resource: "subscription",
    });
    await expect(runtime.subscribe(second.context, request({
      t: "sub",
      id: 1,
      ref: "api.messages.list",
      args: { channelId: 8n },
    }))).rejects.toMatchObject({
      code: "overloaded",
      message: "Global subscription capacity is full",
      resource: "subscription",
    });

    await runtime.leaveChannel(session.context, request({
      t: "channel_leave",
      id: 1,
    }));
    await expect(runtime.subscribe(second.context, request({
      t: "sub",
      id: 1,
      ref: "api.messages.list",
      args: { channelId: 8n },
    }))).resolves.toBeUndefined();
  });

  test("rejects an oversized mutation response before its write commits", async () => {
    await session.open();
    await expect(session.mutation(1, "api.messages.largeResult", {
      channelId: 9n,
      size: 512,
    })).rejects.toMatchObject({ code: "overloaded", resource: "operation" });
    expect(engine.commitVersion()).toBe(0n);
    const rows = await runtime.query(session.context, request({
      t: "q",
      id: 2,
      ref: "api.messages.list",
      args: { channelId: 9n },
    }));
    expect(rows).toEqual([]);
  });

  test("publishes an error instead of an oversized query success frame", async () => {
    await session.open();
    await expect(runtime.query(session.context, request({
      t: "q",
      id: 3,
      ref: "api.messages.largeQuery",
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
    directory = mkdtempSync(join(tmpdir(), "ackerdb-runtime-auth-capture-"));
    await start(limits({
      maxFrameBytes: 1_024,
      webSocket: {
        ...PRODUCTION_LIMITS.webSocket,
        maxBytesPerConnection: 1_025,
      },
    }));
    await session.open(user("alice"));
    await runtime.subscribe(session.context, request({
      t: "sub",
      id: 50,
      ref: "api.messages.secure",
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
      t: "sub",
      id: 51,
      ref: "api.messages.secure",
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
        t: "sub",
        id: 51,
        ref: "api.messages.secure",
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
