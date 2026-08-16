import { describe, expect, test } from "bun:test";
import { Err, Status } from "@ackerdb/core";
import { ValidationError } from "../../src/validation/error.ts";
import type { Validator } from "../../src/validation/validator.ts";
import { v } from "../../src/validation/v.ts";
import { procedure, query } from "../../src/app/functions.ts";
import { http } from "../../src/transport/routing/route.ts";
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

const unexposed = procedure({
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

const hook = http("/api/hooks/stripe", { POST: () => new Response(null) });

describe("HTTP-exposed function paths", () => {
  test("maps address segments to path segments and keeps unexposed functions out", () => {
    const registry = new Registry({
      messages: { list: listing, unexposed },
      "admin.messages": { purge: hidden },
      notes: { echo: exposed },
    });

    // Every route is the application's: the framework registers none.
    expect([...registry.exposed.keys()].sort()).toEqual([
      "api.admin.messages.purge",
      "api.messages.list",
      "api.notes.echo",
    ]);
    const echo = registry.exposed.get("api.notes.echo");
    expect(echo).toMatchObject({
      address: "api.notes.echo",
      path: "/api/notes/echo",
      openapi: true,
    });
    expect(echo?.fn).toBe(registry.get("api.notes.echo")!);
    expect(registry.exposed.get("api.admin.messages.purge")).toMatchObject({
      address: "api.admin.messages.purge",
      openapi: false,
    });
    expect(registry.exposed.get("api.messages.unexposed")).toBeUndefined();
    expect(registry.get("api.messages.unexposed")).toBe(unexposed);
  });

  test("refuses the AckerDB-owned module prefix", () => {
    expect(() => new Registry({ _internal: { echo: exposed } })).toThrow(
      'HTTP-exposed function "api._internal.echo" claims AckerDB-owned path "/api/_internal/echo"',
    );
    // Only the reserved prefix is AckerDB's; deeper segments belong to the app.
    expect(() => new Registry({ notes: { _echo: exposed } })).not.toThrow();
    // A raw route claims its explicit path through the same check.
    const reserved = { ...hook, path: "/_ws" } as never;
    expect(() => new Registry({ hooks: { reserved } })).toThrow(
      'http route "api.hooks.reserved" claims AckerDB-owned path "/_ws"',
    );
    const underApi = { ...hook, path: "/api/_internal/hook" } as never;
    expect(() => new Registry({ hooks: { underApi } })).toThrow(
      'http route "api.hooks.underApi" claims AckerDB-owned path "/api/_internal/hook"',
    );
    // The operational endpoints carry no marker — they are named by the
    // outside world — so the built-in list is what keeps an application off
    // them, and one refusal covers both kinds of AckerDB path.
    const probe = { ...hook, path: "/live" } as never;
    expect(() => new Registry({ hooks: { probe } })).toThrow(
      'http route "api.hooks.probe" claims AckerDB-owned path "/live"',
    );
  });

  test("owns the root the protocol endpoints moved to, and nothing deeper", () => {
    // The protocol endpoints all live behind the marker at the root, and the
    // operational ones deliberately do not — the reserved-name list is what
    // keeps an application route off `/live`, `/ready`, and `/status`.
    for (const path of ["/_ws", "/_sse/ack", "/_files/x", "/_openapi.json"]) {
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

    // One reservation, applied wherever a path is claimed: the root, and the
    // segment directly beneath the fixed application root.
    expect(claimsReservedName("/api/_files")).toBe(true);
    expect(claimsReservedName("/_ws")).toBe(true);
    expect(claimsReservedName("/_private/tools")).toBe(true);
    expect(claimsReservedName("/api/notes/_echo")).toBe(false);
    expect(claimsReservedName("/api/my_notes")).toBe(false);
    // An explicit raw path owns its second segment: only `/api/` reserves it,
    // because only there does a future built-in route derive from an address.
    expect(claimsReservedName("/webhooks/_raw")).toBe(false);
  });

  test("refuses two addresses projecting onto one path", () => {
    // Unique addresses do not imply unique paths: the projection joins on `/`
    // where the address joined on `.`, and a string-named export may contain
    // either. Two functions with two access policies at one URL would
    // otherwise be settled by whichever was registered second.
    expect(() =>
      new Registry({ notes: { ["echo/deep"]: exposed }, "notes.echo": { deep: listing } })
    ).toThrow(
      'HTTP-exposed function "api.notes.echo.deep" and "api.notes.echo/deep" both claim path "/api/notes/echo/deep"',
    );
    // A raw route meets the same check: explicit paths are claimed after
    // derived ones, so one check covers both orders and both kinds.
    const collide = { ...hook, path: "/api/notes/echo/deep" } as never;
    expect(() =>
      new Registry({ notes: { ["echo/deep"]: exposed }, "notes.echo": { collide } })
    ).toThrow(
      'http route "api.notes.echo.collide" and "api.notes.echo/deep" both claim path "/api/notes/echo/deep"',
    );
  });

  test("refuses a malformed http field from an untyped export", () => {
    const untyped = { ...exposed, http: { openapi: "yes" } } as never;
    expect(() => new Registry({ notes: { untyped } })).toThrow(
      'function "api.notes.untyped" http must be true, false, or { openapi: boolean }',
    );
  });

  test("refuses an exposure whose kind no HTTP method serves", () => {
    // The narrowed kind is what the listener and the document both read, so an
    // unservable exposure fails the load rather than becoming a 404 at call time
    // and a silent omission from the document.
    const untyped = { ...exposed, kind: "queryy" } as never;
    expect(() => new Registry({ notes: { untyped } })).toThrow(
      'HTTP-exposed function "api.notes.untyped" is a queryy, which the HTTP surface does not serve',
    );
    // Unexposed, no HTTP surface reads its kind and the load stands.
    const internalKind = { ...exposed, kind: "queryy", http: false } as never;
    expect(() => new Registry({ notes: { internalKind } })).not.toThrow();
  });
});

describe("application-owned raw routes", () => {
  test("claims its explicit path outside the function and exposed maps", () => {
    const registry = new Registry({ hooks: { stripe: hook } });

    expect(registry.httpRoutes).toMatchObject([
      { address: "api.hooks.stripe", http: { path: "/api/hooks/stripe" } },
    ]);
    // The registry serves its own validated snapshot; the handler it calls is
    // the exported one.
    expect(registry.httpRoutes[0]!.http.handlers.POST).toBe(hook.handlers.POST);
    expect(registry.kindOf("api.hooks.stripe")).toBe("http");
    // Not a contract function: it is neither addressable nor exposed.
    expect(registry.get("api.hooks.stripe")).toBeUndefined();
    expect(registry.exposed.get("api.hooks.stripe")).toBeUndefined();
  });

  test("owns a path outside the application root, because a provider dictated it", () => {
    const root = http("/webhooks/:provider/callback", { GET: () => new Response(null) });
    const registry = new Registry({ hooks: { root } });

    expect(registry.httpRoutes[0]!.http.path).toBe("/webhooks/:provider/callback");
  });

  test("refuses an untyped export missing the client-erasure marker", () => {
    // Generated client APIs erase the export by isAckerDBServerOnly; a value
    // without it would register a live route while leaking a client reference.
    const { isAckerDBServerOnly: _erased, ...rest } = hook;
    const unmarked = rest as never;
    expect(() => new Registry({ hooks: { unmarked } })).toThrow(
      'http route "hooks.unmarked" must carry isAckerDBServerOnly: true',
    );
  });

  test("serves the validated snapshot, not the exported object", () => {
    // A value whose fields change after registration — a getter that answers
    // twice, or a mutated handler map — must not change what the surface
    // serves: every field is read once, at registration, and copied.
    const handlers: Record<string, unknown> = { POST: () => new Response(null) };
    const mutable = {
      isAckerDB: true,
      isAckerDBServerOnly: true,
      kind: "http",
      path: "/api/hooks/mutable",
      handlers,
    };
    const registry = new Registry({ hooks: { mutable: mutable as never } });
    const route = registry.httpRoutes[0]!.http;

    handlers.POST = null;
    handlers.GET = () => new Response(null);
    expect(Object.keys(route.handlers)).toEqual(["POST"]);
    expect(typeof route.handlers.POST).toBe("function");
    expect(Object.isFrozen(route)).toBe(true);
    expect(Object.isFrozen(route.handlers)).toBe(true);
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
      path: "/api/hooks/shifty",
      handlers: {
        get POST() {
          reads++;
          return reads === 1 ? () => new Response(null) : ("not a function" as never);
        },
      },
    };
    const registry = new Registry({ hooks: { shifty: shifty as never } });
    expect(typeof registry.httpRoutes[0]!.http.handlers.POST).toBe("function");
  });
});

describe("the http factory", () => {
  test("refuses a malformed path, in the same words the compiler uses", () => {
    const handlers = { GET: () => new Response(null) };
    expect(() => http("nope" as never, handlers)).toThrow(
      'http path "nope" must start with "/"',
    );
    expect(() => http("/a//b" as never, handlers)).toThrow(
      'http path "/a//b" may not contain an empty segment',
    );
    expect(() => http("/a/*/b" as never, handlers)).toThrow(
      'http path "/a/*/b" may only use "*" as the last segment',
    );
    expect(() => http("/:id/:id" as never, handlers)).toThrow(
      'http path "/:id/:id" names ":id" twice',
    );
    expect(() => http("/a/:" as never, handlers)).toThrow(
      'http path "/a/:" has a ":" that names no parameter',
    );
    expect(() => http("/a/**" as never, handlers)).toThrow(
      'http path "/a/**" segment "**" is neither static text, ":name", nor the terminal "*"',
    );
  });

  test("refuses a malformed method map", () => {
    expect(() => http("/a", {})).toThrow("http handlers must name at least one HTTP method");
    expect(() => http("/a", { TRACE: () => new Response(null) } as never)).toThrow(
      'http handlers key "TRACE" must be one of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    );
    expect(() => http("/a", { POST: null } as never)).toThrow(
      'http handler for "POST" must be a function',
    );
    expect(() => http("/a", null as never)).toThrow(
      "http handlers must be an object keyed by HTTP method",
    );
  });

  test("refuses a field nothing consumes, so an expectation is never ignored", () => {
    const extra = { ...hook, access: "public" } as never;
    expect(() => new Registry({ hooks: { extra } })).toThrow(
      'http route "hooks.extra" must not declare "access"',
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
    const { codec } = new Registry({ notes: { roundTrip } }).exposed.get("api.notes.roundTrip")!;

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
    const { codec } = new Registry({ notes: { untyped } }).exposed.get("api.notes.untyped")!;

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
    const { codec } = new Registry({ notes: { foreign } }).exposed.get("api.notes.foreign")!;

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
      /HTTP-exposed function "api\.notes\.unrepresentable" returns cannot cross the HTTP surface's standard-JSON boundary: .*v\.primaryKey\(\) is not a standard-JSON value/,
    );
    // Unexposed, the same contract is only the WebSocket protocol's business.
    expect(() => new Registry({ notes: { unrepresentable: { ...unrepresentable, http: false } } }))
      .not.toThrow();
  });
});
