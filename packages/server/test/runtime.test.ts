import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@dbzz/core";
import {
  dbz,
  defineEventTable,
  defineSchema,
  defineTable,
  Engine,
  mutation,
  procedure,
  query,
  reconcile,
  Registry,
  Runtime,
  sseProcedure,
  ValidationError,
  type Subscriber,
} from "@dbzz/server";

class TestSub implements Subscriber {
  updates: { id: number; value: unknown }[] = [];
  events: { id: number; row: unknown }[] = [];
  errors: { id: number; message: string }[] = [];
  sendUpdate(id: number, encoded: string): void {
    this.updates.push({ id, value: decode(encoded) });
  }
  sendEvent(id: number, encoded: string): void {
    this.events.push({ id, row: decode(encoded) });
  }
  sendError(id: number, message: string): void {
    this.errors.push({ id, message });
  }
}

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
  }),
  reminders: defineTable({
    id: dbz.primaryKey(),
    message: dbz.string(),
    at: dbz.scheduleAt(),
  }).scheduled("reminders.fire"),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const functions = {
  messages: {
    list: query({
      args: { channelId: dbz.bigint() },
      handler: (ctx: Ctx, args: Ctx) =>
        ctx.db.messages.byChannel((q: Ctx) => q.eq("channelId", args.channelId)).collect(),
    }),
    send: mutation({
      args: { channelId: dbz.bigint(), body: dbz.string() },
      handler: async (ctx: Ctx, args: Ctx) => {
        const id = await ctx.db.messages.insert(args);
        await ctx.db.typing.insert({ channelId: args.channelId });
        return id;
      },
    }),
    fetchInside: mutation({
      args: {},
      handler: async (ctx: Ctx) => {
        await ctx.db.messages.insert({ channelId: 1n, body: "should roll back" });
        await fetch("data:text/plain,nope");
      },
    }),
    rewrite: mutation({
      args: { id: dbz.bigint() },
      handler: async (ctx: Ctx, args: Ctx) => {
        const row = await ctx.db.messages.get(args.id);
        await ctx.db.messages.patch(args.id, { body: row.body }); // same value
      },
    }),
  },
  reminders: {
    fire: mutation({
      args: { id: dbz.bigint(), message: dbz.string(), at: dbz.number() },
      handler: async (ctx: Ctx, args: Ctx) => {
        await ctx.db.log.insert({ line: `fired:${args.message}` });
      },
    }),
    schedule: mutation({
      args: { message: dbz.string(), at: dbz.number() },
      handler: (ctx: Ctx, args: Ctx) => ctx.db.reminders.insert(args),
    }),
  },
  ops: {
    pipeline: procedure({
      args: { channelId: dbz.bigint() },
      handler: async (ctx: Ctx, args: Ctx) => {
        const before = await ctx.runQuery({ $ref: "messages.list" }, { channelId: args.channelId });
        const fetched = await (await fetch("data:text/plain,external")).text();
        const id = await ctx.runMutation({ $ref: "messages.send" }, { channelId: args.channelId, body: fetched });
        const after = await ctx.tx((tx: Ctx) => tx.db.messages.get(id));
        return { before: before.length, fetched, after: after.body };
      },
    }),
    fetchInTx: procedure({
      args: {},
      handler: (ctx: Ctx) => ctx.tx(() => fetch("data:text/plain,banned")),
    }),
    nestedTx: procedure({
      args: {},
      handler: (ctx: Ctx) => ctx.tx(() => ctx.tx(() => 1)),
    }),
    stream: sseProcedure({
      args: { n: dbz.number() },
      handler: async (ctx: Ctx, args: Ctx) => {
        for (let i = 0; i < args.n; i++) ctx.stream.write({ type: "text-delta", delta: `c${i}` });
        ctx.stream.merge(
          new ReadableStream({
            start(c) {
              c.enqueue({ type: "data-custom", data: { fromMerge: true } });
              c.close();
            },
          }),
        );
        await ctx.tx((tx: Ctx) => tx.db.log.insert({ line: "streamed" }));
      },
    }),
    failingStream: sseProcedure({
      args: {},
      handler: () => {
        throw new Error("boom mid-stream");
      },
    }),
  },
};

