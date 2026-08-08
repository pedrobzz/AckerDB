import { describe, expect, test } from "bun:test";
import type { Identity } from "@ackerdb/core";
import { defineApp } from "../../src/app/definition.ts";
import { defineSchema } from "../../src/schema/definition.ts";
import { mutation, procedure, query, sseProcedure } from "../../src/app/functions.ts";
import { invokeFunction } from "../../src/app/invocation.ts";
import { Registry } from "../../src/app/registry.ts";
import { v } from "../../src/validation/v.ts";
import {
  ANONYMOUS_PRINCIPAL,
  SYSTEM_PRINCIPAL,
  type Principal,
  type UserPrincipal,
} from "../../src/auth/credentials.ts";

function user(scopes: readonly string[]): UserPrincipal {
  return Object.freeze({
    kind: "user",
    identity: 1n as Identity,
    scopes: Object.freeze([...scopes]),
    issuer: "https://issuer.example/",
    subject: "user-1",
    claims: Object.freeze({}),
    expiresAt: Date.now() + 60_000,
    tokenId: null,
  });
}

describe("defineApp scope vocabulary", () => {
  test("declares, validates, and freezes the vocabulary", () => {
    const app = defineApp({
      schema: defineSchema({}),
      scopes: ["notes:read", "notes:write"] as const,
    });
    expect(app.scopes).toEqual(["notes:read", "notes:write"]);
    expect(Object.isFrozen(app.scopes)).toBe(true);
  });

  test("an app without scopes carries none", () => {
    const app = defineApp({ schema: defineSchema({}) });
    expect(app.scopes).toBeUndefined();
  });

  test("rejects the framework's marked names at the one declaration site", () => {
    expect(() => defineApp({
      schema: defineSchema({}),
      scopes: ["_admin:logs:read"] as const,
    })).toThrow(/framework/);
    expect(() => defineApp({
      schema: defineSchema({}),
      scopes: ["_"] as const,
    })).toThrow(/framework/);
  });

  test("rejects a wildcard in the vocabulary: patterns belong to grants", () => {
    expect(() => defineApp({
      schema: defineSchema({}),
      scopes: ["notes:*"] as const,
    })).toThrow(/wildcard/);
  });
});

describe("function scope declarations", () => {
  test("every builder registers a structurally valid requirement", () => {
    const scoped = query({
      args: {},
      access: "authenticated",
      scopes: { anyOf: ["notes:read"] },
      handler: () => null,
    });
    expect(scoped.scopes).toEqual({ anyOf: ["notes:read"] });
    expect(mutation({
      args: {},
      access: "authenticated",
      scopes: { allOf: ["notes:write"] },
      handler: () => null,
    }).scopes).toEqual({ allOf: ["notes:write"] });
    expect(procedure({
      args: {},
      access: "authenticated",
      scopes: { anyOf: ["notes:read"] },
      handler: () => null,
    }).scopes).toEqual({ anyOf: ["notes:read"] });
    expect(sseProcedure({
      args: {},
      yields: v.string(),
      access: "authenticated",
      scopes: { anyOf: ["notes:read"] },
      handler: async function* () {},
    }).scopes).toEqual({ anyOf: ["notes:read"] });
  });

  test('scopes contradict "public" and are dead under "system"', () => {
    expect(() => query({
      args: {},
      access: "public",
      scopes: { anyOf: ["notes:read"] },
      handler: () => null,
    })).toThrow(/cannot combine with access "public"/);
    expect(() => mutation({
      args: {},
      access: "system",
      scopes: { anyOf: ["notes:read"] },
      handler: () => null,
    })).toThrow(/cannot combine with access "system"/);
  });

  test("a malformed requirement is a registration error", () => {
    expect(() => query({
      args: {},
      access: "authenticated",
      scopes: { anyOf: [] } as never,
      handler: () => null,
    })).toThrow(TypeError);
    expect(() => query({
      args: {},
      access: "authenticated",
      scopes: ["notes:read"] as never,
      handler: () => null,
    })).toThrow(TypeError);
  });
});

describe("registry vocabulary cross-check", () => {
  function registryWith(fn: unknown) {
    return new Registry({ notes: { list: fn as never } });
  }
  const scoped = query({
    args: {},
    access: "authenticated",
    scopes: { anyOf: ["notes:read"] },
    handler: () => null,
  });

  test("passes when every requirement draws from the vocabulary", () => {
    expect(() => registryWith(scoped).checkScopeRequirements(["notes:read"])).not.toThrow();
  });

  test("an unscoped registry passes without a vocabulary", () => {
    const plain = query({ args: {}, access: "public", handler: () => null });
    expect(() => registryWith(plain).checkScopeRequirements(undefined)).not.toThrow();
  });

  test("rejects an undeclared scope, naming the function", () => {
    expect(() => registryWith(scoped).checkScopeRequirements(["other:read"]))
      .toThrow(/function "notes\.list" requires undeclared scope "notes:read"/);
  });

  test("an application declaring no vocabulary declares no application scope", () => {
    expect(() => registryWith(scoped).checkScopeRequirements(undefined))
      .toThrow(/requires undeclared scope "notes:read"/);
  });
});

describe("choke-point scope enforcement", () => {
  const scoped = query({
    args: {},
    access: "authenticated",
    scopes: { anyOf: ["notes:read"] },
    handler: () => "ok",
  });

  async function outcome(principal: Principal) {
    return invokeFunction(scoped, { auth: principal }, {});
  }

  test("a caller holding the scope reaches the handler", async () => {
    await expect(outcome(user(["notes:read"]))).resolves.toMatchObject({
      ok: true,
      data: "ok",
    });
  });

  test("a caller without the scope is denied unauthorized", async () => {
    await expect(outcome(user(["notes:write"]))).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  test("an anonymous caller is denied unauthenticated", async () => {
    await expect(outcome(ANONYMOUS_PRINCIPAL)).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  test("system authority bypasses scopes", async () => {
    await expect(outcome(SYSTEM_PRINCIPAL)).resolves.toMatchObject({
      ok: true,
      data: "ok",
    });
  });

  test("allOf denies a partial grant and passes a complete one", async () => {
    const both = query({
      args: {},
      access: "authenticated",
      scopes: { allOf: ["notes:read", "notes:write"] },
      handler: () => "ok",
    });
    await expect(invokeFunction(both, { auth: user(["notes:read"]) }, {}))
      .rejects.toMatchObject({ code: "unauthorized" });
    await expect(invokeFunction(both, { auth: user(["notes:read", "notes:write"]) }, {}))
      .resolves.toMatchObject({ ok: true });
  });

  test("the scope check runs after an async access policy resolves", async () => {
    let policyRan = false;
    const guarded = query({
      args: {},
      access: async () => {
        policyRan = true;
        return true;
      },
      scopes: { anyOf: ["notes:read"] },
      handler: () => "ok",
    });
    await expect(invokeFunction(guarded, { auth: user([]) }, {}))
      .rejects.toMatchObject({ code: "unauthorized" });
    expect(policyRan).toBe(true);
  });
});
