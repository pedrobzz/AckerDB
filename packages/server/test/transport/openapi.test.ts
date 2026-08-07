import { describe, expect, test } from "bun:test";
import { Err, PROTOCOL_VERSION, Status } from "@ackerdb/core";
import { v } from "../../src/validation/v.ts";
import { mutation, procedure, query, sseProcedure } from "../../src/app/functions.ts";
import { Registry } from "../../src/app/registry.ts";
import { argsJsonSchema, validatorJsonSchema } from "../../src/validation/json-schema.ts";
import { openApiDocument } from "../../src/transport/openapi.ts";

// The document is plain JSON; navigating it in tests is not a typed contract.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const info = { title: "savoria", version: "2.1.0" } as const;

const functions = () => ({
  messages: {
    list: query({
      access: "public",
      http: true,
      title: "List messages",
      description: "List the newest messages in a channel.",
      args: { channel: v.string(), limit: v.int().optional() },
      returns: v.array(v.object({ body: v.string() })),
      handler: (_ctx: Ctx, args: Ctx) => [{ body: args.channel }],
    }),
    send: mutation({
      access: "public",
      http: true,
      args: { channel: v.string(), body: v.string() },
      returns: v.bigint(),
      errors: {
        "messages.empty": { body: v.object({ reason: v.string() }), status: Status.Conflict },
        "messages.rateLimited": { body: v.object({ retryAfterMs: v.int() }), status: Status.Conflict },
        "messages.gone": { body: v.object({ reason: v.string() }), status: Status.Gone },
      },
      handler: (_ctx: Ctx, args: Ctx) =>
        args.body === ""
          ? Err("messages.empty", { reason: "empty" }, Status.Conflict)
          : args.body === "!"
            ? Err("messages.rateLimited", { retryAfterMs: 5 }, Status.Conflict)
            : args.channel === ""
              ? Err("messages.gone", { reason: "purged" }, Status.Gone)
              : 1n,
    }),
    /** Callable over HTTP, deliberately absent from the document. */
    purge: mutation({
      access: "public",
      http: { openapi: false },
      args: { channel: v.string() },
      handler: () => 0n,
    }),
    /** Not exposed at all: absent from the surface and the document alike. */
    sweep: procedure({
      access: "public",
      args: {},
      handler: () => "swept",
    }),
    ping: procedure({
      access: "public",
      http: true,
      args: {},
      handler: () => ({ pong: true }),
    }),
    tail: sseProcedure({
      access: "authenticated",
      http: true,
      args: { channel: v.string() },
      yields: v.object({ body: v.string() }),
      handler: async function* (_ctx: Ctx, args: Ctx) {
        yield { body: args.channel };
      },
    }),
  },
  admin: {
    stats: query({
      access: "authenticated",
      http: true,
      args: {},
      returns: v.object({ count: v.int() }),
      handler: () => ({ count: 0 }),
    }),
  },
});

const document = () => openApiDocument(new Registry(functions()), info) as Ctx;

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

/**
 * The OpenAPI 3.1 structural contract: the document object, its path items,
 * operations, parameters, and responses, plus internal `$ref` resolution. It is
 * deliberately independent of the generator so the two cannot agree on a bug.
 */
