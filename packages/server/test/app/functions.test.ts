import { describe, expect, test } from "bun:test";
import { v } from "../../src/validation/v.ts";
import {
  mutation,
  procedure,
  query,
  sseProcedure,
} from "../../src/app/functions.ts";

describe("sseProcedure declaration", () => {
  test("requires a yields chunk validator", () => {
    expect(() =>
      sseProcedure({
        args: {},
        access: "public",
        handler: async function* () {},
      } as never),
    ).toThrow("sse yields must be a v validator");
    expect(() =>
      sseProcedure({
        args: {},
        yields: { kind: "object" },
        access: "public",
        handler: async function* () {},
      } as never),
    ).toThrow("sse yields must be a v validator");
  });

  test("accepts JSON-representable storage validators", () => {
    const primaryKeys = sseProcedure({
      args: {},
      yields: v.primaryKey(),
      access: "public",
      handler: async function* () {
        yield 1n;
      },
    });
    const schedule = sseProcedure({
      args: {},
      yields: v.scheduleAt(),
      access: "public",
      handler: async function* () {
        yield 1;
      },
    });
    expect(v.primaryKey().encode(1n)).toBe("1");
    expect(schedule.yields.encode(1)).toBe(1);
  });

  test("keeps the transport-boundary and access invariants of other kinds", () => {
    const declared = sseProcedure({
      args: { label: v.string() },
      yields: v.object({ label: v.string() }),
      access: "public",
      handler: async function* (_ctx, args) {
        yield { label: args.label };
      },
    });
    expect(declared).toMatchObject({ kind: "sse" });
    expect(declared.yields.kind).toBe("object");
    expect(() => (declared as unknown as () => void)()).toThrow(
      "sses cannot be called in-process",
    );
    expect(() =>
      sseProcedure({
        args: {},
        yields: v.string(),
        access: "everyone",
        handler: async function* () {},
      } as never),
    ).toThrow("sse access must be public, authenticated, system, or a policy callback");
    const scheduled = sseProcedure({
      args: { at: v.scheduleAt(), id: v.primaryKey() },
      yields: v.string(),
      access: "public",
      handler: async function* () {},
    });
    expect(scheduled.args.decode({ at: 1.5, id: "7" })).toEqual({ at: 1.5, id: 7n });
  });
});

describe("HTTP exposure declaration", () => {
  const kinds = { query, mutation, procedure } as const;

  test("stores every documented form and its surface documentation", () => {
    for (const [kind, register] of Object.entries(kinds)) {
      const path = `/${kind}`;
      const exposed = register({
        args: {},
        access: "public",
        http: { path, openapi: true },
        title: `${kind} title`,
        description: `${kind} description`,
        handler: () => null,
      });
      expect(exposed).toMatchObject({
        kind,
        http: { path, openapi: true },
        title: `${kind} title`,
        description: `${kind} description`,
      });
      expect(Object.isFrozen(exposed.http)).toBe(true);

      const hidden = register({
        args: {},
        access: "public",
        http: { path: `/hidden-${kind}`, openapi: false },
        handler: () => null,
      });
      expect(hidden.http).toEqual({ path: `/hidden-${kind}`, openapi: false });

      const absent = register({ args: {}, access: "public", handler: () => null });
      expect(absent.http).toBeUndefined();
    }

    const stream = sseProcedure({
      args: {},
      yields: v.string(),
      access: "public",
      http: { path: "/stream", openapi: true },
      description: "stream description",
      handler: async function* () {},
    });
    expect(stream.http).toEqual({ path: "/stream", openapi: true });
    expect(stream.description).toBe("stream description");
  });

  test("rejects every malformed exposure at registration", () => {
    for (const http of [
      true,
      false,
      "true",
      1,
      null,
      {},
      { path: "/notes" },
      { openapi: "yes" },
      { path: "/notes", openapi: true, extra: true },
      { openApi: true },
    ]) {
      for (const register of Object.values(kinds)) {
        expect(() =>
          register({ args: {}, access: "public", http, handler: () => null } as never),
        ).toThrow("http must be { path: string, openapi: boolean }");
      }
      expect(() =>
        sseProcedure({
          args: {},
          yields: v.string(),
          access: "public",
          http,
          handler: async function* () {},
        } as never),
      ).toThrow("http must be { path: string, openapi: boolean }");
    }

    for (const path of ["notes", "/notes/:id", "/notes/*", "/_internal"]) {
      expect(() =>
        query({
          args: {},
          access: "public",
          http: { path, openapi: true },
          handler: () => null,
        }),
      ).toThrow();
    }

    for (const field of ["description", "title"] as const) {
      expect(() =>
        procedure({ args: {}, access: "public", [field]: 7, handler: () => null } as never),
      ).toThrow(`${field} must be a string`);
    }
  });
});
