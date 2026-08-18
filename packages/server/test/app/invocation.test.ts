import { describe, expect, test } from "bun:test";
import { testRegistry } from "ackerdb-test-support/server";
import type { Database } from "bun:sqlite";
import { Err, Failure, Status } from "@ackerdb/core";
import { ANONYMOUS_PRINCIPAL } from "../../src/auth/credentials.ts";
import { v } from "../../src/validation/v.ts";
import { AckerDBError } from "../../src/shared/errors.ts";
import { mutation, query } from "../../src/app/functions.ts";
import { invokeFunction } from "../../src/app/invocation.ts";
import { Registry } from "../../src/app/registry.ts";
import { newWriteCollector } from "../../src/database/access.ts";
import { createMutationInvocationScope } from "../../src/runtime/mutation-scope.ts";

describe("registered invocation", () => {
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
      "SAVEPOINT ackerdb_result_1",
      "ROLLBACK TO ackerdb_result_1",
      "RELEASE ackerdb_result_1",
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
    const registry = testRegistry({ messages: { list: exported } });

    expect(registry.addressOf(exported)).toBe("api.messages.list");
    expect(registry.addressOf(unexported)).toBeUndefined();
    expect(Reflect.ownKeys(exported)).toEqual(ownKeys);
  });

  test("rejects aliases for one registered function object", () => {
    const shared = query({ args: {}, access: "public", handler: () => null });
    expect(() => testRegistry({
      first: { value: shared },
      second: { alias: shared },
    })).toThrow(
      'one definition is exported as both "first.value" from "<test:0:first>" and "second.alias" from "<test:0:second>"',
    );
  });
});
