/**
 * The document and the served bytes are one contract. Every case here takes a
 * schema straight out of the published OpenAPI document, drives a real HTTP
 * request against the running listener, and holds the response bytes against
 * that schema — the cross-check no test made before, which is exactly how the
 * surface came to answer AckerDB's wire escapes to callers the document had
 * promised plain JSON.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Err, Ok, Status, parseSseMessage, type SseMessage } from "@ackerdb/core";
import { v } from "../../src/validation/v.ts";
import { Engine } from "../../src/database/engine.ts";
import { query, sseProcedure } from "../../src/app/functions.ts";
import { defineServiceLimits, PRODUCTION_LIMITS } from "../../src/runtime/limits.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { openApiDocument } from "../../src/transport/openapi.ts";
import { AckerDBServer } from "../../src/transport/server.ts";
import { jsonSchemaViolations } from "../support/json-schema-check.ts";

// The document is plain JSON; navigating it in tests is not a typed contract.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const info = { title: "catalog-app", version: "1.0.0" } as const;

/** Past 2^53: the decimal-string mapping is the whole reason it survives. */
const HUGE_SKU = "9007199254740993";
const STAMP = "AQID";

const schema = defineSchema({
  skus: defineTable({ id: v.primaryKey(), sku: v.bigint() }),
});

/** An abandoned stream must not hold shutdown for the production stall window. */
const limits = defineServiceLimits({
  ...PRODUCTION_LIMITS,
  sse: { ...PRODUCTION_LIMITS.sse, maxStallMs: 250 },
  gracefulShutdownMs: 250,
});

const functions = {
  catalog: {
    lookup: query({
      access: "public",
      http: true,
      args: { sku: v.bigint(), stamp: v.bytes() },
      returns: v.object({ sku: v.bigint(), stamp: v.bytes(), label: v.string() }),
      errors: {
        "catalog.missing": { body: v.object({ sku: v.bigint() }), status: Status.NotFound },
      },
      handler: (_ctx: Ctx, args: Ctx) =>
        args.sku === 0n
          ? Err("catalog.missing", { sku: args.sku }, Status.NotFound)
          : Ok({ sku: args.sku, stamp: args.stamp, label: "widget" }),
    }),
    tail: sseProcedure({
      access: "public",
      http: true,
      args: { sku: v.bigint() },
      yields: v.object({ sku: v.bigint(), frame: v.bytes() }),
      handler: async function* (_ctx: Ctx, args: Ctx) {
        yield { sku: args.sku, frame: new Uint8Array([1, 2, 3]) };
      },
    }),
  },
};

let dir: string;
let engine: Engine;
let runtime: Runtime;
let server: AckerDBServer;
let base: string;
let document: Ctx;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ackerdb-http-wire-"));
  engine = new Engine(schema, join(dir, "data.db"));
  reconcile(engine);
  server = new AckerDBServer({ limits, port: 0 });
  const registry = server.loadFunctionModules(functions);
  runtime = new Runtime({ engine, registry, limits });
  await runtime.start();
  server.activate(runtime);
  base = `http://127.0.0.1:${server.port}`;
  document = openApiDocument(registry, info);
});

afterEach(async () => {
  await server.drain().catch(() => {});
  await runtime.drain().catch(() => {});
  engine.close("clean");
  rmSync(dir, { recursive: true, force: true });
});

function operation(address: string, method: "get" | "post"): Ctx {
  return document.paths[`/api/${address.replaceAll(".", "/")}`][method];
}

function requestSchema(address: string): Ctx {
  return operation(address, "post").requestBody.content["application/json"].schema;
}

function responseSchema(address: string, status: string, mediaType = "application/json"): Ctx {
  return operation(address, "post").responses[status].content[mediaType].schema;
}

/** The document is the specification; a violation of it is a test failure. */
function expectDocumented(schema: Ctx, value: unknown): void {
  expect(jsonSchemaViolations(schema, value)).toEqual([]);
}

