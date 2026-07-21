import { describe, expect, test } from "bun:test";
import type { PluginExportTree } from "@dbzz/server";
import { CacheStoreError, cachePlugin } from "../../src/index.ts";
import { upstashCacheStore, type UpstashFetch } from "../../src/adapters/upstash.ts";

type TestPluginOperation = Exclude<PluginExportTree[string], PluginExportTree>;

function requestSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("upstashCacheStore", () => {
  test("is pure until use and sends one authenticated JSON command per operation", async () => {
    const commands: unknown[][] = [];
    const rows = new Map<string, string>();
    const signals: Array<AbortSignal | null | undefined> = [];
    let requests = 0;
    const transport: UpstashFetch = async (input, init) => {
      requests++;
      expect(String(input)).toBe("https://example.upstash.io/");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      signals.push(init?.signal);
      const command = JSON.parse(String(init?.body)) as unknown[];
      commands.push(command);
      const [name, key, payload, ...options] = command;
      if (name === "GET") {
        return Response.json({ result: rows.get(String(key)) ?? null });
      }
      if (name === "DEL") {
        return Response.json({ result: rows.delete(String(key)) ? 1 : 0 });
      }
      if (name === "SET") {
        const present = rows.has(String(key));
        if (options.includes("NX") && present) return Response.json({ result: null });
        if (options.includes("XX") && !present) return Response.json({ result: null });
        rows.set(String(key), String(payload));
        return Response.json({ result: "OK" });
      }
      return Response.json({ error: "unsupported command" }, { status: 400 });
    };

    const store = upstashCacheStore({
      url: "https://example.upstash.io",
      token: "secret-token",
      keyPrefix: "production",
      fetch: transport,
    });
    expect(store.keyPrefix).toBe("production");
    expect(requests).toBe(0);
    const handle = await store.open({ abortSignal: requestSignal() });
    expect(requests).toBe(0);

    const signal = requestSignal();
    expect(await handle.get("framed", { abortSignal: signal })).toBeUndefined();
    expect(
      await handle.set("framed", "payload", {
        abortSignal: signal,
        expiresInMs: 250,
        if: "missing",
      }),
    ).toBe(true);
    expect(
      await handle.set("framed", "other", { abortSignal: signal, if: "missing" }),
    ).toBe(false);
    expect(await handle.get("framed", { abortSignal: signal })).toBe("payload");
    expect(
      await handle.set("absent", "value", { abortSignal: signal, if: "present" }),
    ).toBe(false);
    expect(await handle.delete("framed", { abortSignal: signal })).toBe(true);
    expect(await handle.delete("framed", { abortSignal: signal })).toBe(false);

    expect(commands).toEqual([
      ["GET", "framed"],
      ["SET", "framed", "payload", "PX", 250, "NX"],
      ["SET", "framed", "other", "NX"],
      ["GET", "framed"],
      ["SET", "absent", "value", "XX"],
      ["DEL", "framed"],
      ["DEL", "framed"],
    ]);
    expect(signals.every((seen) => seen === signal)).toBe(true);
  });

  test("passes provider failures to the Cache boundary without exposing credentials", async () => {
    const token = "must-not-leak";
    const transport: UpstashFetch = async () =>
      Response.json({ error: "WRONGPASS invalid password" }, { status: 401 });
    const store = upstashCacheStore({
      url: "https://example.upstash.io",
      token,
      keyPrefix: "test",
      fetch: transport,
    });
    const plugin = cachePlugin({ store });
    const cleanup = await plugin.lifecycle?.({
      mount: "cache",
      abortSignal: requestSignal(),
    });
    const implementation = plugin.exports["get"] as TestPluginOperation;
    const args = implementation.spec.args.check({ key: "key" }, "args");
    try {
      await implementation.handler({
        mount: "cache",
        timestamp: 0,
        abortSignal: requestSignal(),
        tx: () => Promise.reject(new Error("unused")),
      }, args);
      throw new Error("expected Upstash failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CacheStoreError);
      const failure = error as CacheStoreError;
      expect(failure.cause).toBeInstanceOf(Error);
      expect(String(failure.cause)).toContain("WRONGPASS");
      expect(String(failure.cause)).not.toContain(token);
    }
    if (typeof cleanup === "function") await cleanup();
  });

  test("validates endpoint, token, transport, and options without printing secrets", () => {
    const construct = upstashCacheStore as (options: unknown) => unknown;
    expect(() => construct({ url: "http://example.com", token: "secret", keyPrefix: "x" }))
      .toThrow("HTTPS");
    expect(() => construct({ url: "https://example.com", token: "", keyPrefix: "x" }))
      .toThrow("token");
    expect(() => construct({
      url: "https://example.com",
      token: "private-value",
      keyPrefix: "x",
      fetch: 1,
    })).toThrow("fetch");
    try {
      construct({
        url: "https://example.com",
        token: "private-value",
        keyPrefix: "x",
        unknown: true,
      });
    } catch (error) {
      expect(String(error)).not.toContain("private-value");
    }
  });
});
