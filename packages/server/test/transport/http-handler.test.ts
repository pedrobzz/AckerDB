/**
 * The raw handler surface's one rule, held against a real listener: the
 * framework touches neither the request nor a handler-authored response. The
 * exact wire bytes reach the handler (an HMAC verification is the proof), the
 * Authorization header crosses whatever its scheme, and nothing is stamped on
 * the way out. Everything the framework does author — 405, over-limit, the
 * sanitized 500, not-ready — speaks the same bare Outcome as the rest of the
 * HTTP surface.
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
import { httpHandler } from "../../src/app/http-handler.ts";
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
    stripe: httpHandler({
      methods: ["POST"],
      handler: async (ctx: Ctx, request: Request) => {
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
    echo: httpHandler({
      methods: ["POST", "OPTIONS"],
      handler: (_ctx: Ctx, request: Request) => {
        if (request.method === "OPTIONS") {
          return new Response(null, {
            status: 204,
            headers: { "access-control-allow-origin": "https://app.example" },
          });
        }
        return new Response(
          JSON.stringify({ authorization: request.headers.get("authorization") }),
          { status: 200, headers: { "x-echo": "1" } },
        );
      },
    }),
    redirect: httpHandler({
      methods: ["GET"],
      handler: () =>
        new Response(null, { status: 302, headers: { location: "https://example.com/done" } }),
    }),
    boom: httpHandler({
      methods: ["POST"],
      handler: () => {
        throw new Error("the secret cause");
      },
    }),
    boomFramework: httpHandler({
      methods: ["POST"],
      handler: () => {
        throw new AckerDBError("validation", "secret validation detail");
      },
    }),
    boomValidation: httpHandler({
      methods: ["POST"],
      handler: () => {
        throw new ValidationError("secret field detail");
      },
    }),
    boomHostile: httpHandler({
      methods: ["POST"],
      handler: () => {
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
    invalid: httpHandler({
      methods: ["POST"],
      handler: () => ({ nope: true }) as never,
    }),
    hold: httpHandler({
      methods: ["GET"],
      handler: () =>
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
    stream: httpHandler({
      methods: ["GET"],
      handler: () => {
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
};

let dir: string;
let engine: Engine;
let runtime: Runtime;
let server: AckerDBServer;
let base: string;

beforeEach(async () => {
  handlerRuns = 0;
  dir = mkdtempSync(join(tmpdir(), "ackerdb-http-handler-"));
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

    // Not the listener's global 204: an undeclared method on a raw route is a
    // 405 like any other, because the handler declared what it serves.
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
    for (const [address, secret] of [
      ["boom", "secret cause"],
      ["boomFramework", "secret validation detail"],
      ["boomValidation", "secret field detail"],
      ["boomHostile", "secret proxy detail"],
    ] as const) {
      const response = await fetch(`${base}/api/hooks/${address}`, { method: "POST", body: "{}" });

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

  test("a raw path answers unavailable while the server is not ready — preflight included", async () => {
    const starting = new AckerDBServer({ limits, port: 0 });
    try {
      // Both the call and its preflight: the listener's global OPTIONS answer
      // must never speak for a handler that does not exist yet.
      for (const method of ["POST", "OPTIONS"] as const) {
        const response = await fetch(
          `http://127.0.0.1:${starting.port}/api/hooks/stripe`,
          { method, ...(method === "POST" ? { body: "{}" } : {}) },
        );
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: "unavailable", retryable: true });
      }
    } finally {
      await starting.drain().catch(() => {});
    }
  });
});