async function firstSseChunk(response: Response): Promise<SseMessage> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) return parseSseMessage(JSON.parse(buffer.slice(6, boundary)));
      const part = await reader.read();
      if (part.done) throw new Error("SSE stream ended before its first chunk");
      buffer += decoder.decode(part.value, { stream: true });
    }
  } finally {
    await reader.cancel("test complete").catch(() => {});
  }
}

describe("the served surface answers the document it publishes", () => {
  test("carries bigint and bytes args and returns as the document's plain JSON", async () => {
    const args = { sku: HUGE_SKU, stamp: STAMP };
    // A caller reading the document sends exactly this, so the request itself
    // is held against the published request schema before it is sent.
    expectDocumented(requestSchema("catalog.lookup"), args);

    const response = await fetch(`${base}/api/catalog/lookup`, {
      method: "POST",
      body: JSON.stringify(args),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text);

    expectDocumented(responseSchema("catalog.lookup", "200"), body);
    // Named exactly, so the wire form is legible rather than merely validated.
    expect(text).toBe(`{"sku":"${HUGE_SKU}","stamp":"${STAMP}","label":"widget"}`);
  });

  test("answers a GET query from the same document as its POST twin", async () => {
    const args = { sku: HUGE_SKU, stamp: STAMP };
    const parameter = operation("catalog.lookup", "get")
      .parameters[0].content["application/json"].schema;
    expectDocumented(parameter, args);

    const response = await fetch(
      `${base}/api/catalog/lookup?args=${encodeURIComponent(JSON.stringify(args))}`,
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(await response.text());
    expectDocumented(
      operation("catalog.lookup", "get").responses["200"].content["application/json"].schema,
      body,
    );
    expect(body).toEqual({ sku: HUGE_SKU, stamp: STAMP, label: "widget" });
  });

  test("carries a declared error body through its own declaration", async () => {
    const response = await fetch(`${base}/api/catalog/lookup`, {
      method: "POST",
      body: JSON.stringify({ sku: "0", stamp: STAMP }),
    });
    expect(response.status).toBe(404);
    const body = JSON.parse(await response.text());

    expectDocumented(responseSchema("catalog.lookup", "404"), body);
    expect(body).toEqual({
      kind: "application",
      code: "catalog.missing",
      body: { sku: "0" },
      status: 404,
    });
  });

  test("writes sse frames in the shape the event-stream response documents", async () => {
    const response = await fetch(`${base}/api/catalog/tail`, {
      method: "POST",
      body: JSON.stringify({ sku: HUGE_SKU }),
    });
    expect(response.status).toBe(200);
    const chunk = await firstSseChunk(response);
    expect(chunk.t).toBe("sse_chunk");
    if (chunk.t !== "sse_chunk") throw new Error("expected an sse chunk");

    // The whole frame is held against the document, not just its payload: a
    // receiver that read the event as a bare chunk would never acknowledge one.
    expectDocumented(responseSchema("catalog.tail", "200", "text/event-stream"), chunk);
    expect(chunk.value).toEqual({ sku: HUGE_SKU, frame: "AQID" });
  });

  test("answers a transport failure as the document's Outcome, not a frame", async () => {
    const response = await fetch(`${base}/api/catalog/lookup`, {
      method: "POST",
      body: JSON.stringify({ sku: "not-a-number", stamp: STAMP }),
    });
    expect(response.status).toBe(400);
    const outcome = JSON.parse(await response.text());
    expectDocumented(document.components.schemas.Outcome, outcome);
    expect(outcome).toMatchObject({ code: "validation" });
  });

  test("refuses AckerDB's own wire escapes, which this surface never speaks", async () => {
    // The escape form the WebSocket protocol uses for the very same args. It is
    // not what the document describes, so the surface must not accept it.
    const response = await fetch(`${base}/api/catalog/lookup`, {
      method: "POST",
      body: JSON.stringify({ sku: { $: "b", v: "1" }, stamp: { $: "x", v: STAMP } }),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(await response.text())).toMatchObject({ code: "validation" });
  });
});
