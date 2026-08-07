import { describe, expect, test } from "bun:test";
import { Err, Status } from "@ackerdb/core";
import { ValidationError } from "../../src/validation/error.ts";
import type { Validator } from "../../src/validation/validator.ts";
import { v } from "../../src/validation/v.ts";
import { procedure, query } from "../../src/app/functions.ts";
import { httpHandler } from "../../src/app/http-handler.ts";
import { mcp } from "../../src/mcp/index.ts";
import {
  ACKERDB_HTTP_ROUTES,
  claimsReservedName,
  isAckerDBHttpRoute,
} from "../../src/transport/http-surface.ts";
import { Registry } from "../../src/app/registry.ts";

const exposed = procedure({
  access: "public",
  http: true,
  args: { value: v.string() },
  handler: (_ctx, args) => args.value,
});

const hidden = procedure({
  access: "public",
  http: { openapi: false },
  args: {},
  handler: () => null,
});

const internal = procedure({
  access: "public",
  args: {},
  handler: () => null,
});

const listing = query({
  access: "public",
  http: true,
  args: {},
  handler: () => [],
});

describe("HTTP-exposed function paths", () => {
  test("maps address segments to path segments and keeps unexposed functions out", () => {
    const registry = new Registry({
      messages: { list: listing, internal },
      "admin.messages": { purge: hidden },
      notes: { echo: exposed },
    });

    expect([...registry.exposed.keys()]).toEqual([
      "/api/admin/messages/purge",
      "/api/messages/list",
      "/api/notes/echo",
    ]);
    const echo = registry.exposed.get("/api/notes/echo");
    expect(echo).toMatchObject({
      address: "notes.echo",
      path: "/api/notes/echo",
      openapi: true,
    });
    expect(echo?.fn).toBe(registry.get("notes.echo")!);
    expect(registry.exposed.get("/api/admin/messages/purge")).toMatchObject({
      address: "admin.messages.purge",
      openapi: false,
    });
    expect(registry.exposed.get("/api/messages/internal")).toBeUndefined();
    expect(registry.get("messages.internal")).toBe(internal);
  });

  test("refuses the AckerDB-owned module prefix", () => {
    expect(() => new Registry({ _internal: { echo: exposed } })).toThrow(
      'HTTP-exposed function "_internal.echo" claims AckerDB-owned path "/api/_internal/echo"; "_" is reserved to AckerDB',
    );
    // Only the reserved prefix is AckerDB's; deeper segments belong to the app.
    expect(() => new Registry({ notes: { _echo: exposed } })).not.toThrow();
    // The reservation is the marker, not the `/api/` root: it holds in every
    // group, which is what keeps a future built-in route collision-free.
    const grouped = { ...exposed, apiPath: "internal" } as never;
    expect(() => new Registry({ _internal: { echo: grouped } }, ["internal"])).toThrow(
      'claims AckerDB-owned path "/internal/_internal/echo"; "_" is reserved to AckerDB',
    );
  });

  test("owns the root the protocol endpoints moved to, and nothing deeper", () => {
    // The protocol endpoints all live behind the marker at the root, and the
    // operational ones deliberately do not — the reserved-name list is what
    // keeps an application route off `/live`, `/ready`, and `/status`.
    for (const path of ["/_ws", "/_sse/ack", "/_realtime", "/_files/x", "/_openapi.json"]) {
      expect(isAckerDBHttpRoute(path)).toBe(true);
    }
    for (const operational of [
      ACKERDB_HTTP_ROUTES.live,
      ACKERDB_HTTP_ROUTES.ready,
      ACKERDB_HTTP_ROUTES.status,
    ]) {
      expect(operational.startsWith("/_")).toBe(false);
      expect(isAckerDBHttpRoute(operational)).toBe(true);
    }

    // One reservation, applied wherever a path is claimed: the group, the
    // module namespace under it, and an MCP endpoint's free-form path alike.
    expect(claimsReservedName("/api/_realtime")).toBe(true);
    expect(claimsReservedName("/_ws")).toBe(true);
    expect(claimsReservedName("/mcp/_private")).toBe(true);
    expect(claimsReservedName("/api/notes/_echo")).toBe(false);
    expect(claimsReservedName("/mcp/my_endpoint")).toBe(false);
  });

  test("refuses an MCP endpoint reaching into a marked name", () => {
    // `/api/_realtime` holds no framework route any more, but the marker is
    // still AckerDB's — and the rule cannot hold for functions while lapsing
    // for the one surface that picks its path by hand.
    const squatter = mcp({
      name: "squatter",
      path: "/api/_realtime",
      tools: {},
    });
    expect(() => new Registry({ mcp: { squatter } })).toThrow(
      'MCP "squatter" path "/api/_realtime" claims a "_"-marked name reserved to AckerDB',
    );
    // A path that really is a built-in route says so instead.
    const collider = mcp({
      name: "collider",
      path: "/_ws",
      tools: {},
    });
    expect(() => new Registry({ mcp: { collider } })).toThrow(
      'MCP "collider" path "/_ws" collides with AckerDB route "/_ws"',
    );
  });

  test("refuses a path claimed by both a function and an MCP endpoint, in either order", () => {
    const endpoint = mcp({
      name: "agent",
      path: "/api/notes/echo",
      tools: {},
    });
    const message = 'HTTP-exposed function "notes.echo" and MCP "agent" both use path "/api/notes/echo"';

    expect(() => new Registry({ notes: { echo: exposed }, mcp: { endpoint } })).toThrow(message);
    expect(() => new Registry({ mcp: { endpoint }, notes: { echo: exposed } })).toThrow(message);
    expect(() => new Registry({ notes: { echo: internal }, mcp: { endpoint } })).not.toThrow();
  });

  test("refuses a malformed http field from an untyped export", () => {
    const untyped = { ...exposed, http: { openapi: "yes" } } as never;
    expect(() => new Registry({ notes: { untyped } })).toThrow(
      'function "notes.untyped" http must be true, false, or { openapi: boolean }',
    );
  });

  test("refuses an exposure whose kind no HTTP method serves", () => {
    // The narrowed kind is what the listener and the document both read, so an
    // unservable exposure fails the load rather than becoming a 404 at call time
    // and a silent omission from the document.
    const untyped = { ...exposed, kind: "queryy" } as never;
    expect(() => new Registry({ notes: { untyped } })).toThrow(
      'HTTP-exposed function "notes.untyped" is a queryy, which the HTTP surface does not serve',
    );
    // Unexposed, no HTTP surface reads its kind and the load stands.
    const internalKind = { ...exposed, kind: "queryy", http: false } as never;
    expect(() => new Registry({ notes: { internalKind } })).not.toThrow();
  });
});

