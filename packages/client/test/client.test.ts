import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anyApi } from "@dbzz/core";
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
  serve,
  sseProcedure,
} from "@dbzz/server";
import { DbzzClient } from "@dbzz/client";

const schema = defineSchema({
  todos: defineTable({
    id: dbz.primaryKey(),
    list: dbz.bigint(),
    text: dbz.string(),
    done: dbz.boolean(),
  }).index("by_list", ["list"]),
  cursors: defineEventTable({ id: dbz.primaryKey(), x: dbz.number(), y: dbz.number() }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const functions = {
  todos: {
    list: query({
      args: { list: dbz.bigint() },
      handler: (ctx: Ctx, args: Ctx) =>
        ctx.db.todos.byList((q: Ctx) => q.eq("list", args.list)).collect(),
    }),
    add: mutation({
      args: { list: dbz.bigint(), text: dbz.string() },
      handler: (ctx: Ctx, args: Ctx) => ctx.db.todos.insert({ ...args, done: false }),
    }),
    moveCursor: mutation({
      args: { x: dbz.number(), y: dbz.number() },
      handler: (ctx: Ctx, args: Ctx) => ctx.db.cursors.insert(args),
    }),
    stats: procedure({
      args: { list: dbz.bigint() },
      handler: async (ctx: Ctx, args: Ctx) => {
        const rows = await ctx.runQuery(anyApi.todos.list, { list: args.list });
        return { count: rows.length };
      },
    }),
    stream: sseProcedure({
      args: { words: dbz.array(dbz.string()) },
      handler: (ctx: Ctx, args: Ctx) => {
        for (const word of args.words) ctx.stream.write({ type: "text-delta", delta: word });
      },
    }),
  },
};

let dir: string;
let engine: Engine;
let runtime: Runtime;
let server: ReturnType<typeof serve>;
let client: DbzzClient;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dbzz-client-"));
  engine = new Engine(schema, join(dir, "data.db"));
  reconcile(engine);
  runtime = new Runtime({ engine, registry: new Registry(functions) });
  server = serve({ runtime, port: 0 });
  client = new DbzzClient({ url: `http://127.0.0.1:${server.port}` });
});
afterEach(() => {
  client.close();
  server.stop(true);
  runtime.stop();
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

const nextTick = (ms = 40) => Bun.sleep(ms);

describe("DbzzClient", () => {
  test("query, mutation, subscribe, unsubscribe end to end", async () => {
    const empty = await client.query<{ list: bigint }, unknown[]>(anyApi.todos.list, { list: 1n });
    expect(empty).toEqual([]);

    const seen: unknown[][] = [];
    const unsubscribe = client.subscribe(anyApi.todos.list, { list: 1n }, (rows: unknown[]) =>
      seen.push(rows),
    );
    await nextTick();
    expect(seen).toEqual([[]]);

    const id = await client.mutation(anyApi.todos.add, { list: 1n, text: "milk" });
    expect(id).toBe(1n);
    await nextTick();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual([{ id: 1n, list: 1n, text: "milk", done: false }]);

    // a write to another list never reaches this subscription
    await client.mutation(anyApi.todos.add, { list: 2n, text: "other" });
    await nextTick();
    expect(seen).toHaveLength(2);

    unsubscribe();
    await client.mutation(anyApi.todos.add, { list: 1n, text: "bread" });
    await nextTick();
    expect(seen).toHaveLength(2);
  });

  test("subscription errors surface through onError", async () => {
    const errors: string[] = [];
    client.subscribe("todos.nope", {}, () => {}, (message) => errors.push(message));
    await nextTick();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("unknown function");
  });

  test("procedures over HTTP, including server-side runQuery", async () => {
    await client.mutation(anyApi.todos.add, { list: 3n, text: "a" });
    await client.mutation(anyApi.todos.add, { list: 3n, text: "b" });
    const stats = await client.procedure<{ list: bigint }, { count: number }>(anyApi.todos.stats, {
      list: 3n,
    });
    expect(stats).toEqual({ count: 2 });
    // /api/call dispatches by the *registered* kind (type-level enforcement
    // is the codegen's job) — an SSE ref is the one thing it refuses:
    await expect(client.procedure("todos.stream", { words: [] })).rejects.toThrow("SSE procedure");
    await expect(client.procedure("todos.nope", {})).rejects.toThrow("unknown function");
  });

  test("event table subscriptions deliver rows and persist nothing", async () => {
    const cursors: unknown[] = [];
    client.subscribe(anyApi.events.cursors, {}, (row) => cursors.push(row));
    await nextTick();
    await client.mutation(anyApi.todos.moveCursor, { x: 1, y: 2 });
    await client.mutation(anyApi.todos.moveCursor, { x: 3, y: 4 });
    await nextTick();
    expect(cursors).toEqual([
      { id: 1n, x: 1, y: 2 },
      { id: 2n, x: 3, y: 4 },
    ]);
  });

  test("sse procedures stream chunks and terminate", async () => {
    const words: string[] = [];
    for await (const chunk of client.sse(anyApi.todos.stream, { words: ["a", "b", "c"] })) {
      words.push((chunk as { delta: string }).delta);
    }
    expect(words).toEqual(["a", "b", "c"]);
  });

  test("reconnect: resubscribes and flushes queued mutations", async () => {
    const seen: unknown[][] = [];
    client.subscribe(anyApi.todos.list, { list: 9n }, (rows: unknown[]) => seen.push(rows));
    await nextTick();
    expect(seen).toEqual([[]]);

    const port = server.port!;
    server.stop(true); // hard-drop every connection
    await nextTick(30);

    // queued while disconnected — must flush after reconnect, exactly once
    const pendingMutation = client.mutation(anyApi.todos.add, { list: 9n, text: "queued" });

    server = serve({ runtime, port });
    expect(await pendingMutation).toBe(1n);
    await nextTick(600); // reconnect backoff + resubscribe + update
    const last = seen[seen.length - 1];
    expect(last).toEqual([{ id: 1n, list: 9n, text: "queued", done: false }]);
  });
});