function violations(value: unknown): string[] {
  const found: string[] = [];
  const document = value as Ctx;
  const complain = (where: string, what: string) => found.push(`${where}: ${what}`);
  const isObject = (candidate: unknown): candidate is Record<string, unknown> =>
    typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);

  if (!isObject(document)) return ["$: document must be an object"];
  if (typeof document.openapi !== "string" || !document.openapi.startsWith("3.1.")) {
    complain("$.openapi", "must be a 3.1.x version string");
  }
  if (!isObject(document.info)) complain("$.info", "must be an object");
  else {
    if (typeof document.info.title !== "string") complain("$.info.title", "must be a string");
    if (typeof document.info.version !== "string") complain("$.info.version", "must be a string");
  }
  if (!isObject(document.paths)) complain("$.paths", "must be an object");

  const referenced = new Set<string>();
  const walk = (node: unknown, where: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${where}[${index}]`));
      return;
    }
    if (!isObject(node)) {
      if (node === undefined) complain(where, "must not be undefined");
      if (typeof node === "number" && !Number.isFinite(node)) complain(where, "must be finite");
      return;
    }
    if (typeof node["$ref"] === "string") referenced.add(node["$ref"]);
    for (const [key, child] of Object.entries(node)) walk(child, `${where}.${key}`);
  };
  walk(document, "$");

  for (const reference of referenced) {
    const path = reference.split("/");
    if (path.shift() !== "#") {
      complain(reference, "must be an internal reference");
      continue;
    }
    let target: unknown = document;
    for (const segment of path) {
      target = isObject(target) ? target[segment] : undefined;
    }
    if (target === undefined) complain(reference, "does not resolve");
  }

  const operationIds = new Set<string>();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    if (!path.startsWith("/")) complain(`$.paths.${path}`, "must start with /");
    if (!isObject(item)) {
      complain(`$.paths.${path}`, "must be an object");
      continue;
    }
    for (const [method, operation] of Object.entries(item)) {
      const at = `$.paths.${path}.${method}`;
      if (!HTTP_METHODS.has(method)) complain(at, "is not an HTTP method");
      if (!isObject(operation)) {
        complain(at, "must be an object");
        continue;
      }
      const id = operation["operationId"];
      if (typeof id !== "string") complain(`${at}.operationId`, "must be a string");
      else if (operationIds.has(id)) complain(`${at}.operationId`, `duplicates "${id}"`);
      else operationIds.add(id);

      for (const parameter of (operation["parameters"] ?? []) as unknown[]) {
        if (!isObject(parameter)) {
          complain(`${at}.parameters`, "must contain objects");
          continue;
        }
        if (typeof parameter["name"] !== "string") complain(`${at}.parameters`, "needs a name");
        if (!["query", "header", "path", "cookie"].includes(parameter["in"] as string)) {
          complain(`${at}.parameters`, "needs a valid location");
        }
        if (parameter["schema"] === undefined && parameter["content"] === undefined) {
          complain(`${at}.parameters`, "needs a schema or content");
        }
      }

      const body = operation["requestBody"];
      if (body !== undefined && (!isObject(body) || !isObject(body["content"]))) {
        complain(`${at}.requestBody`, "needs a content map");
      }

      const responses = operation["responses"];
      if (!isObject(responses) || Object.keys(responses).length === 0) {
        complain(`${at}.responses`, "must be a non-empty object");
        continue;
      }
      for (const [status, response] of Object.entries(responses)) {
        const responseAt = `${at}.responses.${status}`;
        if (status !== "default" && !/^[1-5]\d{2}$/.test(status)) {
          complain(responseAt, "is not a status code or default");
        }
        if (!isObject(response) || typeof response["description"] !== "string") {
          complain(responseAt, "needs a description");
          continue;
        }
        for (const [media, body] of Object.entries(response["content"] ?? {})) {
          if (!isObject(body) || !isObject((body as Ctx).schema)) {
            complain(`${responseAt}.content.${media}`, "needs a schema object");
          }
        }
      }
    }
  }

  const schemes: Ctx = (document.components as Ctx)?.securitySchemes ?? {};
  for (const requirement of (document.security ?? []) as Ctx[]) {
    for (const scheme of Object.keys(requirement)) {
      if (schemes[scheme] === undefined) {
        complain(`$.security.${scheme}`, "is not a declared security scheme");
      }
    }
  }
  return found;
}

describe("openapi document", () => {
  test("validates as an OpenAPI 3.1 document", () => {
    const openapi = document();
    expect(violations(openapi)).toEqual([]);
    expect(openapi.openapi).toBe("3.1.1");
    expect(openapi.info).toEqual({ title: "savoria", version: "2.1.0" });
    // JSON is the only form it is ever consumed in.
    expect(violations(JSON.parse(JSON.stringify(openapi)))).toEqual([]);
  });

  test("documents exactly the exposed functions openapi allows", () => {
    const registry = new Registry(functions());
    const openapi = openApiDocument(registry, info) as Ctx;
    expect(Object.keys(openapi.paths)).toEqual([
      "/api/admin/stats",
      "/api/messages/list",
      "/api/messages/ping",
      "/api/messages/send",
      "/api/messages/tail",
    ]);
    // Hidden from the document, still callable at its path.
    expect(registry.exposed.has("/api/messages/purge")).toBe(true);
    expect(openapi.paths["/api/messages/purge"]).toBeUndefined();
    // Never exposed: absent from both.
    expect(registry.exposed.has("/api/messages/sweep")).toBe(false);
    expect(openapi.paths["/api/messages/sweep"]).toBeUndefined();
  });

  test("tags by top-level module and declares bearer authentication", () => {
    const openapi = document();
    expect(openapi.tags).toEqual([{ name: "admin" }, { name: "messages" }]);
    expect(openapi.paths["/api/admin/stats"].get.tags).toEqual(["admin"]);
    expect(openapi.components.securitySchemes.bearerAuth.type).toBe("http");
    expect(openapi.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
    expect(openapi.security).toEqual([{}, { bearerAuth: [] }]);
  });

  test("a query documents the GET args parameter and the POST body", () => {
    const list = document().paths["/api/messages/list"];
    expect(Object.keys(list)).toEqual(["get", "post"]);
    expect(list.post.operationId).toBe("messages.list");
    expect(list.get.operationId).toBe("messages.list.get");
    expect(list.get.summary).toBe("List messages");
    expect(list.post.description).toBe("List the newest messages in a channel.");

    const { $schema: _dialect, ...args } = argsJsonSchema(functions().messages.list.args);
    expect(list.get.parameters).toEqual([{
      name: "args",
      in: "query",
      required: true,
      description: expect.stringContaining("url-encoded JSON"),
      content: { "application/json": { schema: args } },
    }]);
    expect(list.post.requestBody).toEqual({
      required: true,
      content: { "application/json": { schema: args } },
    });
    expect(list.post.responses["200"].content["application/json"].schema).toEqual(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      (({ $schema, ...schema }) => schema)(
        validatorJsonSchema(functions().messages.list.returns as Ctx, { mode: "output" }),
      ),
    );
  });

  test("an argsless function's body and args parameter are optional", () => {
    const stats = document().paths["/api/admin/stats"];
    expect(stats.get.parameters[0].required).toBe(false);
    expect(stats.post.requestBody.required).toBe(false);
  });

  test("a mutation documents Idempotency-Key and every receipt header", () => {
    const send = document().paths["/api/messages/send"];
    expect(Object.keys(send)).toEqual(["post"]);
    expect(send.post.parameters).toHaveLength(1);
    expect(send.post.parameters[0].name).toBe("Idempotency-Key");
    expect(send.post.parameters[0].in).toBe("header");
    expect(send.post.parameters[0].required).toBe(false);

    const receipt = [
      "x-ackerdb-commit-version",
      "x-ackerdb-durability",
      "x-ackerdb-replay",
      "x-ackerdb-obligations",
    ];
    expect(Object.keys(send.post.responses["200"].headers)).toEqual(receipt);
    // A committed mutation answers with its receipt even when it rejected.
    expect(Object.keys(send.post.responses["409"].headers)).toEqual(receipt);
    expect(send.post.responses["200"].headers["x-ackerdb-durability"].schema.enum).toEqual([
      "production",
      "balanced",
    ]);
  });

  test("declared errors become per-status ApplicationError responses", () => {
    const send = document().paths["/api/messages/send"];
    expect(Object.keys(send.post.responses)).toEqual(["200", "409", "410", "default"]);

    const conflict = send.post.responses["409"].content["application/json"].schema;
    expect(conflict.oneOf.map((member: Ctx) => member.properties.code.const)).toEqual([
      "messages.empty",
      "messages.rateLimited",
    ]);
    expect(conflict.oneOf[0].properties.kind).toEqual({ const: "application" });
    expect(conflict.oneOf[0].properties.status).toEqual({ const: 409 });
    expect(conflict.oneOf[0].properties.body).toEqual({
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    });

    const gone = send.post.responses["410"].content["application/json"].schema;
    expect(gone.oneOf).toBeUndefined();
    expect(gone.properties.code).toEqual({ const: "messages.gone" });
    expect(send.post.responses["default"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/Outcome",
    });
  });

  test("an SSE procedure documents the frame envelope, not the bare chunk", () => {
    const tail = document().paths["/api/messages/tail"];
    expect(Object.keys(tail)).toEqual(["post"]);
    const stream = tail.post.responses["200"];
    expect(Object.keys(stream.content)).toEqual(["text/event-stream"]);

    // The surface writes frames, so the document describes frames: a receiver
    // that decoded the `yields` schema straight off an event would misparse
    // every one and never acknowledge it.
    const frames = stream.content["text/event-stream"].schema.oneOf as Ctx[];
    expect(frames.map((frame) => frame.properties.t.const)).toEqual([
      "sse_chunk",
      "sse_done",
      "sse_error",
    ]);
    for (const frame of frames) {
      expect(frame.properties.v.const).toBe(PROTOCOL_VERSION);
      expect(frame.properties.seq).toMatchObject({ type: "integer", minimum: 1 });
      expect(frame.properties.proof).toMatchObject({ type: "string" });
      expect(frame.required).toEqual(Object.keys(frame.properties));
      expect(frame.additionalProperties).toBe(false);
    }
    // The `yields` schema describes a chunk frame's `value` alone.
    expect(frames[0]!.properties.value).toEqual({
      type: "object",
      properties: { body: { type: "string" } },
      required: ["body"],
      additionalProperties: false,
    });
    expect(frames[1]!.properties.value).toBeUndefined();
    expect(frames[2]!.properties.outcome).toEqual({ $ref: "#/components/schemas/Outcome" });

    // Acknowledgement is the contract: without it the receiver reads one event
    // and stalls out, so the response says so where a client generator reads.
    expect(stream.description).toContain("sse_ack");
    expect(stream.description).toContain("/_sse/ack");
    expect(stream.description).toContain("x-ackerdb-sse-max-stall-ms");

    expect(Object.keys(stream.headers)).toEqual([
      "x-ackerdb-sse-stream",
      "x-ackerdb-sse-max-stall-ms",
    ]);
    expect(stream.headers["x-ackerdb-sse-stream"].description).toContain("/_sse/ack");
  });

  test("refuses a document where two addresses claim one operationId", () => {
    // Distinct paths, one operationId: the registry's own collision check
    // cannot see this, and codegen tools reject or silently dedupe it.
    const registry = new Registry({
      notes: {
        list: query({
          access: "public",
          http: true,
          args: {},
          handler: () => [],
        }),
      },
      "notes.list": {
        get: query({
          access: "public",
          http: true,
          args: {},
          handler: () => null,
        }),
      },
    });
    expect(registry.exposed.size).toBe(2);
    expect(() => openApiDocument(registry, info)).toThrow(
      'functions "notes.list" and "notes.list.get" both document operationId "notes.list.get"',
    );
  });

  test("a function without returns documents a flagged untyped value", () => {
    const ping = document().paths["/api/messages/ping"].post.responses["200"];
    expect(ping["x-ackerdb-untyped"]).toBe(true);
    expect(ping.description).toContain("Untyped");
    expect(ping.content["application/json"].schema).toEqual({});
  });

  test("two exports of one application are byte-identical", () => {
    const first = JSON.stringify(openApiDocument(new Registry(functions()), info));
    const second = JSON.stringify(openApiDocument(new Registry(functions()), info));
    expect(second).toBe(first);
  });

  test("an application with nothing exposed documents nothing", () => {
    const registry = new Registry({
      messages: {
        sweep: procedure({ access: "public", args: {}, handler: () => "swept" }),
      },
    });
    const openapi = openApiDocument(registry, info) as Ctx;
    expect(openapi.paths).toEqual({});
    expect(openapi.tags).toEqual([]);
    expect(violations(openapi)).toEqual([]);
  });

  test("a validator no JSON document describes names the function it came from", () => {
    // A validator no JSON boundary can carry never reaches this walk: the
    // registry refuses it when it compiles the function's HTTP codec. What is
    // left for the document to refuse is a value that crosses the wire as
    // itself and has no schema — a non-finite literal.
    const registry = new Registry({
      messages: {
        latest: query({
          access: "public",
          http: true,
          args: {},
          returns: v.literal(Number.NaN),
          handler: () => Number.NaN,
        }),
      },
    });
    expect(() => openApiDocument(registry, info)).toThrow(
      /function "messages\.latest" returns cannot be documented/,
    );
  });
});
