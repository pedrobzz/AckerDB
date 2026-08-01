import { describe, expect, test } from "bun:test";
import { Err, Status } from "@ackerdb/core";
import { v, ValidationError, type Validator } from "../../src/validation/v.ts";
import { procedure, query } from "../../src/app/functions.ts";
import { mcp, mcpAuth } from "../../src/mcp/index.ts";
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
      'HTTP-exposed function "_internal.echo" claims AckerDB-owned path "/api/_internal/echo"; "/api/_" is reserved',
    );
    // Only the reserved prefix is AckerDB's; deeper segments belong to the app.
    expect(() => new Registry({ notes: { _echo: exposed } })).not.toThrow();
  });

  test("refuses a path claimed by both a function and an MCP endpoint, in either order", () => {
    const endpoint = mcp({
      name: "agent",
      auth: mcpAuth({ name: "agent" }),
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
