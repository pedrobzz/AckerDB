import { describe, expect, test } from "bun:test";
import { v } from "../../src/validation/v.ts";
import { sseProcedure } from "../../src/app/functions.ts";

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
