/**
 * The Admin API: the group the framework publishes on every application's
 * behalf, the vocabulary it authorizes itself with, and the rules that keep an
 * application from reaching either.
 */
import { describe, expect, test } from "bun:test";
import { ADMIN_API_PATH, PROTOCOL_VERSION, type Identity } from "@ackerdb/core";
import { frameworkFunctionModules } from "../../src/admin/index.ts";
import { normalizeAdminOptions } from "../../src/admin/options.ts";
import { ADMIN_SCOPES } from "../../src/admin/scopes.ts";
import { defineApp } from "../../src/app/definition.ts";
import { query } from "../../src/app/functions.ts";
import { invokeFunction } from "../../src/app/invocation.ts";
import { Registry } from "../../src/app/registry.ts";
import { mcp } from "../../src/mcp/index.ts";
import { defineSchema } from "../../src/schema/definition.ts";
import { v } from "../../src/validation/v.ts";
import {
  expandScopeGrant,
  FRAMEWORK_SCOPES,
  knownScopeVocabulary,
} from "../../src/auth/scopes.ts";
import { ANONYMOUS_PRINCIPAL, type UserPrincipal } from "../../src/auth/credentials.ts";
import { openApiDocument } from "../../src/transport/openapi.ts";
import { ACKERDB_VERSION } from "../../src/shared/version.ts";

function user(scopes: readonly string[]): UserPrincipal {
  return Object.freeze({
    kind: "user",
    identity: 1n as Identity,
    scopes: Object.freeze([...scopes]),
    issuer: "https://issuer.example/",
    subject: "operator",
    claims: Object.freeze({}),
    expiresAt: Date.now() + 60_000,
    tokenId: null,
  });
}

const SAVORIA = { application: { name: "savoria", version: "2.1.0" } };

describe("the framework's own group", () => {
  test("is registered in every application, with no manifest entry", () => {
    const registry = new Registry({});
    expect(registry.get("admin.system.info")).toBeDefined();
    expect(registry.exposed.get("/admin/system/info")?.address).toBe("admin.system.info");
    expect(defineApp({ schema: defineSchema({}) }).apiPaths).toEqual([]);
  });

  test("is shared: an application publishes beside the framework, not over it", () => {
    const audit = query({
      apiPath: ADMIN_API_PATH,
      http: true,
      access: "authenticated",
      args: {},
      handler: () => [],
    });
    const registry = new Registry({ orders: { audit } });
    expect(registry.get("admin.orders.audit")).toBeDefined();
    expect(registry.get("admin.system.info")).toBeDefined();
  });

  test("refuses an application declaration that claims a framework address", () => {
    // The group is the first segment of the address, so squatting requires
    // naming the framework's group, module and export at once — and the one
    // address space refuses it out loud instead of replacing the declaration.
    const impostor = query({
      apiPath: ADMIN_API_PATH,
      access: "public",
      args: {},
      handler: () => ({ name: "not-really" }),
    });
    expect(() => new Registry({ system: { info: impostor } })).toThrow(
      'duplicate server export address "admin.system.info"',
    );
    // The same module and export name in the default group is an ordinary
    // application function: the group is what keeps them apart.
    const ordinary = query({ access: "public", args: {}, handler: () => null });
    expect(new Registry({ system: { info: ordinary } }).get("api.system.info")).toBeDefined();
  });

  test("is not a group a manifest may list", () => {
    expect(() => defineApp({ schema: defineSchema({}), apiPaths: [ADMIN_API_PATH] })).toThrow(
      'application apiPaths must not list "admin" — every application publishes it',
    );
  });
});

