import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  decode,
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
import { Runtime } from "../src/runtime.ts";
import { defineEventTable, defineSchema, defineTable } from "../src/schema.ts";
import type { RuntimePublication, SessionRuntimeContext } from "../src/session.ts";

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
    const from = this.context;
    this.controller.abort();
    const nextController = new AbortController();
    const to = this.makeContext(principal, from.authEpoch + 1, nextController);
    const frames = await this.runtime.transitionAuth({
      attemptId: from.authEpoch + 1,
      reason: principal.kind === "anonymous" ? "sign-out" : "refresh",
      from,
      to,
    });
    this.controller = nextController;
    this.context = to;
    return frames;
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

let directory: string;
let engine: Engine;
let runtime: Runtime;
let session: SessionHarness;

function start(customLimits = limits()): void {
  engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  runtime = new Runtime({
    engine,
    registry: new Registry(functions),
    limits: customLimits,
    telemetry: false,
  });
  session = new SessionHarness(runtime, "session-a");
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dbzz-runtime-"));
  queryGate = null;
  revalidationGate = null;
  revalidationEntered = null;
  scheduledAttempts = 0;
  eventAccessInputs.length = 0;
  eventMatchInputs.length = 0;
  start();
});

afterEach(async () => {
  await runtime.drain();
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
    const value = await runtime.runProcedure({
      id: 1,
      address: "ops.pipeline",
      args: { channelId: 4n },
      principal: ANONYMOUS_PRINCIPAL,
    });
    expect(value).toEqual({ external: "external", body: "external" });
    await expect(runtime.runProcedure({
      id: 2,
      address: "ops.nestedTx",
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
    })).rejects.toMatchObject({ code: "validation" });
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
    await expect(duplicate.open()).rejects.toMatchObject({ code: "conflict", resource: "connection" });
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
    });
  });
});
