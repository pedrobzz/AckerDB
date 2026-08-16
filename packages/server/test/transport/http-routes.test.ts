/**
 * The unified HTTP route surface, held against a real listener.
 *
 * Two rules meet here. Routing is generic: the more specific pattern wins,
 * captures arrive decoded, a known path with an unsupported method answers 405
 * with the complete Allow, and an unknown one answers 404 — none of which a
 * handler participates in. Raw handlers are symmetric: the exact wire bytes
 * reach them, the Authorization header crosses whatever its scheme, and
 * nothing is stamped on the way out. Everything the framework does author —
 * 405, over-limit, the sanitized 500, not-ready — speaks the same bare Outcome
 * as the rest of the HTTP surface.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "../../src/validation/v.ts";
import { ValidationError } from "../../src/validation/error.ts";
import { AckerDBError } from "../../src/shared/errors.ts";
import { Engine } from "../../src/database/engine.ts";
import { query } from "../../src/app/functions.ts";
import { http } from "../../src/transport/routing/route.ts";
import { Registry } from "../../src/app/registry.ts";
import { defineServiceLimits, PRODUCTION_LIMITS } from "../../src/runtime/limits.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { AckerDBServer } from "../../src/transport/server.ts";
import { listen } from "ackerdb-test-support/listen";

// Raw handlers carry no contract; navigating them in tests is not a typed one.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const SECRET = "whsec_test";

function sign(payload: string | Uint8Array): string {
  return createHmac("sha256", SECRET).update(payload).digest("hex");
}

const schema = defineSchema({
  deliveries: defineTable({ id: v.primaryKey(), type: v.string() }),
});

/** Small bounds so the over-limit and stream-admission cases cross with a few fetches. */
const limits = defineServiceLimits({
  ...PRODUCTION_LIMITS,
  maxRequestBytes: 1024,
  maxOperationsPerCaller: 2,
  gracefulShutdownMs: 250,
});

/** Proves the framework answered before the handler existed. */
let handlerRuns = 0;

/** One handler value under two method keys: path ownership is stated once. */
const shared = (_ctx: Ctx, request: Request): Response =>
  new Response(JSON.stringify({ saw: request.method }), { status: 200 });

const functions = {
  feed: {
    list: query({
      access: "public",
      http: true,
      args: {},
      handler: (ctx: Ctx) => ctx.db.deliveries.query().collect(),
    }),
  },
  hooks: {
    stripe: http("/api/hooks/stripe", {
      POST: async (ctx: Ctx, request: Request) => {
        handlerRuns += 1;
        const payload = new Uint8Array(await request.arrayBuffer());
        if (request.headers.get("x-signature") !== sign(payload)) {
          return new Response(JSON.stringify({ error: "bad signature" }), { status: 401 });
        }
        const event = JSON.parse(new TextDecoder().decode(payload));
        await ctx.tx((tx: Ctx) => tx.db.deliveries.insert({ type: event.type }));
        return new Response(JSON.stringify({ received: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }),
    echo: http("/api/hooks/echo", {
      POST: (_ctx, request) =>
        new Response(
          JSON.stringify({ authorization: request.headers.get("authorization") }),
          { status: 200, headers: { "x-echo": "1" } },
        ),
      OPTIONS: () =>
        new Response(null, {
          status: 204,
          headers: { "access-control-allow-origin": "https://app.example" },
        }),
    }),
    both: http("/api/hooks/both", { GET: shared, POST: shared }),
    redirect: http("/api/hooks/redirect", {
      GET: () =>
        new Response(null, { status: 302, headers: { location: "https://example.com/done" } }),
    }),
    boom: http("/api/hooks/boom", {
      POST: () => {
        throw new Error("the secret cause");
      },
    }),
    boomFramework: http("/api/hooks/boomFramework", {
      POST: () => {
        throw new AckerDBError("validation", "secret validation detail");
      },
    }),
    boomValidation: http("/api/hooks/boomValidation", {
      POST: () => {
        throw new ValidationError("secret field detail");
      },
    }),
    boomHostile: http("/api/hooks/boomHostile", {
      POST: () => {
        // Describing the cause is handler-controlled work too: an accessor
        // that throws must not carry its own error past the sanitizer.
        throw new Proxy(new AckerDBError("validation", "secret proxy detail"), {
          get(target, key, receiver) {
            if (key === "stack") throw target;
            return Reflect.get(target, key, receiver);
          },
        });
      },
    }),
    invalid: http("/api/hooks/invalid", {
      POST: () => ({ nope: true }) as never,
    }),
    hold: http("/api/hooks/hold", {
      GET: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("open"));
              // Never closed: the stream stays open until the caller lets go.
            },
          }),
          { headers: { "content-type": "text/plain" } },
        ),
    }),
    stream: http("/api/hooks/stream", {
      GET: () => {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("one"));
              controller.enqueue(encoder.encode("two"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/plain" } },
        );
      },
    }),
  },
  // A provider dictates its own callback URL, so an explicit path may live
  // anywhere the framework has not reserved — the application root included.
  routes: {
    user: http("/users/:id", {
      GET: (ctx) => Response.json({ matched: "param", id: ctx.params.id }),
    }),
    me: http("/users/me", { GET: () => Response.json({ matched: "static" }) }),
    pair: http("/o/:org/r/:repo", {
      GET: (ctx) => Response.json({ org: ctx.params.org, repo: ctx.params.repo }),
    }),
    assets: http("/users/:id/assets/*", {
      GET: (ctx) => Response.json({ id: ctx.params.id, rest: ctx.params["*"] }),
    }),
  },
};