describe("admin.system.info", () => {
  const info = frameworkFunctionModules(SAVORIA).system.info;

  test("answers nothing to a caller without a grant covering its scope", async () => {
    await expect(invokeFunction(info, { auth: ANONYMOUS_PRINCIPAL }, {})).rejects.toMatchObject({
      code: "unauthenticated",
    });
    await expect(invokeFunction(info, { auth: user(["notes:read"]) }, {})).rejects.toMatchObject({
      code: "unauthorized",
    });
    // A bare `*` is every application scope and never the framework's, so the
    // most generous application grant still reaches nothing here.
    await expect(
      invokeFunction(info, { auth: user(expandScopeGrant(["*"], knownScopeVocabulary(["notes:read"]))) }, {}),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  test("identifies the application to a caller that holds it", async () => {
    await expect(
      invokeFunction(info, { auth: user(["_admin:system:read"]) }, {}),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        name: "savoria",
        version: "2.1.0",
        ackerdb: ACKERDB_VERSION,
        protocol: PROTOCOL_VERSION,
      },
    });
  });

  test("is callable without appearing in the OpenAPI document", () => {
    // Every exposed function is walked into the document; publishing the whole
    // administrative surface to anyone who can fetch a schema is a map for a
    // caller who has no grant and could not use it.
    const registry = new Registry({});
    expect(registry.exposed.get("/admin/system/info")?.openapi).toBe(false);
    const document = openApiDocument(registry, { title: "savoria", version: "2.1.0" });
    expect(Object.keys(document.paths)).toEqual([]);
  });
});

describe("the framework scope vocabulary", () => {
  test("is what an administrative grant expands to", () => {
    // Empty, `["*", "_*"]` expanded to nothing and every scoped function
    // denied — an administrative credential with no authority at all.
    expect(FRAMEWORK_SCOPES.length).toBeGreaterThan(0);
    expect(FRAMEWORK_SCOPES).toEqual(ADMIN_SCOPES);
    const vocabulary = knownScopeVocabulary(["notes:read"]);
    expect(expandScopeGrant(["*", "_*"], vocabulary)).toEqual([...vocabulary]);
    expect(expandScopeGrant(["_admin:jobs:*"], vocabulary))
      .toEqual(["_admin:jobs:read", "_admin:jobs:write"]);
  });

  test("names every scope the framework's own declarations require", () => {
    const required = Object.values(frameworkFunctionModules())
      .flatMap((exports) => Object.values(exports))
      .flatMap((fn) => (fn as { readonly scopes?: { readonly scopes: readonly string[] } }).scopes?.scopes ?? []);
    expect(required.length).toBeGreaterThan(0);
    for (const scope of required) expect(FRAMEWORK_SCOPES).toContain(scope);
  });
});

describe("an application may not require a framework scope", () => {
  const borrowed = query({
    args: {},
    access: "authenticated",
    scopes: { anyOf: ["_admin:system:read"] },
    handler: () => null,
  });

  test("the runtime refuses what the generated Scope union already refuses", () => {
    // Untyped, the requirement passes the membership check — the framework's
    // names are in the same vocabulary — so the type system would say no while
    // the runtime said yes. Ownership is the test, not the name.
    expect(() => new Registry({ notes: { list: borrowed } }))
      .toThrow(/function "api\.notes\.list" requires "_admin:system:read", which belongs to the framework's own vocabulary/);
  });

  test("is refused at registration, so no host can skip it", () => {
    // The rule needs no manifest to decide, so it does not wait for the
    // manifest cross-check a programmatic host might never run.
    expect(() => new Registry({ notes: { list: borrowed } })).toThrow(TypeError);
  });

  test("publishing in the framework's group does not make a function the framework's", () => {
    const inside = query({
      apiPath: ADMIN_API_PATH,
      args: {},
      access: "authenticated",
      scopes: { anyOf: ["_admin:jobs:read"] },
      handler: () => null,
    });
    expect(() => new Registry({ ops: { purge: inside } }))
      .toThrow(/function "admin\.ops\.purge" requires "_admin:jobs:read"/);
  });

  test("an MCP tool entry is refused on the same rule", () => {
    const purge = query({
      args: {},
      access: "authenticated",
      description: "Purge the queue.",
      returns: v.int(),
      handler: () => 0,
    });
    const endpoint = mcp({
      name: "ops",
      tools: { purge: { fn: purge, access: { anyOf: ["_admin:jobs:write"] } } },
    } as never);
    expect(() => new Registry({ ops: { endpoint } }))
      .toThrow(/requires "_admin:jobs:write", which belongs to the framework's own vocabulary/);
  });

  test("the framework's own declarations require their own scopes", () => {
    expect(() => new Registry({})).not.toThrow();
    expect(() => new Registry({}).checkScopeRequirements(undefined)).not.toThrow();
    expect(() => new Registry({}).checkScopeRequirements(["notes:read"])).not.toThrow();
  });
});

describe("the admin object", () => {
  test("names the application, and says so when nothing named it", () => {
    expect(normalizeAdminOptions(SAVORIA).application).toEqual({
      name: "savoria",
      version: "2.1.0",
    });
    expect(normalizeAdminOptions().application).toEqual({
      name: "application",
      version: "0.0.0",
    });
    expect(normalizeAdminOptions({ application: { name: "savoria" } }).application)
      .toEqual({ name: "savoria", version: "0.0.0" });
  });

  test("is re-read rather than trusted", () => {
    expect(() => normalizeAdminOptions("savoria")).toThrow(/admin must be an object/);
    expect(() => normalizeAdminOptions({ application: 7 })).toThrow(
      /admin\.application must be an object/,
    );
    expect(() => normalizeAdminOptions({ application: { name: 7 } })).toThrow(
      /admin\.application\.name must be a trimmed non-empty string/,
    );
    expect(() => normalizeAdminOptions({ application: { name: " savoria" } })).toThrow(
      /admin\.application\.name must be a trimmed non-empty string/,
    );
    expect(() => normalizeAdminOptions({ application: { version: "x".repeat(129) } })).toThrow(
      /admin\.application\.version must be a trimmed non-empty string/,
    );
  });

  test("is frozen, so a host cannot rewrite what the surface reports", () => {
    const options = normalizeAdminOptions(SAVORIA);
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen(options.application)).toBe(true);
  });
});
