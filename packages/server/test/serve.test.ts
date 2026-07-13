import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, encode } from "@dbzz/core";
import {
  dbz,
  defineEventTable,
  defineSchema,
  defineTable,
  Engine,
  mutation,
  query,
  reconcile,
  Registry,
  Runtime,
  serve,
  sseProcedure,
} from "@dbzz/server";

const schema = defineSchema({
  notes: defineTable({ id: dbz.primaryKey(), body: dbz.string(), rank: dbz.bigint() }).index(
    "by_rank",
    ["rank"],
  ),
  beeps: defineEventTable({ id: dbz.primaryKey(), n: dbz.number() }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const functions = {
  notes: {
    list: query({
      access: "public",
      args: { rank: dbz.bigint() },
      handler: (ctx: Ctx, args: Ctx) =>
        ctx.db.notes.byRank((q: Ctx) => q.eq("rank", args.rank)).collect(),
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
    chat: sseProcedure({
      access: "public",
      args: { text: dbz.string() },
      handler: (ctx: Ctx, args: Ctx) => {
        ctx.stream.write({ type: "text-delta", delta: args.text });
      },
    }),
  },
};

let dir: string;
let engine: Engine;
let runtime: Runtime;
let server: ReturnType<typeof serve>;
let base: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dbzz-serve-"));
  engine = new Engine(schema, join(dir, "data.db"));
  reconcile(engine);
  runtime = new Runtime({ engine, registry: new Registry(functions) });
  server = serve({ runtime, port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(() => {
  server.stop(true);
  runtime.stop();
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (body: unknown) => {
  const res = await fetch(`${base}/api/call`, { method: "POST", body: encode(body) });
  return { status: res.status, body: decode(await res.text()) as Record<string, unknown> };
};

describe("http", () => {
  test("health, call query/mutation, wire types survive", async () => {
    expect(((await (await fetch(`${base}/health`)).json()) as { ok: boolean }).ok).toBe(true);
    const add = await call({ ref: "notes.add", args: { body: "a", rank: 7n }, mid: "m1" });
    expect(add).toEqual({ status: 200, body: { value: 1n } });
    // same mid replays without re-executing
    const replay = await call({ ref: "notes.add", args: { body: "a", rank: 7n }, mid: "m1" });
    expect(replay.body["value"]).toBe(1n);
    const list = await call({ ref: "notes.list", args: { rank: 7n } });
    expect(list.status).toBe(200);
    expect(list.body["value"]).toEqual([{ id: 1n, body: "a", rank: 7n }]);
  });

  test("errors: unknown ref 400, validation 400", async () => {
    expect((await call({ ref: "nope.x", args: {} })).status).toBe(400);
    const bad = await call({ ref: "notes.list", args: { rank: "seven" } });
    expect(bad.status).toBe(400);
    expect(String(bad.body["error"])).toContain("rank");
  });

  test("sse endpoint streams data lines with AI-SDK headers and [DONE]", async () => {
    const res = await fetch(`${base}/api/sse`, {
      method: "POST",
      body: encode({ ref: "notes.chat", args: { text: "hello" } }),
    });
    expect(res.headers.get("content-type")).toStartWith("text/event-stream");
    expect(res.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const text = await res.text();
    expect(text).toBe('data: {"type":"text-delta","delta":"hello"}\n\ndata: [DONE]\n\n');
  });
});

describe("websocket", () => {
  interface Frame {
    t: string;
    id?: number;
    value?: unknown;
    row?: unknown;
    message?: string;
  }

  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const frames: Frame[] = [];
    const waiters: ((f: Frame) => void)[] = [];
    ws.onmessage = (e) => {
      const frame = decode(String(e.data)) as Frame;
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("ws failed"));
    });
    const next = (): Promise<Frame> => {
      const queued = frames.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => waiters.push(resolve));
    };
    return { ws, next, send: (frame: unknown) => ws.send(encode(frame)) };
  };

  test("subscribe → initial update → mutation-driven update; events; q/m frames", async () => {
    const client = await connect();
    client.send({ t: "sub", id: 1, ref: "notes.list", args: { rank: 1n } });
    expect(await client.next()).toEqual({ t: "update", id: 1, value: [] });

    client.send({ t: "sub", id: 2, ref: "events.beeps", args: {} });
    client.send({ t: "m", id: 3, ref: "notes.add", args: { body: "x", rank: 1n }, mid: "w1" });

    const got = [await client.next(), await client.next(), await client.next()];
    const byType = Object.groupBy(got, (f) => f.t);
    expect(byType["ok"]).toEqual([{ t: "ok", id: 3, value: 1n }]);
    expect((byType["update"]![0]!.value as unknown[]).length).toBe(1);
    expect(byType["event"]).toEqual([{ t: "event", id: 2, row: { id: 1n, n: 1 } }]);

    client.send({ t: "q", id: 4, ref: "notes.list", args: { rank: 1n } });
    const q = await client.next();
    expect(q.t).toBe("ok");
    expect((q.value as unknown[]).length).toBe(1);

    client.send({ t: "ping" });
    expect((await client.next()).t).toBe("pong");

    client.send({ t: "sub", id: 5, ref: "bogus.fn", args: {} });
    const err = await client.next();
    expect(err).toMatchObject({ t: "err", id: 5 });

    client.ws.close();
    await Bun.sleep(30);
    expect(runtime.subs.size).toBe(0); // disconnect cleaned up the query entry
  });

  test("unsub stops updates", async () => {
    const client = await connect();
    client.send({ t: "sub", id: 1, ref: "notes.list", args: { rank: 9n } });
    await client.next();
    client.send({ t: "unsub", id: 1 });
    client.send({ t: "m", id: 2, ref: "notes.add", args: { body: "y", rank: 9n }, mid: "w2" });
    const after = await client.next();
    expect(after).toEqual({ t: "ok", id: 2, value: 1n }); // no update frame before it
    client.ws.close();
  });
});
