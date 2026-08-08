/**
 * API paths (ADR-0023): the group a function is published in — the first
 * segment of its address, deciding its generated binding and its HTTP root
 * together — and deciding nothing about admission, which stays `access`'s
 * alone.
 */
import { describe, expect, test } from "bun:test";
import { ANONYMOUS_PRINCIPAL, SYSTEM_PRINCIPAL } from "../../src/auth/credentials.ts";
import { v } from "../../src/validation/v.ts";
import { mutation, procedure, query, sseProcedure } from "../../src/app/functions.ts";
import { httpHandler } from "../../src/app/http-handler.ts";
import { channel } from "../../src/channels/definition.ts";
import { realtime } from "../../src/realtime/definition.ts";
import { mcp } from "../../src/mcp/index.ts";
import { Registry } from "../../src/app/registry.ts";
import { applicationAddresses, applicationRoutes } from "ackerdb-test-support/framework-functions";

describe("apiPath declarations", () => {
  test("defaults to the api group on every kind that owns an HTTP root", () => {
    for (const build of [query, mutation, procedure]) {
      expect(build({ access: "public", args: {}, handler: () => null }).apiPath).toBe("api");
    }
    expect(
      sseProcedure({
        access: "public",
        args: {},
        yields: v.string(),
        handler: async function* () {},
      }).apiPath,
    ).toBe("api");
    expect(
      httpHandler({ methods: ["GET"], handler: () => new Response() }).apiPath,
    ).toBe("api");
  });

  test("carries the declared group onto the registered function", () => {
    for (const build of [query, mutation, procedure]) {
      const fn = build({
        apiPath: "internal",
        access: "public",
        args: {},
        handler: () => null,
      });
      expect(fn.apiPath).toBe("internal");
    }
  });

  test("refuses a group beginning with the reserved marker", () => {
    expect(() =>
      query({ apiPath: "_admin", access: "public", args: {}, handler: () => null }),
    ).toThrow('"_" is reserved to AckerDB');
    expect(() =>
      httpHandler({ apiPath: "_x", methods: ["GET"], handler: () => new Response() }),
    ).toThrow('"_" is reserved to AckerDB');
  });

  test("refuses a group that is not one path segment", () => {
    for (const bad of ["", "a/b", "admin.tools", "9lives", "-x", 7]) {
      expect(() =>
        query({ apiPath: bad as never, access: "public", args: {}, handler: () => null }),
      ).toThrow("query apiPath must be a name starting with a letter");
    }
  });

  test("refuses a group that cannot also be a binding name", () => {
    for (const reserved of ["class", "default", "await", "yield", "new", "eval", "arguments"]) {
      expect(() =>
        query({ apiPath: reserved as never, access: "public", args: {}, handler: () => null }),
      ).toThrow(`must not be "${reserved}"`);
    }
  });

  test("refuses a field no declaration consumes, including the retired internal flag", () => {
    expect(() =>
      query({ internal: true, access: "public", args: {}, handler: () => null } as never),
    ).toThrow('query must not declare "internal"');
    expect(() =>
      procedure({ acess: "public", access: "public", args: {}, handler: () => null } as never),
    ).toThrow('procedure must not declare "acess"');
    expect(() =>
      sseProcedure({
        internal: true,
        access: "public",
        args: {},
        yields: v.string(),
        handler: async function* () {},
      } as never),
    ).toThrow('sse must not declare "internal"');
  });

  test("refuses apiPath on socket-addressed kinds", () => {
    expect(() =>
      channel({
        apiPath: "internal",
        access: "public",
        args: {},
        clientEvents: {},
        serverEvents: {},
        authorization: () => true,
      } as never),
    ).toThrow("cannot declare apiPath");
    expect(() =>
      realtime({
        apiPath: "internal",
        access: "public",
        args: {},
        clientEvents: {},
        serverEvents: {},
        clientStreams: {},
        serverStreams: {},
        authorization: () => true,
      } as never),
    ).toThrow("cannot declare apiPath");
  });

  test("a group and HTTP exposure on one declaration is not a contradiction", () => {
    const fn = procedure({
      apiPath: "internal",
      http: true,
      access: "public",
      args: {},
      handler: () => null,
    });
    const registry = new Registry({ messages: { compact: fn } }, ["internal"]);
    expect(applicationRoutes(registry)).toEqual(["/internal/messages/compact"]);
  });
});

