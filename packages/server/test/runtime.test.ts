import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  type MutationMessage,
} from "@dbzz/core";
import {
  ANONYMOUS_PRINCIPAL,
  type Principal,
  type UserPrincipal,
} from "../src/auth.ts";
import { dbz } from "../src/dbz.ts";
import { Engine } from "../src/engine.ts";
import { mutation, procedure, query, sseProcedure } from "../src/functions.ts";
import { PRODUCTION_LIMITS, type ServiceLimits } from "../src/limits.ts";
import { reconcile } from "../src/reconcile.ts";
import { Registry } from "../src/registry.ts";
import { Runtime, type RuntimeOptions } from "../src/runtime.ts";
import { defineEventTable, defineSchema, defineTable } from "../src/schema.ts";
import type {
  RuntimePublication,
  RuntimePublicationBatch,
  SessionRuntimeContext,
} from "../src/session.ts";
import { Telemetry } from "../src/telemetry.ts";

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

function uuidV7(now = Date.now(), sequence = 0): string {
  const timestamp = now.toString(16).padStart(12, "0");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

function user(subject: string): UserPrincipal {
  return Object.freeze({
    kind: "user",
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
    id: dbz.primaryKey(),
    channelId: dbz.bigint(),
    body: dbz.string(),
  }).index("by_channel", ["channelId"]),
  log: defineTable({
    id: dbz.primaryKey(),
    line: dbz.string(),
  }),
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
    id: dbz.primaryKey(),
    message: dbz.string(),
    at: dbz.scheduleAt(),
  }).scheduled("reminders.fire"),
});

// Tests exercise runtime ownership, not generated application types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

let queryGate: Deferred<void> | null = null;
let revalidationGate: Deferred<void> | null = null;
let revalidationEntered: Deferred<void> | null = null;
let externalProcedureStarted: Deferred<void> | null = null;
let externalProcedureRelease: Deferred<void> | null = null;
let scheduledAttempts = 0;