describe("raw http handler routes", () => {
  const hook = httpHandler({ methods: ["POST"], handler: () => new Response(null) });

  test("claims its address-derived path outside the function and exposed maps", () => {
    const registry = new Registry({ hooks: { stripe: hook } });

    const route = registry.httpRoutes.get("/api/hooks/stripe");
    expect(route).toMatchObject({ address: "hooks.stripe", path: "/api/hooks/stripe" });
    // The route serves the registry's own validated snapshot; the handler it
    // calls is the exported one.
    expect(route?.fn.handler).toBe(hook.handler);
    expect(route?.fn.methods).toEqual(["POST"]);
    expect(registry.httpHandler("hooks.stripe")).toBe(route?.fn);
    // Not a contract function: it is neither addressable nor exposed.
    expect(registry.get("hooks.stripe")).toBeUndefined();
    expect(registry.exposed.get("/api/hooks/stripe")).toBeUndefined();
  });

  test("refuses the AckerDB-owned module prefix", () => {
    expect(() => new Registry({ _internal: { hook } })).toThrow(
      'http handler "_internal.hook" claims AckerDB-owned path "/api/_internal/hook"; "_" is reserved to AckerDB',
    );
  });

  test("refuses a path claimed by both a handler and an MCP endpoint, in either order", () => {
    const endpoint = mcp({
      name: "agent",
      path: "/api/hooks/stripe",
      tools: {},
    });
    const message = 'http handler "hooks.stripe" and MCP "agent" both use path "/api/hooks/stripe"';

    expect(() => new Registry({ hooks: { stripe: hook }, mcp: { endpoint } })).toThrow(message);
    expect(() => new Registry({ mcp: { endpoint }, hooks: { stripe: hook } })).toThrow(message);
  });

  test("refuses one handler exported at two addresses", () => {
    expect(() => new Registry({ hooks: { stripe: hook, again: hook } })).toThrow(
      'registered http handler is exported at both "hooks.again" and "hooks.stripe"',
    );
  });

  test("refuses a malformed shape from an untyped export", () => {
    const badMethod = { ...hook, methods: ["POST", "FETCH"] } as never;
    expect(() => new Registry({ hooks: { badMethod } })).toThrow(
      'http handler "hooks.badMethod" methods[1] must be one of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    );
    const noHandler = { ...hook, handler: "later" } as never;
    expect(() => new Registry({ hooks: { noHandler } })).toThrow(
      'http handler "hooks.noHandler" handler must be a function',
    );
  });

  test("refuses an untyped export missing the client-erasure marker", () => {
    // Generated client APIs erase the export by isAckerDBServerOnly; a value
    // without it would register a live route while leaking a client reference.
    const { isAckerDBServerOnly: _erased, ...rest } = hook;
    const unmarked = rest as never;
    expect(() => new Registry({ hooks: { unmarked } })).toThrow(
      'http handler "hooks.unmarked" must carry isAckerDBServerOnly: true',
    );
  });

  test("serves the validated snapshot, not the exported object", () => {
    // A value whose fields change after registration — a getter that answers
    // twice, or a mutated methods array — must not change what the surface
    // serves: every field is read once, at registration, and copied.
    const mutable = {
      isAckerDB: true,
      isAckerDBServerOnly: true,
      kind: "http",
      methods: ["POST"],
      handler: () => new Response(null),
    };
    const registry = new Registry({ hooks: { mutable: mutable as never } });
    const route = registry.httpRoutes.get("/api/hooks/mutable")!;

    mutable.methods[0] = "TRACE";
    mutable.handler = null as never;
    expect(route.fn.methods).toEqual(["POST"]);
    expect(typeof route.fn.handler).toBe("function");
    expect(Object.isFrozen(route.fn)).toBe(true);
  });

  test("stores the handler it type-checked, not a second read of the field", () => {
    // An accessor that answers a function once and something else afterwards
    // would otherwise pass validation and put a non-function into a live
    // route: the field must be read exactly once and that value kept.
    let reads = 0;
    const shifty = {
      isAckerDB: true,
      isAckerDBServerOnly: true,
      kind: "http",
      methods: ["POST"],
      get handler() {
        reads++;
        return reads === 1 ? () => new Response(null) : ("not a function" as never);
      },
    };
    const registry = new Registry({ hooks: { shifty: shifty as never } });
    expect(typeof registry.httpRoutes.get("/api/hooks/shifty")!.fn.handler).toBe("function");
  });

  test("refuses a shape hiding fields behind non-enumerable keys", () => {
    // An array carries a non-enumerable `length`; Object.keys would miss it.
    const arrayShaped = Object.assign([], {
      isAckerDB: true,
      isAckerDBServerOnly: true,
      kind: "http",
      methods: ["POST"],
      handler: () => new Response(null),
    });
    expect(() => new Registry({ hooks: { arrayShaped: arrayShaped as never } })).toThrow(
      'http handler "hooks.arrayShaped" must not declare "length"',
    );
  });

  test("refuses fields no raw handler consumes", () => {
    const withAccess = { ...hook, access: "public" } as never;
    expect(() => new Registry({ hooks: { withAccess } })).toThrow(
      'http handler "hooks.withAccess" must not declare "access"',
    );
    expect(() =>
      httpHandler({ methods: ["POST"], handler: () => new Response(null), description: "x" } as never)
    ).toThrow('httpHandler must not declare "description"');
  });
});

describe("the httpHandler builder", () => {
  test("refuses malformed methods", () => {
    const handler = () => new Response(null);
    expect(() => httpHandler({ methods: [], handler })).toThrow(
      "httpHandler methods must be a non-empty array of HTTP methods",
    );
    expect(() => httpHandler({ methods: "POST" as never, handler })).toThrow(
      "httpHandler methods must be a non-empty array of HTTP methods",
    );
    expect(() => httpHandler({ methods: ["POST", "TRACE" as never], handler })).toThrow(
      "httpHandler methods[1] must be one of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    expect(() => httpHandler({ methods: ["POST", "POST"], handler })).toThrow(
      'httpHandler methods must not repeat "POST"',
    );
  });

  test("refuses a non-function handler", () => {
    expect(() => httpHandler({ methods: ["POST"], handler: null as never })).toThrow(
      "httpHandler handler must be a function",
    );
  });
});

describe("the exposed surface's standard-JSON codec", () => {
  /** Compiled once here, so a contract that cannot cross fails the load. */
  test("carries a declared contract in both directions", () => {
    const roundTrip = procedure({
      access: "public",
      http: true,
      args: { rank: v.bigint(), blob: v.bytes() },
      returns: v.object({ rank: v.bigint(), blob: v.bytes() }),
      errors: { "notes.gone": { body: v.object({ at: v.bigint() }), status: Status.Gone } },
      handler: (_ctx, args) => Err("notes.gone", { at: args.rank }, Status.Gone),
    });
    const { codec } = new Registry({ notes: { roundTrip } }).exposed.get("/api/notes/roundTrip")!;

    expect(codec.decodeArgs({ rank: "12", blob: "AQI=" })).toEqual({
      rank: 12n,
      blob: new Uint8Array([1, 2]),
    });
    expect(codec.encodeValue({ rank: 12n, blob: new Uint8Array([1, 2]) })).toEqual({
      rank: "12",
      blob: "AQI=",
    });
    expect(codec.encodeError({
      kind: "application",
      code: "notes.gone",
      body: { at: 7n },
      status: 410,
    })).toEqual({ kind: "application", code: "notes.gone", body: { at: "7" }, status: 410 });
  });

  test("maps an undeclared value onto the same JSON a declared one crosses as", () => {
    const untyped = procedure({
      access: "public",
      http: true,
      args: {},
      handler: () => ({ id: 9n, blob: new Uint8Array([255]) }),
    });
    const { codec } = new Registry({ notes: { untyped } }).exposed.get("/api/notes/untyped")!;

    expect(codec.encodeValue({ id: 9n, blob: new Uint8Array([255]) }))
      .toEqual({ id: "9", blob: "/w==" });
    // A "$" key is an ordinary key here: this surface is plain JSON, never the
    // Protocol-2 wire format that escapes one.
    expect(codec.encodeValue({ $: "b" })).toEqual({ $: "b" });
  });

  test("carries a validator AckerDB did not build structurally, check and all", () => {
    // The AI-stream shape: a hand-written Validator whose kind AckerDB has no
    // mapping for. AckerDB cannot describe it, so it does not pretend to — the
    // values cross structurally and the validator alone says what is valid.
    const opaque: Validator<{ readonly id: bigint }, "opaque"> = {
      kind: "opaque",
      check(value, path) {
        if (typeof (value as { id?: unknown }).id !== "bigint") {
          throw new ValidationError(`${path}.id: expected a bigint`);
        }
        return value as { readonly id: bigint };
      },
      tsType: () => "{ id: bigint }",
      descriptor: () => ({ k: "opaque" }),
    };
    const foreign = procedure({
      access: "public",
      http: true,
      args: {},
      returns: opaque,
      handler: () => ({ id: 3n }),
    });
    const { codec } = new Registry({ notes: { foreign } }).exposed.get("/api/notes/foreign")!;

    expect(codec.encodeValue({ id: 3n })).toEqual({ id: "3" });
    expect(() => codec.encodeValue({ id: "3" })).toThrow(/expected a bigint/);
  });

  test("refuses a contract no standard-JSON boundary can carry, at registration", () => {
    const unrepresentable = query({
      access: "public",
      http: true,
      args: {},
      returns: v.primaryKey(),
      handler: () => 1n,
    });
    expect(() => new Registry({ notes: { unrepresentable } })).toThrow(
      /HTTP-exposed function "notes\.unrepresentable" returns cannot cross the HTTP surface's standard-JSON boundary: .*v\.primaryKey\(\) is not a standard-JSON value/,
    );
    // Unexposed, the same contract is only the WebSocket protocol's business.
    expect(() => new Registry({ notes: { unrepresentable: { ...unrepresentable, http: false } } }))
      .not.toThrow();
  });
});
