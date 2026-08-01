import { describe, expect, test } from "bun:test";
import { v } from "../../src/validation/v.ts";
import {
  httpExposure,
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

  test("rejects storage-only validators as chunk validators", () => {
    for (const yields of [v.primaryKey(), v.scheduleAt(), v.tag()]) {
      expect(() =>
        sseProcedure({
          args: {},
          yields,
          access: "public",
          handler: async function* () {},
        } as never),
      ).toThrow(`yields: v.${yields.kind}() is not a valid chunk validator`);
    }
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
    expect(declared).toMatchObject({ isAckerDB: true, kind: "sse" });
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
    expect(() =>
      sseProcedure({
        args: { at: v.scheduleAt() },
        yields: v.string(),
        access: "public",
        handler: async function* () {},
      } as never),
    ).toThrow("args.at: v.scheduleAt() is not a valid argument validator");
  });
});

describe("HTTP exposure declaration", () => {
  const kinds = { query, mutation, procedure } as const;

  test("stores every documented form and its surface documentation", () => {
    for (const [kind, register] of Object.entries(kinds)) {
      const exposed = register({
        args: {},
        access: "public",
        http: true,
        title: `${kind} title`,
        description: `${kind} description`,
        handler: () => null,
      });
      expect(exposed).toMatchObject({
        kind,
        http: true,
        title: `${kind} title`,
        description: `${kind} description`,
      });
      expect(httpExposure(exposed.http)).toEqual({ openapi: true });

      const hidden = register({ args: {}, access: "public", http: { openapi: false }, handler: () => null });
      expect(httpExposure(hidden.http)).toEqual({ openapi: false });

      const disabled = register({ args: {}, access: "public", http: false, handler: () => null });
      expect(httpExposure(disabled.http)).toBeNull();

      const absent = register({ args: {}, access: "public", handler: () => null });
      expect(absent.http).toBeUndefined();
      expect(httpExposure(absent.http)).toBeNull();
    }

    const stream = sseProcedure({
      args: {},
      yields: v.string(),
      access: "public",
      http: { openapi: true },
      description: "stream description",
      handler: async function* () {},
    });
    expect(httpExposure(stream.http)).toEqual({ openapi: true });
    expect(stream.description).toBe("stream description");
  });

  test("rejects every malformed exposure at registration", () => {
    for (const http of [
      "true",
      1,
      null,
      {},
      { openapi: "yes" },
      { openapi: true, extra: true },
      { openApi: true },
    ]) {
      for (const register of Object.values(kinds)) {
        expect(() =>
          register({ args: {}, access: "public", http, handler: () => null } as never),
        ).toThrow("http must be true, false, or { openapi: boolean }");
      }
      expect(() =>
        sseProcedure({
          args: {},
          yields: v.string(),
          access: "public",
          http,
          handler: async function* () {},
        } as never),
      ).toThrow("http must be true, false, or { openapi: boolean }");
    }

    for (const field of ["description", "title"] as const) {
      expect(() =>
        procedure({ args: {}, access: "public", [field]: 7, handler: () => null } as never),
      ).toThrow(`${field} must be a string`);
    }
  });
});