let dir: string;
let engine: Engine;
let runtime: Runtime;
let server: AckerDBServer;
let base: string;

beforeEach(async () => {
  handlerRuns = 0;
  dir = mkdtempSync(join(tmpdir(), "ackerdb-http-routes-"));
  engine = new Engine(schema, join(dir, "data.db"));
  reconcile(engine);
  runtime = new Runtime({ engine, registry: new Registry(functions), limits });
  await runtime.start();
  server = listen(runtime);
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.drain().catch(() => {});
  await runtime.drain().catch(() => {});
  engine.close("clean");
  rmSync(dir, { recursive: true, force: true });
});

/** The framework must stamp nothing onto a handler-authored response. */
function expectUnstamped(response: Response): void {
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect(response.headers.get("access-control-allow-methods")).toBeNull();
  expect(response.headers.get("vary")).toBeNull();
  expect(response.headers.get("cache-control")).toBeNull();
}

describe("the registry routes before any handler runs", () => {
  test("a static path reaches its own route", async () => {
    const response = await fetch(`${base}/users/me`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ matched: "static" });
  });

  test("an exact path outranks a parameter, and a parameter outranks a wildcard", async () => {
    // `/users/me` is claimed statically and `/users/:id` dynamically; the
    // static one wins without either handler knowing the other exists.
    expect(await (await fetch(`${base}/users/me`)).json()).toEqual({ matched: "static" });
    expect(await (await fetch(`${base}/users/42`)).json())
      .toEqual({ matched: "param", id: "42" });
    expect(await (await fetch(`${base}/users/42/assets/img/logo.png`)).json())
      .toEqual({ id: "42", rest: "img/logo.png" });
  });

  test("every named parameter of a nested path reaches ctx.params", async () => {
    const response = await fetch(`${base}/o/acme/r/widgets`);

    expect(await response.json()).toEqual({ org: "acme", repo: "widgets" });
  });

  test("captures arrive decoded, so the runtime value matches the declared string", async () => {
    const response = await fetch(`${base}/users/a%20b%2Fc`);

    expect(await response.json()).toEqual({ matched: "param", id: "a b/c" });
  });

  test("an undecodable escape is the caller's malformed request, not a missing route", async () => {
    const response = await fetch(`${base}/users/%zz`);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "malformed" });
  });

  test("one path may answer several methods without a request.method switch", async () => {
    expect(await (await fetch(`${base}/api/hooks/both`)).json()).toEqual({ saw: "GET" });
    expect(await (await fetch(`${base}/api/hooks/both`, { method: "POST" })).json())
      .toEqual({ saw: "POST" });
  });

  test("a known path with an unsupported method answers 405 with the complete Allow", async () => {
    const response = await fetch(`${base}/api/hooks/both`, { method: "DELETE" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
    expect(await response.json()).toMatchObject({ code: "malformed", retryable: false });
  });

  test("an unknown path answers 404 in the bare Outcome shape", async () => {
    const response = await fetch(`${base}/nowhere/at/all`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "not_found",
      retryable: false,
      message: "no route at this path",
    });
  });

  test("an exposed function keeps its derived path and its preflight", async () => {
    expect((await fetch(`${base}/api/feed/list`)).status).toBe(200);
    const preflight = await fetch(`${base}/api/feed/list`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    const wrong = await fetch(`${base}/api/feed/list`, { method: "DELETE" });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET, POST, OPTIONS");
  });
});