let dir: string;
let engine: Engine;
let runtime: Runtime;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dbzz-rt-"));
  engine = new Engine(schema, join(dir, "data.db"));
  reconcile(engine);
  runtime = new Runtime({ engine, registry: new Registry(functions) });
});
afterEach(() => {
  runtime.stop();
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("queries and mutations", () => {
  test("one-shot query, mutation return values, arg validation", async () => {
    const id = await runtime.runMutation("messages.send", { channelId: 1n, body: "hi" });
    expect(id).toBe(1n);
    const rows = (await runtime.runQuery("messages.list", { channelId: 1n })) as unknown[];
    expect(rows).toHaveLength(1);
    await expect(runtime.runQuery("messages.list", { channelId: 1 })).rejects.toThrow(ValidationError);
    await expect(runtime.runQuery("nope.nope", {})).rejects.toThrow('unknown function');
    await expect(runtime.runQuery("messages.send", { channelId: 1n })).rejects.toThrow(
      "is a mutation, expected a query",
    );
  });

  test("mutations are exactly-once per idempotency key", async () => {
    const a = await runtime.runMutation("messages.send", { channelId: 5n, body: "once" }, "mid-1");
    const b = await runtime.runMutation("messages.send", { channelId: 5n, body: "once" }, "mid-1");
    expect(b).toBe(a);
    const rows = (await runtime.runQuery("messages.list", { channelId: 5n })) as unknown[];
    expect(rows).toHaveLength(1);
  });

  test("fetch inside a mutation throws and rolls the write back", async () => {
    await expect(runtime.runMutation("messages.fetchInside", {})).rejects.toThrow(
      "not allowed inside a transaction",
    );
    const rows = (await runtime.runQuery("messages.list", { channelId: 1n })) as unknown[];
    expect(rows).toHaveLength(0);
  });
});

describe("subscriptions", () => {
  test("update on relevant writes only, deduped per (query, args)", async () => {
    const alice = new TestSub();
    const bob = new TestSub();
    await runtime.subscribe("messages.list", { channelId: 1n }, alice, 10);
    await runtime.subscribe("messages.list", { channelId: 1n }, bob, 20);
    await runtime.subscribe("messages.list", { channelId: 2n }, bob, 21);
    expect(runtime.subs.size).toBe(2); // channel 1 shared, channel 2 separate

    expect(alice.updates).toEqual([{ id: 10, value: [] }]);
    expect(bob.updates.map((u) => u.id).sort()).toEqual([20, 21]);

    await runtime.runMutation("messages.send", { channelId: 1n, body: "one" });
    expect(alice.updates).toHaveLength(2);
    expect((alice.updates[1]!.value as unknown[]).length).toBe(1);
    expect(bob.updates.filter((u) => u.id === 20)).toHaveLength(2);
    // channel 2 subscription untouched: a write to channel 1 is invisible to it
    expect(bob.updates.filter((u) => u.id === 21)).toHaveLength(1);
  });

  test("identical recompute results are not re-shipped", async () => {
    const sub = new TestSub();
    const id = (await runtime.runMutation("messages.send", { channelId: 3n, body: "same" })) as bigint;
    await runtime.subscribe("messages.list", { channelId: 3n }, sub, 1);
    expect(sub.updates).toHaveLength(1);
    await runtime.runMutation("messages.rewrite", { id });
    expect(sub.updates).toHaveLength(1); // write happened, result identical -> no frame
  });

  test("unsubscribe and disconnect stop deliveries and drop entries", async () => {
    const sub = new TestSub();
    await runtime.subscribe("messages.list", { channelId: 1n }, sub, 1);
    runtime.unsubscribe(sub, 1);
    expect(runtime.subs.size).toBe(0);
    await runtime.runMutation("messages.send", { channelId: 1n, body: "x" });
    expect(sub.updates).toHaveLength(1); // only the initial one
  });

  test("event tables broadcast inserted rows with per-process ids", async () => {
    const sub = new TestSub();
    await runtime.subscribe("events.typing", {}, sub, 7);
    await runtime.runMutation("messages.send", { channelId: 9n, body: "typing!" });
    expect(sub.events).toEqual([{ id: 7, row: { id: 1n, channelId: 9n } }]);
    await expect(runtime.subscribe("events.messages", {}, sub, 8)).rejects.toThrow(
      'unknown event table',
    );
  });
});

describe("procedures", () => {
  test("pipeline: runQuery + fetch + runMutation + tx compose", async () => {
    const out = (await runtime.runProcedure("ops.pipeline", { channelId: 4n })) as Record<string, unknown>;
    expect(out).toEqual({ before: 0, fetched: "external", after: "external" });
  });

  test("fetch inside ctx.tx is banned; nested tx is a clear error", async () => {
    await expect(runtime.runProcedure("ops.fetchInTx", {})).rejects.toThrow(
      "not allowed inside a transaction",
    );
    await expect(runtime.runProcedure("ops.nestedTx", {})).rejects.toThrow(
      "cannot open a transaction inside a transaction",
    );
  });
});

describe("sse", () => {
  const collect = async (stream: ReadableStream<string>) => {
    const chunks: string[] = [];
    for await (const chunk of stream as unknown as AsyncIterable<string>) chunks.push(chunk);
    return chunks;
  };

  test("streams handler chunks, merged streams, then [DONE]", async () => {
    const stream = runtime.runSse("ops.stream", { n: 2 }, new AbortController().signal);
    const chunks = await collect(stream);
    expect(chunks[0]).toBe('data: {"type":"text-delta","delta":"c0"}\n\n');
    expect(chunks[1]).toBe('data: {"type":"text-delta","delta":"c1"}\n\n');
    expect(chunks).toContain('data: {"type":"data-custom","data":{"fromMerge":true}}\n\n');
    expect(chunks[chunks.length - 1]).toBe("data: [DONE]\n\n");
    const log = await runtime.runQuery("messages.list", { channelId: 1n }); // sanity: runtime alive
    expect(log).toEqual([]);
  });

  test("handler errors surface as an error chunk, stream closes", async () => {
    const stream = runtime.runSse("ops.failingStream", {}, new AbortController().signal);
    const chunks = await collect(stream);
    expect(chunks).toEqual(['data: {"type":"error","errorText":"boom mid-stream"}\n\n']);
  });
});

describe("scheduler", () => {
  test("due rows fire their handler once and are deleted", async () => {
    await runtime.runMutation("reminders.schedule", { message: "ping", at: Date.now() + 40 });
    const before = await runtime.runQuery("messages.list", { channelId: 1n });
    expect(before).toEqual([]);
    await Bun.sleep(120);
    const log = engine.reader.query(`SELECT line FROM "log"`).all() as { line: string }[];
    expect(log).toEqual([{ line: "fired:ping" }]);
    const left = engine.reader.query(`SELECT COUNT(*) AS n FROM "reminders"`).get() as { n: bigint };
    expect(left.n).toBe(0n);
  });

  test("deleting a scheduled row cancels it", async () => {
    await runtime.runMutation("reminders.schedule", { message: "cancel-me", at: Date.now() + 60 });
    // cancel through a direct transaction (same path a mutation would take)
    const row = engine.writer.query(`SELECT id FROM "reminders"`).get() as { id: bigint };
    await runtime.runMutation("reminders.schedule", { message: "other", at: Date.now() + 500_000 });
    engine.writer.query(`DELETE FROM "reminders" WHERE id = ?`).run(row.id);
    runtime.armScheduler();
    await Bun.sleep(140);
    const log = engine.reader.query(`SELECT line FROM "log"`).all() as { line: string }[];
    expect(log).toEqual([]);
  });
});