const functions = {
  messages: {
    list: query({
      access: "public",
      args: { channelId: dbz.bigint() },
      handler: (ctx: Ctx, args: Ctx) =>
        ctx.db.messages.byChannel((builder: Ctx) => builder.eq("channelId", args.channelId)).collect(),
    }),
    parallelList: query({
      access: "public",
      args: { channelId: dbz.bigint() },
      handler: async (ctx: Ctx, args: Ctx) => {
        const rows = await ctx.db.messages
          .byChannel((builder: Ctx) => builder.eq("channelId", args.channelId))
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
    send: mutation({
      access: "public",
      args: { channelId: dbz.bigint(), body: dbz.string() },
      handler: async (ctx: Ctx, args: Ctx) => {
        const id = await ctx.db.messages.insert(args);
        await ctx.db.typing.insert({ channelId: args.channelId });
        await ctx.db.privateTyping.insert({ channelId: args.channelId });
        return id;
      },
    }),
    rewrite: mutation({
      access: "public",
      args: { id: dbz.bigint() },
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
      args: { channelId: dbz.bigint() },
      handler: async (ctx: Ctx, args: Ctx) => {
        await functions.messages.send(ctx, { channelId: args.channelId, body: "rollback" });
        throw new Error("compose failed");
      },
    }),
    largeResult: mutation({
      access: "public",
      args: { channelId: dbz.bigint(), size: dbz.number() },
      handler: async (ctx: Ctx, args: Ctx) => {
        await ctx.db.messages.insert({ channelId: args.channelId, body: "must-roll-back" });
        return "x".repeat(args.size);
      },
    }),
  },
  reminders: {
    fire: mutation({
      access: "system",
      args: { id: dbz.bigint(), message: dbz.string(), at: dbz.number() },
      handler: async (ctx: Ctx, args: Ctx) => {
        scheduledAttempts++;
        await ctx.db.log.insert({ line: `fired:${args.message}` });
        if (args.message === "fail") throw new Error("scheduled failure");
      },
    }),
    schedule: mutation({
      access: "public",
      args: { message: dbz.string(), at: dbz.number() },
      handler: (ctx: Ctx, args: Ctx) => ctx.db.reminders.insert(args),
    }),
  },
  ops: {
    echo: procedure({
      access: "public",
      args: { value: dbz.string() },
      handler: (_ctx: Ctx, args: Ctx) => args.value,
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
      args: { channelId: dbz.bigint() },
      handler: async (ctx: Ctx, args: Ctx) => {
        const external = await (await fetch("data:text/plain,external")).text();
        const body = await ctx.tx(async (tx: Ctx) => {
          const id = await functions.messages.send(tx, { channelId: args.channelId, body: external });
          return (await tx.db.messages.get(id)).body;
        });
        return { external, body };
      },
    }),
    nestedTx: procedure({
      access: "public",
      args: {},
      handler: (ctx: Ctx) => ctx.tx(() => ctx.tx(() => 1)),
    }),
    stream: sseProcedure({
      access: "public",
      args: { count: dbz.number() },
      handler: async (ctx: Ctx, args: Ctx) => {
        for (let index = 0; index < args.count; index++) {
          ctx.stream.write({ type: "delta", value: index });
        }
        ctx.stream.merge(new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "merged" });
            controller.close();
          },
        }));
        await ctx.tx((tx: Ctx) => tx.db.log.insert({ line: "streamed" }));
      },
    }),
    failingStream: sseProcedure({
      access: "public",
      args: {},
      handler: () => {
        throw new Error("stream failed");
      },
    }),
    waitForAbort: sseProcedure({
      access: "public",
      args: {},
      handler: async (ctx: Ctx) => {
        ctx.stream.write({ phase: "started" });
        if (ctx.abortSignal.aborted) return;
        await new Promise<void>((resolve) => {
          ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    }),
  },
};

class SessionHarness {
  readonly publications: RuntimePublication[] = [];
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

  async rotate(principal: Principal): Promise<readonly RuntimePublication[]> {
    const batch = await this.rotateBatch(principal);
    try {
      return Object.freeze([...batch.frames]);
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
    return this.runtime.mutation(this.context, message);
  }

  private makeContext(
    principal: Principal,
    authEpoch: number,
    controller: AbortController,
  ): SessionRuntimeContext {
    return Object.freeze({
      clientSessionId: this.clientSessionId,
      principal,
      authEpoch,
      signal: controller.signal,
      publish: async (message: RuntimePublication) => {
        if (controller.signal.aborted || this.context?.authEpoch !== authEpoch) return false;
        this.publications.push(message);
        return true;
      },
    });
  }
}

function limits(overrides: Partial<ServiceLimits> = {}): ServiceLimits {
  return { ...PRODUCTION_LIMITS, ...overrides };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for await (const bytes of stream as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(decoder.decode(bytes));
  }
  return chunks;
}

function publicationBytes(frames: readonly RuntimePublication[]): number {
  const encoder = new TextEncoder();
  return frames.reduce((total, frame) => total + encoder.encode(encode(frame)).byteLength, 0);
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
  engine.close();
  rmSync(directory, { recursive: true, force: true });
  directory = mkdtempSync(join(tmpdir(), "dbzz-runtime-restart-"));
  start(customLimits, telemetry);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dbzz-runtime-"));
  queryGate = null;
  revalidationGate = null;
  revalidationEntered = null;
  externalProcedureStarted = null;
  externalProcedureRelease = null;
  scheduledAttempts = 0;
  eventAccessInputs.length = 0;
  eventMatchInputs.length = 0;
  start();
});

afterEach(async () => {
  await runtime.drain().catch(() => {});
  engine.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("runtime commit and replay ownership", () => {
  test("validates queries and keeps failed transaction writes invisible", async () => {
    await session.open();
    const first = await session.mutation(1, "messages.send", { channelId: 1n, body: "hello" });
    expect(first.value).toBe(1n);
    expect(first.receipt).toMatchObject({ replay: "executed", durability: "production" });

    await expect(runtime.query(session.context, {
      v: PROTOCOL_VERSION,
      t: "q",
      id: 2,
      ref: "messages.list",
      args: { channelId: 1 },
    })).rejects.toMatchObject({ code: "validation" });
    await expect(session.mutation(3, "messages.fetchInside", {})).rejects.toThrow("fetch is not allowed");
    await expect(session.mutation(4, "messages.composeFail", { channelId: 2n })).rejects.toThrow("compose failed");

    const rolledBack = await runtime.query(session.context, {
      v: PROTOCOL_VERSION,
      t: "q",
      id: 5,
      ref: "messages.list",
      args: { channelId: 2n },
    }) as unknown[];
    expect(rolledBack).toEqual([]);
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
      "UPDATE _dbz_mutations SET durability = 'balanced' WHERE session_id = ? AND request_id = ?",
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

    const rows = await runtime.query(session.context, {
      v: PROTOCOL_VERSION,
      t: "q",
      id: 4,
      ref: "messages.list",
      args: { channelId: 5n },
    }) as unknown[];
    expect(rows).toHaveLength(1);
  });
});

describe("ordered convergence", () => {
  test("publishes initial reset and advances caller obligations before mutation resolution", async () => {
    await session.open();
    await runtime.subscribe(session.context, {
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 10,
      ref: "messages.list",
      args: { channelId: 1n },
    });
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
    await runtime.subscribe(session.context, {
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 60,
      ref: "messages.parallelList",
      args: { channelId: 1n },
    });
    await runtime.subscribe(secondSession.context, {
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 61,
      ref: "messages.parallelList",
      args: { channelId: 2n },
    });

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
    await runtime.subscribe(session.context, {
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 20,
      ref: "events.typing",
      args: { channelId: 7n },
    });
    await runtime.subscribe(session.context, {
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 21,
      ref: "events.typing",
      args: { channelId: 8n },
    });
    await session.mutation(1, "messages.send", { channelId: 7n, body: "typing" });
    expect(session.publications.filter(
      (frame) => frame.t === "event" && frame.event.kind === "row",
    )).toMatchObject([
      { t: "event", id: 20, event: { row: { id: 1n, channelId: 7n } } },
    ]);
  });

  test("authorizes and freezes event subscriptions across refresh and terminal sign-out", async () => {
    await session.open(user("alice"));
    await expect(runtime.subscribe(session.context, {
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 22,
      ref: "events.privateTyping",
      args: { channelId: "wrong" },
    })).rejects.toMatchObject({ code: "validation" });

    await runtime.subscribe(session.context, {
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 23,
      ref: "events.privateTyping",
      args: { channelId: 9n },
    });
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
    await expect(runtime.subscribe(session.context, {
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 24,
      ref: "events.privateTyping",
      args: { channelId: 1n },
    })).rejects.toMatchObject({ code: "unauthenticated" });
    expect(runtime.status().reactive.eventListeners).toBe(0);
  });

  test("auth rotation revokes then re-evaluates saved subscriptions under the new identity", async () => {
    await session.open(user("alice"));
    await runtime.subscribe(session.context, {
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 30,
      ref: "messages.secure",
      args: {},
    });
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
});

describe("procedures and bounded SSE", () => {
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

  test("streams data, merged data, and a terminal marker", async () => {
    const stream = await runtime.runSse({
      id: 1,
      address: "ops.stream",
      args: { count: 2 },
      principal: ANONYMOUS_PRINCIPAL,
    });
    const chunks = await collect(stream);
    expect(chunks.slice(0, 2).map((chunk) => decode(chunk.slice(6).trim()))).toEqual([
      { type: "delta", value: 0 },
      { type: "delta", value: 1 },
    ]);
    expect(chunks.some((chunk) => chunk.includes('"type":"merged"'))).toBe(true);
    expect(chunks.at(-1)).toBe("data: [DONE]\n\n");
    expect(runtime.status().sseBudget.bytes).toBe(0);
  });

  test("turns a post-start SSE failure into a terminal dbzz-error event", async () => {
    const stream = await runtime.runSse({
      id: 1,
      address: "ops.failingStream",
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
    });
    const chunks = await collect(stream);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toStartWith("event: dbzz-error\ndata: ");
    expect(decode(chunks[0]!.split("data: ")[1]!.trim())).toMatchObject({ code: "internal" });
  });
});

describe("direct ingress", () => {
  test("rejects oversized direct calls before operation or writer admission", async () => {
    await restart(limits({ maxRequestBytes: 256 }));
    await session.open();
    const oversized = "x".repeat(512);
    const expected = {
      code: "overloaded",
      resource: "operation",
      message: "request exceeds maxRequestBytes",
    };

    await expect(runtime.subscribe(session.context, {
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 80,
      ref: oversized,
      args: {},
    })).rejects.toMatchObject(expected);
    await expect(runtime.query(session.context, {
      v: PROTOCOL_VERSION,
      t: "q",
      id: 81,
      ref: oversized,
      args: {},
    })).rejects.toMatchObject(expected);
    await expect(session.mutation(82, "messages.send", {
      channelId: 1n,
      body: oversized,
    })).rejects.toMatchObject(expected);
    await expect(runtime.runProcedure({
      id: 83,
      address: oversized,
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }) => new Response(body, { status }),
    })).rejects.toMatchObject(expected);
    await expect(runtime.runSse({
      id: 84,
      address: oversized,
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
    })).rejects.toMatchObject(expected);

    expect(runtime.status()).toMatchObject({
      activeOperations: 0,
      writer: { active: 0, admitted: 0, queue: { queuedItems: 0 } },
      reactive: { queryListeners: 0, eventListeners: 0 },
    });
    expect(engine.commitVersion()).toBe(0n);
  });
});

describe("scheduler and lifecycle", () => {
  test("runs the handler and deletes the due row in one commit", async () => {
    await session.open();
    const dueAt = Date.now() + 100_000;
    await session.mutation(1, "reminders.schedule", { message: "ok", at: dueAt });
    expect(await runtime.runScheduled(dueAt)).toBe(1);
    expect(engine.reader.query('SELECT line FROM "log"').all()).toEqual([{ line: "fired:ok" }]);
    expect(engine.reader.query('SELECT COUNT(*) AS count FROM "reminders"').get()).toEqual({ count: 0n });
  });

  test("rolls handler writes and deletion back together on failure", async () => {
    await session.open();
    const dueAt = Date.now() + 100_000;
    await session.mutation(1, "reminders.schedule", { message: "fail", at: dueAt });
    await expect(runtime.runScheduled(dueAt)).rejects.toThrow("scheduled failure");
    expect(engine.reader.query('SELECT COUNT(*) AS count FROM "log"').get()).toEqual({ count: 0n });
    expect(engine.reader.query('SELECT COUNT(*) AS count FROM "reminders"').get()).toEqual({ count: 1n });
  });

  test("backs a failing due job off instead of retrying in a hot loop", async () => {
    await session.open();
    await session.mutation(1, "reminders.schedule", { message: "fail", at: Date.now() - 1 });
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
    const stream = await runtime.runSse({
      id: 85,
      address: "ops.waitForAbort",
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
    });

    const [chunks] = await Promise.all([collect(stream), runtime.drain()]);
    expect(chunks[0]).toContain('"phase":"started"');
    expect(chunks.some((chunk) => chunk.includes("event: dbzz-error"))).toBe(true);
    expect(runtime.status()).toMatchObject({ state: "stopped", activeSse: 0, activeOperations: 0 });
  });

  test("owns a finite deadline across stalled active reader and publication work", async () => {
    await restart(limits({ gracefulShutdownMs: 500 }));
    await session.open();
    await runtime.subscribe(session.context, {
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 86,
      ref: "messages.parallelList",
      args: { channelId: 1n },
    });
    revalidationGate = deferred<void>();
    revalidationEntered = deferred<void>();
    const mutation = session.mutation(87, "messages.send", { channelId: 1n, body: "blocked" });
    await revalidationEntered.promise;

    const startedAt = performance.now();
    const drain = runtime.drain(Date.now() + 20);
    expect(runtime.status()).toMatchObject({
      state: "draining",
      connections: 0,
      reader: { queue: { closed: true } },
      writer: { queue: { closed: true } },
      publication: { closed: true },
      reactive: { queryListeners: 0, eventListeners: 0 },
    });
    await expect(runtime.query(session.context, {
      v: PROTOCOL_VERSION,
      t: "q",
      id: 88,
      ref: "messages.list",
      args: { channelId: 1n },
    })).rejects.toMatchObject({
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
    const accepted = runtime.query(session.context, {
      v: PROTOCOL_VERSION,
      t: "q",
      id: 1,
      ref: "messages.block",
      args: {},
    });
    await Promise.resolve();
    const drain = runtime.drain();
    expect(runtime.status().state).toBe("draining");
    await expect(runtime.query(session.context, {
      v: PROTOCOL_VERSION,
      t: "q",
      id: 2,
      ref: "messages.block",
      args: {},
    })).rejects.toMatchObject({ code: "draining" });
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
    engine.close();
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

  test("rejects an oversized mutation response before its write commits", async () => {
    await session.open();
    await expect(session.mutation(1, "messages.largeResult", {
      channelId: 9n,
      size: 512,
    })).rejects.toMatchObject({ code: "overloaded", resource: "operation" });
    expect(engine.commitVersion()).toBe(0n);
    const rows = await runtime.query(session.context, {
      v: PROTOCOL_VERSION,
      t: "q",
      id: 2,
      ref: "messages.list",
      args: { channelId: 9n },
    });
    expect(rows).toEqual([]);
  });

  test("removes runtime ownership when an auth transition cannot fit its capture", async () => {
    await runtime.drain();
    engine.close();
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
    await runtime.subscribe(session.context, {
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 50,
      ref: "messages.secure",
      args: {},
    });

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
    await runtime.subscribe(session.context, {
      v: PROTOCOL_VERSION,
      t: "sub",
      id: 51,
      ref: "messages.secure",
      args: {},
    });
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
      await runtime.subscribe(owner.context, {
        v: PROTOCOL_VERSION,
        t: "sub",
        id: 51,
        ref: "messages.secure",
        args: {},
      });
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
