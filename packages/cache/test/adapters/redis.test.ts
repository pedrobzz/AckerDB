import { Buffer } from "node:buffer";
import { RedisClient } from "bun";
import { describe, expect, spyOn, test } from "bun:test";
import type { PluginCleanup, PluginExportTree } from "@dbzz/server";
import { CacheStoreError, cachePlugin } from "../../src/index.ts";
import { redisCacheStore } from "../../src/adapters/redis.ts";

type TestPluginOperation = Exclude<PluginExportTree[string], PluginExportTree>;

interface ParsedCommand {
  readonly args: string[];
  readonly consumed: number;
}

function parseCommand(buffer: Buffer): ParsedCommand | null {
  let cursor = 0;
  const line = (): string | null => {
    const end = buffer.indexOf("\r\n", cursor);
    if (end < 0) return null;
    const value = buffer.subarray(cursor, end).toString("utf8");
    cursor = end + 2;
    return value;
  };
  const header = line();
  if (header === null) return null;
  if (!header.startsWith("*")) throw new Error("expected RESP array");
  const count = Number(header.slice(1));
  const args: string[] = [];
  for (let index = 0; index < count; index++) {
    const bulk = line();
    if (bulk === null) return null;
    if (!bulk.startsWith("$")) throw new Error("expected RESP bulk string");
    const length = Number(bulk.slice(1));
    if (buffer.length < cursor + length + 2) return null;
    args.push(buffer.subarray(cursor, cursor + length).toString("utf8"));
    cursor += length;
    if (buffer[cursor] !== 13 || buffer[cursor + 1] !== 10) {
      throw new Error("invalid RESP bulk terminator");
    }
    cursor += 2;
  }
  return { args, consumed: cursor };
}

function bulk(value: string): string {
  return `$${Buffer.byteLength(value, "utf8")}\r\n${value}\r\n`;
}