describe("the request reaches the handler whole", () => {
  test("delivers the exact wire bytes, so HMAC verification and tx persistence work", async () => {
    // Whitespace a JSON round-trip would not preserve: only the exact wire
    // bytes produce this signature.
    const body = '{ "type":  "payment.succeeded" }';
    const response = await fetch(`${base}/api/hooks/stripe`, {
      method: "POST",
      headers: { "x-signature": sign(body) },
      body,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    expectUnstamped(response);

    const listed = await fetch(`${base}/api/feed/list`);
    expect(listed.status).toBe(200);
    const rows = (await listed.json()) as readonly { type: string }[];
    expect(rows.map((row) => row.type)).toEqual(["payment.succeeded"]);
  });

  test("the handler owns invalid input: a bad signature answers its own response", async () => {
    const response = await fetch(`${base}/api/hooks/stripe`, {
      method: "POST",
      headers: { "x-signature": sign('{"type":"payment.succeeded"}') },
      body: '{"type":"tampered"}',
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "bad signature" });
  });

  test("Authorization crosses untouched, whatever its scheme", async () => {
    // Basic auth and a provider-owned bearer: both would be rejected by the
    // framework's credential path, and both must reach the handler instead.
    for (const scheme of ["Basic dXNlcjpwYXNz", "Bearer provider-static-token"]) {
      const response = await fetch(`${base}/api/hooks/echo`, {
        method: "POST",
        headers: { authorization: scheme },
        body: "{}",
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ authorization: scheme });
      expect(response.headers.get("x-echo")).toBe("1");
      expectUnstamped(response);
    }
  });
});

describe("the handler-authored response leaves whole", () => {
  test("a redirect crosses byte-for-byte", async () => {
    const response = await fetch(`${base}/api/hooks/redirect`, { redirect: "manual" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/done");
    expectUnstamped(response);
  });

  test("a streaming body streams", async () => {
    const response = await fetch(`${base}/api/hooks/stream`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(await response.text()).toBe("onetwo");
  });

  test("preflight is the handler's own business: declared OPTIONS answers, undeclared is 405", async () => {
    const declared = await fetch(`${base}/api/hooks/echo`, { method: "OPTIONS" });
    expect(declared.status).toBe(204);
    expect(declared.headers.get("access-control-allow-origin")).toBe("https://app.example");

    // Not a framework preflight: an undeclared method on a raw route is a 405
    // like any other, because the route declared what it serves.
    const undeclared = await fetch(`${base}/api/hooks/stripe`, { method: "OPTIONS" });
    expect(undeclared.status).toBe(405);
    expect(undeclared.headers.get("allow")).toBe("POST");
  });
});

describe("framework-authored responses speak the bare Outcome", () => {
  test("an undeclared method answers 405 with Allow", async () => {
    const response = await fetch(`${base}/api/hooks/stripe`, { method: "PUT", body: "{}" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await response.json()).toMatchObject({ code: "malformed", retryable: false });
  });

  test("an uncaught throw answers a sanitized internal outcome, whatever its type", async () => {
    // A plain Error, an AckerDBError, and a ValidationError must all cross
    // identically: a thrown message is never the handler speaking to the
    // caller — the handler authors its failures as Responses.
    for (const [route, secret] of [
      ["boom", "secret cause"],
      ["boomFramework", "secret validation detail"],
      ["boomValidation", "secret field detail"],
      ["boomHostile", "secret proxy detail"],
    ] as const) {
      const response = await fetch(`${base}/api/hooks/${route}`, { method: "POST", body: "{}" });

      expect(response.status).toBe(500);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({
        code: "internal",
        retryable: false,
        message: "internal server error",
      });
      expect(text).not.toContain(secret);
    }
  });

  test("a non-Response return is a defect answered identically to a throw", async () => {
    const response = await fetch(`${base}/api/hooks/invalid`, { method: "POST", body: "{}" });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "internal",
      retryable: false,
      message: "internal server error",
    });
  });

  test("a streaming body holds its admission slot until the caller lets go", async () => {
    const openStream = async (): Promise<AbortController> => {
      const controller = new AbortController();
      const response = await fetch(`${base}/api/hooks/hold`, { signal: controller.signal });
      expect(response.status).toBe(200);
      // Read the first chunk so the stream is live end to end.
      await response.body!.getReader().read();
      return controller;
    };
    const held = [await openStream(), await openStream()];

    // Every per-caller slot is owned by an open stream: the next call sheds.
    const shed = await fetch(`${base}/api/hooks/echo`, { method: "POST", body: "{}" });
    expect(shed.status).toBe(503);
    expect(await shed.json()).toMatchObject({ code: "overloaded", retryable: true });

    // Letting one stream go returns its capacity; the release follows the
    // disconnect, so the retry polls briefly instead of racing it.
    held[0]!.abort();
    let after: Response;
    for (let attempt = 0; ; attempt++) {
      after = await fetch(`${base}/api/hooks/echo`, { method: "POST", body: "{}" });
      if (after.status !== 503 || attempt >= 40) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(after.status).toBe(200);
    held[1]!.abort();
  });

  test("an over-limit body answers before the handler runs", async () => {
    const response = await fetch(`${base}/api/hooks/stripe`, {
      method: "POST",
      body: "a".repeat(limits.maxRequestBytes + 1),
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "overloaded" });
    expect(handlerRuns).toBe(0);
  });
});

describe("lifecycle decides reachability, not the route table", () => {
  test("probes answer through Boot while application routes are still absent", async () => {
    const starting = new AckerDBServer({ limits, port: 0 });
    try {
      const origin = `http://127.0.0.1:${starting.port}`;
      const live = await fetch(`${origin}/live`);
      expect(live.status).toBe(200);
      expect(await live.json()).toMatchObject({ live: true });

      const ready = await fetch(`${origin}/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({ ready: false, phase: "listening" });

      // Both the call and its preflight: no framework preflight may ever speak
      // for a handler that does not exist yet.
      for (const method of ["POST", "OPTIONS"] as const) {
        const response = await fetch(`${origin}/api/hooks/stripe`, {
          method,
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: "unavailable", retryable: true });
      }
    } finally {
      await starting.drain().catch(() => {});
    }
  });

  test("the same path is reachable after activation and unavailable while draining", async () => {
    expect((await fetch(`${base}/users/7`)).status).toBe(200);

    server.beginShutdown();
    const draining = await fetch(`${base}/users/7`);
    // The route still exists — the lifecycle answers, never a 404.
    expect(draining.status).toBe(503);
    expect(await draining.json()).toMatchObject({ code: "draining", retryable: true });

    // An unclaimed path answers the same way while draining: unreachable is
    // not the same statement as absent.
    const unknown = await fetch(`${base}/nowhere/at/all`);
    expect(unknown.status).toBe(503);
    expect(await unknown.json()).toMatchObject({ code: "draining" });
  });
});