describe("the HTTP root a group owns", () => {
  const list = query({ http: true, access: "public", args: {}, handler: () => [] });
  const compact = query({
    apiPath: "internal",
    http: true,
    description: "Compact the message index.",
    access: "public",
    args: {},
    returns: v.array(v.string()),
    handler: () => [],
  });
  const audit = query({
    apiPath: "admin",
    http: true,
    access: "system",
    args: {},
    handler: () => [],
  });

  test("serves each function under the root its group names", () => {
    const registry = new Registry({ messages: { list, compact, audit } }, ["internal"]);
    expect(applicationRoutes(registry)).toEqual([
      "/admin/messages/audit",
      "/api/messages/list",
      "/internal/messages/compact",
    ]);
  });

  test("refuses a group the manifest does not declare", () => {
    // A misspelled group is the case this catches: it would otherwise serve a
    // live route whose binding nobody can import, because code generation
    // reads the manifest and never the function modules.
    expect(() => new Registry({ messages: { compact } }, [])).toThrow(
      'function "messages.compact" declares apiPath "internal", which the application manifest does not list in apiPaths',
    );
    expect(() => new Registry({ messages: { compact } }, ["internal"])).not.toThrow();
    // Unexposed functions are checked too: a group decides the binding as much
    // as the route.
    const unexposed = query({
      apiPath: "internal",
      access: "public",
      args: {},
      handler: () => [],
    });
    expect(() => new Registry({ messages: { unexposed } }, [])).toThrow(
      "which the application manifest does not list",
    );
    // Omitting the argument declares no group beyond the default rather than
    // waiving the rule: the check has no off switch.
    expect(() => new Registry({ messages: { compact } })).toThrow(
      "which the application manifest does not list",
    );
  });

  test("re-interprets an untyped export's group instead of routing it", () => {
    // A hand-built export reaches the same interpreter the builder applies:
    // a malformed group is a registration error, and an absent one is the
    // default — never a live route at `/undefined/...`.
    const malformed = { ...list, apiPath: "_admin" } as never;
    expect(() => new Registry({ messages: { list: malformed } })).toThrow(
      'function "messages.list" apiPath must be a name starting with a letter',
    );
    const { apiPath: _absent, ...bare } = list as unknown as Record<string, unknown>;
    const registry = new Registry({ messages: { list: bare as never } });
    expect(applicationRoutes(registry)).toEqual(["/api/messages/list"]);
  });

  test("a raw handler hangs under its own group too", () => {
    const hook = httpHandler({
      apiPath: "internal",
      methods: ["POST"],
      handler: () => new Response(),
    });
    const registry = new Registry({ stripe: { hook } }, ["internal"]);
    expect([...registry.httpRoutes.keys()]).toEqual(["/internal/stripe/hook"]);
  });

  test("every registered function resolves at the address its group begins", () => {
    const registry = new Registry({ messages: { list, compact } }, ["internal"]);
    expect(registry.get("api.messages.list")).toBe(list as never);
    expect(registry.get("internal.messages.compact")).toBe(compact as never);
    // The group is not an alias: neither function answers under the other's.
    expect(registry.get("messages.list")).toBeUndefined();
    expect(registry.get("internal.messages.list")).toBeUndefined();
    expect(registry.get("api.messages.compact")).toBeUndefined();
  });

  test("two groups hold one trailing name without colliding", () => {
    // This is what the group buys by being part of the address: one module
    // path and one export name in two groups are two functions at two
    // addresses and two routes, so neither group can squat the other's names.
    const grouped = { ...list, apiPath: "internal" } as never;
    const registry = new Registry({ messages: { list, grouped } }, ["internal"]);
    expect(applicationAddresses(registry))
      .toEqual(["api.messages.list", "internal.messages.grouped"]);
    expect(applicationRoutes(registry))
      .toEqual(["/api/messages/list", "/internal/messages/grouped"]);
  });

  test("the group is declared on the function, never inferred from a directory", () => {
    // An application may keep a `functions/admin/` folder in the default
    // group: the first directory segment is a module name, and only `apiPath`
    // names a group.
    const registry = new Registry({ "admin.messages": { list } });
    expect(applicationAddresses(registry)).toEqual(["api.admin.messages.list"]);
    expect(applicationRoutes(registry)).toEqual(["/api/admin/messages/list"]);
  });

  test("an MCP tools record may name a function from any group", () => {
    const endpoint = mcp({
      name: "admin",
      path: "/mcp/admin",
      tools: { list_index: { fn: compact, access: "public" } },
    });
    const registry = new Registry({
      messages: { list, compact },
      tools: { endpoint },
    }, ["internal"]);
    expect(registry.mcpTool("admin", "list_index")?.fn).toBe(compact as never);
  });
});

describe("composition through a callee in another group", () => {
  test("still validates args and the callee's access policy", async () => {
    const guarded = mutation({
      apiPath: "internal",
      access: "system",
      args: { value: v.string() },
      handler: (_ctx, args) => args.value,
    });

    // The system principal is admitted; the anonymous principal is not — the
    // group changes the address, never the admission decision.
    await expect(
      guarded({ auth: SYSTEM_PRINCIPAL } as never, { value: "ok" }),
    ).resolves.toMatchObject({ ok: true, data: "ok" });
    await expect(
      guarded({ auth: ANONYMOUS_PRINCIPAL } as never, { value: "ok" }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(
      guarded({ auth: SYSTEM_PRINCIPAL } as never, { value: 7 as never }),
    ).rejects.toThrow("args.value: expected string, got number");
  });
});