function fakeRedis({
  failGets = false,
  stallHello = false,
}: {
  readonly failGets?: boolean;
  readonly stallHello?: boolean;
} = {}) {
  const commands: string[][] = [];
  const rows = new Map<string, string>();
  let receiveHello!: () => void;
  const helloReceived = new Promise<void>((resolve) => {
    receiveHello = resolve;
  });
  let connections = 0;
  const server = Bun.listen<{ pending: Buffer }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        connections++;
        socket.data = { pending: Buffer.alloc(0) };
      },
      data(socket, data) {
        socket.data.pending = Buffer.concat([socket.data.pending, Buffer.from(data)]);
        while (true) {
          const parsed = parseCommand(socket.data.pending);
          if (parsed === null) return;
          socket.data.pending = socket.data.pending.subarray(parsed.consumed);
          commands.push(parsed.args);
          const [rawName, key, payload, ...options] = parsed.args;
          const name = rawName?.toUpperCase();
          if (name === "HELLO") {
            receiveHello();
            if (!stallHello) socket.write("+OK\r\n");
          } else if (name === "GET") {
            if (failGets) {
              socket.write("-ERR deterministic GET failure\r\n");
            } else {
              const value = rows.get(key!);
              socket.write(value === undefined ? "$-1\r\n" : bulk(value));
            }
          } else if (name === "SET") {
            const present = rows.has(key!);
            if ((options.includes("NX") && present) || (options.includes("XX") && !present)) {
              socket.write("$-1\r\n");
            } else {
              rows.set(key!, payload!);
              socket.write("+OK\r\n");
            }
          } else if (name === "DEL") {
            socket.write(`:${rows.delete(key!) ? 1 : 0}\r\n`);
          } else {
            socket.write("-ERR unsupported command\r\n");
          }
        }
      },
    },
  });
  return {
    commands,
    helloReceived,
    get connections() {
      return connections;
    },
    close: () => server.stop(true),
    url: `redis://127.0.0.1:${server.port}`,
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("redisCacheStore", () => {
  test("connects only in lifecycle and maps Cache operations to native Redis commands", async () => {
    const redis = fakeRedis();
    try {
      const store = redisCacheStore({ url: redis.url, keyPrefix: "production" });
      expect(store.keyPrefix).toBe("production");
      expect(redis.connections).toBe(0);
      const handle = await store.open({ abortSignal: signal() });
      expect(redis.connections).toBe(1);

      expect(await handle.get("framed", { abortSignal: signal() })).toBeUndefined();
      expect(
        await handle.set("framed", "payload", {
          abortSignal: signal(),
          expiresInMs: 250,
          if: "missing",
        }),
      ).toBe(true);
      expect(
        await handle.set("framed", "other", { abortSignal: signal(), if: "missing" }),
      ).toBe(false);
      expect(await handle.get("framed", { abortSignal: signal() })).toBe("payload");
      expect(
        await handle.set("absent", "value", { abortSignal: signal(), if: "present" }),
      ).toBe(false);
      expect(await handle.delete("framed", { abortSignal: signal() })).toBe(true);
      expect(await handle.delete("framed", { abortSignal: signal() })).toBe(false);

      expect(redis.commands.filter(([name]) => name !== "HELLO")).toEqual([
        ["GET", "framed"],
        ["SET", "framed", "payload", "PX", "250", "NX"],
        ["SET", "framed", "other", "NX"],
        ["GET", "framed"],
        ["SET", "absent", "value", "XX"],
        ["DEL", "framed"],
        ["DEL", "framed"],
      ]);
      await handle.close?.();
    } finally {
      redis.close();
    }
  });

  test("rejects already-aborted work without dispatching a Redis command", async () => {
    const redis = fakeRedis();
    try {
      const store = redisCacheStore({ url: redis.url, keyPrefix: "test" });
      const handle = await store.open({ abortSignal: signal() });
      const before = redis.commands.length;
      const abort = new AbortController();
      const reason = new Error("cancelled");
      abort.abort(reason);
      await expect(handle.get("key", { abortSignal: abort.signal })).rejects.toBe(reason);
      expect(redis.commands).toHaveLength(before);
      await handle.close?.();
    } finally {
      redis.close();
    }
  });

  test("rejects an already-aborted lifecycle without connecting", async () => {
    const redis = fakeRedis();
    try {
      const store = redisCacheStore({ url: redis.url, keyPrefix: "test" });
      const abort = new AbortController();
      const reason = new Error("startup cancelled");
      abort.abort(reason);
      await expect(store.open({ abortSignal: abort.signal })).rejects.toBe(reason);
      expect(redis.connections).toBe(0);
    } finally {
      redis.close();
    }
  });

  test("closes exactly once when lifecycle cancellation interrupts Redis connect", async () => {
    const redis = fakeRedis({ stallHello: true });
    const close = spyOn(RedisClient.prototype, "close");
    try {
      const store = redisCacheStore({ url: redis.url, keyPrefix: "test" });
      const abort = new AbortController();
      const opening = Promise.resolve(store.open({ abortSignal: abort.signal }));
      await redis.helloReceived;

      abort.abort(new Error("startup cancelled"));

      await expect(opening).rejects.toBeInstanceOf(Error);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
      redis.close();
    }
  });

  test("keeps the connect failure first when cancellation cleanup also fails", async () => {
    const redis = fakeRedis({ stallHello: true });
    const closeClient = RedisClient.prototype.close;
    const cleanupFailure = new Error("close failed");
    const close = spyOn(RedisClient.prototype, "close").mockImplementation(function (
      this: RedisClient,
    ) {
      closeClient.call(this);
      throw cleanupFailure;
    });
    try {
      const store = redisCacheStore({ url: redis.url, keyPrefix: "test" });
      const abort = new AbortController();
      const opening = Promise.resolve(store.open({ abortSignal: abort.signal }));
      await redis.helloReceived;

      abort.abort(new Error("startup cancelled"));

      const failure = await opening.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors[0]).not.toBe(cleanupFailure);
      expect((failure as AggregateError).errors[1]).toBe(cleanupFailure);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
      redis.close();
    }
  });

  test("preserves Redis command failures at the public Cache boundary", async () => {
    const redis = fakeRedis({ failGets: true });
    let cleanup: PluginCleanup | void = undefined;
    try {
      const plugin = cachePlugin({
        store: redisCacheStore({ url: redis.url, keyPrefix: "test" }),
      });
      cleanup = await plugin.lifecycle?.({
        mount: "cache",
        abortSignal: signal(),
      });
      const implementation = plugin.exports["get"] as TestPluginOperation;
      const args = implementation.spec.args.check({ key: "key" }, "args");

      try {
        await implementation.handler({
          mount: "cache",
          timestamp: 0,
          abortSignal: signal(),
          tx: () => Promise.reject(new Error("unused")),
        }, args);
        throw new Error("expected Redis failure");
      } catch (error) {
        expect(error).toBeInstanceOf(CacheStoreError);
        const failure = error as CacheStoreError;
        expect(failure.cause).toBeInstanceOf(Error);
        expect(String(failure.cause)).toContain("deterministic GET failure");
      }
    } finally {
      if (typeof cleanup === "function") await cleanup();
      redis.close();
    }
  });

  test("validates the flat definition without echoing URL credentials", () => {
    const construct = redisCacheStore as (options: unknown) => unknown;
    expect(() => construct({ url: "", keyPrefix: "x" })).toThrow("url");
    expect(() => construct({ url: "redis://localhost:6379", keyPrefix: "" }))
      .toThrow("keyPrefix");
    const secret = "redis://user:private-password@localhost:6379";
    try {
      construct({ url: secret, keyPrefix: "x", unknown: true });
    } catch (error) {
      expect(String(error)).not.toContain("private-password");
    }
  });
});
