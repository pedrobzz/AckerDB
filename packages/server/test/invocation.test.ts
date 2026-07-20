import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { ANONYMOUS_PRINCIPAL, type UserPrincipal } from "../src/auth.ts";
import { v } from "../src/v.ts";
import { DbzzError } from "../src/errors.ts";
import { query } from "../src/functions.ts";
import {
  withInvocationObserver,
  type InvocationObservation,
  type InvocationPhaseScope,
} from "../src/invocation.ts";
import { Registry } from "../src/registry.ts";

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

    expect(result).toBe("child:private-value");
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
    expect(await withInvocationObserver(() => {
      synchronousCalls += 1;
      throw new Error("observer failed");
    }, () => fn({ auth: ANONYMOUS_PRINCIPAL }, {}))).toBe("ok");
    expect(synchronousCalls).toBe(3);

    let asynchronousCalls = 0;
    expect(await withInvocationObserver(() => {
      asynchronousCalls += 1;
      return Promise.reject(new Error("async observer failed"));
    }, () => fn({ auth: ANONYMOUS_PRINCIPAL }, {}))).toBe("ok");
    await Promise.resolve();
    expect(asynchronousCalls).toBe(3);

    expect(await fn({ auth: ANONYMOUS_PRINCIPAL }, {})).toBe("ok");
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
    let probeWork: Promise<string> | undefined;

    expect(await withInvocationObserver((observation) => {
      observations.push(observation);
      probeWork ??= probe({ auth: ANONYMOUS_PRINCIPAL }, {});
    }, () => fn({ auth: ANONYMOUS_PRINCIPAL }, {}))).toBe("ok");
    expect(await probeWork!).toBe("probe");

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

    expect(await withInvocationObserver(
      () => {
        observedScopes.push(active.getStore()!);
      },
      () => parent({ auth: ANONYMOUS_PRINCIPAL }, {}),
      (scope, work) => active.run(scope, work),
    )).toBe("child");

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
