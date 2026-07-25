import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "bun:sqlite";
import { Err, Failure, Status } from "@dbzz/core";
import { ANONYMOUS_PRINCIPAL, type UserPrincipal } from "../../src/auth/credentials.ts";
import { v } from "../../src/validation/v.ts";
import { DbzzError } from "../../src/shared/errors.ts";
import { mutation, query } from "../../src/app/functions.ts";
import {
  invokeFunction,
  withInvocationObserver,
  type InvocationObservation,
  type InvocationPhaseScope,
} from "../../src/app/invocation.ts";
import { Registry } from "../../src/app/registry.ts";
import { newWriteCollector } from "../../src/database/access.ts";
import { createMutationInvocationScope } from "../../src/runtime/mutation-scope.ts";

function user(): UserPrincipal {
  return Object.freeze({
    kind: "user",
    identity: 1n as UserPrincipal["identity"],
    issuer: "https://issuer.example/",
    subject: "user-1",
    claims: Object.freeze({}),
    expiresAt: Date.now() + 60_000,
    tokenId: null,
  });
}

describe("invocation instrumentation", () => {
  test("normalizes raw success and explicit application errors at the registered boundary", async () => {
    const success = query({
      args: { value: v.string() },
      access: "public",
      handler: (_ctx, args) => ({ echoed: args.value }),
    });
    const failure = query({
      args: { value: v.string() },
      access: "public",
      handler: (_ctx, args) =>
        Err("value-rejected", { value: args.value }, Status.UnprocessableContent),
    });

    await expect(success(
      { auth: ANONYMOUS_PRINCIPAL },
      { value: "accepted" },
    )).resolves.toMatchObject({
      ok: true,
      data: { echoed: "accepted" },
    });
    await expect(failure(
      { auth: ANONYMOUS_PRINCIPAL },
      { value: "rejected" },
    )).resolves.toMatchObject({
      ok: false,
      error: {
        code: "value-rejected",
        body: { value: "rejected" },
        status: 422,
      },
    });
  });

  test("validates optional success and error declarations without requiring either", async () => {
    const strict = query({
      args: { fail: v.boolean() },
      returns: v.object({ value: v.string() }),
      errors: {
        "value-rejected": {
          body: v.object({ reason: v.string() }),
          status: Status.UnprocessableContent,
        },
      },
      access: "public",
      handler: (_ctx, { fail }) =>
        fail
          ? Err("value-rejected", { reason: "requested" }, Status.UnprocessableContent)
          : { value: "accepted" },
    });
    const undeclared = query({
      args: {},
      errors: {
        declared: { body: v.object({}), status: Status.BadRequest },
      },
      access: "public",
      handler: () => Err("other", {}, Status.BadRequest),
    } as any);
    const invalidSuccess = query({
      args: {},
      returns: v.object({ value: v.string() }),
      access: "public",
      handler: () => ({ value: 1 } as unknown as { value: string }),
    });
    const invalidFailure = query({
      args: {},
      access: "public",
      handler: () => Failure(new Error("unexpected")),
    } as any);

    await expect(strict(
      { auth: ANONYMOUS_PRINCIPAL },
      { fail: false },
    )).resolves.toMatchObject({ ok: true, data: { value: "accepted" } });
    await expect(strict(
      { auth: ANONYMOUS_PRINCIPAL },
      { fail: true },
    )).resolves.toMatchObject({
      ok: false,
      error: { code: "value-rejected", body: { reason: "requested" }, status: 422 },
    });
    await expect(undeclared(
      { auth: ANONYMOUS_PRINCIPAL },
      {},
    )).rejects.toThrow('errors does not declare returned code "other"');
    await expect(invalidSuccess(
      { auth: ANONYMOUS_PRINCIPAL },
      {},
    )).rejects.toThrow("returns.value");
    await expect(invalidFailure(
      { auth: ANONYMOUS_PRINCIPAL },
      {},
    )).rejects.toThrow("registered Err must contain an application error");
  });

  test("compiles one strict presence-preserving argument shape", async () => {
    const shape = {
      required: v.string(),
      optional: v.string().optional(),
      nullish: v.string().nullish(),
      ["__proto__"]: v.string().optional(),
    };
    const fn = query({
      args: shape,
      access: "public",
      handler: (_ctx, args) => args,
    });
    const input: Record<string, unknown> = {
      required: "set",
      optional: undefined,
      ignored: undefined,
    };
    Object.defineProperty(input, "__proto__", {
      enumerable: true,
      value: "kept",
    });

    const args = (await fn({ auth: ANONYMOUS_PRINCIPAL }, input as never)).data as Record<string, unknown>;
    expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
    expect(Object.hasOwn(args, "optional")).toBe(true);
    expect(Object.hasOwn(args, "nullish")).toBe(false);
    expect(Object.hasOwn(args, "ignored")).toBe(false);
    expect(Object.hasOwn(args, "__proto__")).toBe(true);
    expect(args["__proto__"]).toBe("kept");

    await expect(fn(
      { auth: ANONYMOUS_PRINCIPAL },
      { required: "set", toString: "unknown" } as never,
    )).rejects.toThrow('args: unknown field "toString"');

    (shape as Record<string, unknown>)["addedLater"] = v.string();
    await expect(fn(
      { auth: ANONYMOUS_PRINCIPAL },
      { required: "set", addedLater: "must stay unknown" } as never,
    )).rejects.toThrow('args: unknown field "addedLater"');
  });

  test("rejects constrained arguments before policy and handler execution", async () => {
    let policyCalls = 0;
    let handlerCalls = 0;
    const constrained = query({
      args: { slug: v.string().min(2).regex(/^[a-z]+$/) },
      access: () => {
        policyCalls++;
        return true;
      },
      handler: () => {
        handlerCalls++;
        return "unreachable";
      },
    });

    await expect(constrained(
      { auth: ANONYMOUS_PRINCIPAL },
      { slug: "1" },
    )).rejects.toThrow("args.slug");
    expect(policyCalls).toBe(0);
    expect(handlerCalls).toBe(0);
  });

  test("observes top-level and nested phases with deterministic parent metadata", async () => {
    const child = query({
      args: { value: v.string() },
      access: "public",
      handler: (_ctx, args) => `child:${args.value}`,
    });
    const parent = query({
      args: { value: v.string() },
      access: "public",
      handler: (ctx, args) => child(ctx, args),
    });
    const registry = new Registry({ functions: { parent, child } });
    const observations: InvocationObservation[] = [];

    const result = await withInvocationObserver(
      (observation) => {
        observations.push(observation);
      },
      () => parent({ auth: ANONYMOUS_PRINCIPAL }, { value: "private-value" }),
    );

    expect(result.data).toBe("child:private-value");
    expect(observations.map((observation) => ({
      function: registry.addressOf(observation.fn),
      invocationId: observation.invocationId,
      parentInvocationId: observation.parentInvocationId,
      depth: observation.depth,
      phase: observation.phase,
      outcome: observation.outcome,
    }))).toEqual([
      { function: "functions.parent", invocationId: 1, parentInvocationId: undefined, depth: 0, phase: "auth", outcome: "ok" },
      { function: "functions.parent", invocationId: 1, parentInvocationId: undefined, depth: 0, phase: "policy", outcome: "ok" },
      { function: "functions.child", invocationId: 2, parentInvocationId: 1, depth: 1, phase: "auth", outcome: "ok" },
      { function: "functions.child", invocationId: 2, parentInvocationId: 1, depth: 1, phase: "policy", outcome: "ok" },
      { function: "functions.child", invocationId: 2, parentInvocationId: 1, depth: 1, phase: "handler", outcome: "ok" },
      { function: "functions.parent", invocationId: 1, parentInvocationId: undefined, depth: 0, phase: "handler", outcome: "ok" },
    ]);
    for (const observation of observations) {
      expect(Object.isFrozen(observation)).toBe(true);
      expect(Number.isFinite(observation.durationMs)).toBe(true);
      expect(observation.durationMs).toBeGreaterThanOrEqual(0);
      expect(Object.keys(observation)).not.toContain("args");
      expect(Object.keys(observation)).not.toContain("principal");
      expect(Object.keys(observation)).not.toContain("error");
      expect(Object.values(observation)).not.toContain("private-value");
    }
  });

  test("reports validation, policy denial, and handler failure without protected details", async () => {
    const validation = query({
      args: { value: v.string() },
      access: "public",
      handler: () => "unreachable",
    });
    const denied = query({
      args: {},
      access: () => false,
      handler: () => "unreachable",
    });
    const failing = query({
      args: {},
      access: "public",
      handler: () => {
        throw new DbzzError("conflict", "private handler detail");
      },
    });

    const validationObservations: InvocationObservation[] = [];
    await expect(withInvocationObserver(
      (observation) => {
        validationObservations.push(observation);
      },
      () => validation({ auth: ANONYMOUS_PRINCIPAL }, { value: 1 as never }),
    )).rejects.toThrow();
    expect(validationObservations.map(({ phase, outcome }) => ({ phase, outcome }))).toEqual([
      { phase: "auth", outcome: "validation" },
    ]);

    const denialObservations: InvocationObservation[] = [];
    await expect(withInvocationObserver(
      (observation) => {
        denialObservations.push(observation);
      },
      () => denied({ auth: user() }, {}),
    )).rejects.toMatchObject({ code: "unauthorized" });
    expect(denialObservations.map(({ phase, outcome }) => ({ phase, outcome }))).toEqual([
      { phase: "auth", outcome: "ok" },
      { phase: "policy", outcome: "unauthorized" },
    ]);

    const failureObservations: InvocationObservation[] = [];
    await expect(withInvocationObserver(
      (observation) => {
        failureObservations.push(observation);
      },
      () => failing({ auth: user() }, {}),
    )).rejects.toMatchObject({ code: "conflict", message: "private handler detail" });
    expect(failureObservations.map(({ phase, outcome }) => ({ phase, outcome }))).toEqual([
      { phase: "auth", outcome: "ok" },
      { phase: "policy", outcome: "ok" },
      { phase: "handler", outcome: "conflict" },
    ]);
    expect(Object.keys(failureObservations.at(-1)!)).not.toContain("error");
  });

  test("observer failures are fail-open and observer scope does not leak", async () => {
    const fn = query({
      args: {},
      access: "public",
      handler: () => "ok",
    });
    let synchronousCalls = 0;
    expect((await withInvocationObserver(() => {
      synchronousCalls += 1;
      throw new Error("observer failed");
    }, () => fn({ auth: ANONYMOUS_PRINCIPAL }, {}))).data).toBe("ok");
    expect(synchronousCalls).toBe(3);

    let asynchronousCalls = 0;
    expect((await withInvocationObserver(() => {
      asynchronousCalls += 1;
      return Promise.reject(new Error("async observer failed"));
    }, () => fn({ auth: ANONYMOUS_PRINCIPAL }, {}))).data).toBe("ok");
    await Promise.resolve();
    expect(asynchronousCalls).toBe(3);

    expect((await fn({ auth: ANONYMOUS_PRINCIPAL }, {})).data).toBe("ok");
    expect(synchronousCalls).toBe(3);
    expect(asynchronousCalls).toBe(3);
  });

  test("runs observer callbacks outside the instrumentation scope", async () => {
    let probeCalls = 0;
    const probe = query({
      args: {},
      access: "public",
      handler: () => {
        probeCalls += 1;
        return "probe";
      },
    });
    const fn = query({ args: {}, access: "public", handler: () => "ok" });
    const observations: InvocationObservation[] = [];
    let probeWork: ReturnType<typeof probe> | undefined;

    expect((await withInvocationObserver((observation) => {
      observations.push(observation);
      probeWork ??= probe({ auth: ANONYMOUS_PRINCIPAL }, {});
    }, () => fn({ auth: ANONYMOUS_PRINCIPAL }, {}))).data).toBe("ok");
    expect((await probeWork!).data).toBe("probe");

    expect(probeCalls).toBe(1);
    expect(observations).toHaveLength(3);
    expect(observations.every((observation) => observation.fn === fn)).toBe(true);
  });

  test("runs phase work and observations inside the matching caller scope", async () => {
    const active = new AsyncLocalStorage<Readonly<InvocationPhaseScope>>();
    const handlerScopes: Readonly<InvocationPhaseScope>[] = [];
    const observedScopes: Readonly<InvocationPhaseScope>[] = [];
    const child = query({
      args: {},
      access: "public",
      handler: () => {
        handlerScopes.push(active.getStore()!);
        return "child";
      },
    });
    const parent = query({
      args: {},
      access: "public",
      handler: async (ctx) => {
        handlerScopes.push(active.getStore()!);
        return child(ctx, {});
      },
    });

    expect((await withInvocationObserver(
      () => {
        observedScopes.push(active.getStore()!);
      },
      () => parent({ auth: ANONYMOUS_PRINCIPAL }, {}),
      (scope, work) => active.run(scope, work),
    )).data).toBe("child");

    expect(handlerScopes.map(({ invocationId, phase }) => [invocationId, phase])).toEqual([
      [1, "handler"],
      [2, "handler"],
    ]);
    expect(observedScopes.map(({ invocationId, phase }) => [invocationId, phase])).toEqual([
      [1, "auth"],
      [1, "policy"],
      [2, "auth"],
      [2, "policy"],
      [2, "handler"],
      [1, "handler"],
    ]);
    expect(observedScopes.every(Object.isFrozen)).toBe(true);
  });

  test("a returned Err closes its registered mutation scope without poisoning its caller", async () => {
    const child = mutation({
      args: {},
      access: "public",
      handler: () => Err("stock-unavailable", {}, Status.Conflict),
    });
    const parent = mutation({
      args: {},
      access: "public",
      handler: async (ctx) => {
        const result = await child(ctx, {});
        return result.ok ? "unexpected" : "queued";
      },
    });
    const statements: string[] = [];
    const scope = createMutationInvocationScope({
      exec(statement: string) {
        statements.push(statement);
      },
    } as unknown as Database, newWriteCollector());

    const result = await scope.runRoot((mutationAccess) =>
      invokeFunction(
        parent as never,
        { auth: ANONYMOUS_PRINCIPAL } as never,
        {},
        { mutationAccess },
      ));

    expect(result).toMatchObject({ ok: true, data: "queued" });
    expect(statements).toEqual([
      "SAVEPOINT dbzz_result_1",
      "ROLLBACK TO dbzz_result_1",
      "RELEASE dbzz_result_1",
    ]);
  });

  test("a throw crossing a nested registered boundary poisons the root invocation", async () => {
    const failure = new Error("storage failed");
    const child = mutation({
      args: {},
      access: "public",
      handler: () => {
        throw failure;
      },
    });
    const parent = mutation({
      args: {},
      access: "public",
      handler: async (ctx) => {
        try {
          await child(ctx, {});
        } catch {
          return "claimed success";
        }
        return "unreachable";
      },
    });

    await expect(parent({ auth: ANONYMOUS_PRINCIPAL } as never, {})).rejects.toBe(failure);
  });
});

describe("Registry function identity", () => {
  test("resolves stable addresses without mutating registered functions", () => {
    const exported = query({ args: {}, access: "public", handler: () => null });
    const unexported = query({ args: {}, access: "public", handler: () => null });
    const ownKeys = Reflect.ownKeys(exported);
    const registry = new Registry({ messages: { list: exported } });

    expect(registry.addressOf(exported)).toBe("messages.list");
    expect(registry.addressOf(unexported)).toBeUndefined();
    expect(Reflect.ownKeys(exported)).toEqual(ownKeys);
  });

  test("rejects aliases for one registered function object", () => {
    const shared = query({ args: {}, access: "public", handler: () => null });
    expect(() => new Registry({
      first: { value: shared },
      second: { alias: shared },
    })).toThrow('registered function is exported at both "first.value" and "second.alias"');
  });
});
