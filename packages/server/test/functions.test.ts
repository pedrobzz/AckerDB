import { describe, expect, test } from "bun:test";
import { dbz } from "../src/dbz.ts";
import { sseProcedure } from "../src/functions.ts";

describe("sseProcedure declaration", () => {
  test("requires a yields chunk validator", () => {
    expect(() =>
      sseProcedure({
        args: {},
        access: "public",
        handler: async function* () {},
      } as never),
    ).toThrow("sse yields must be a dbz validator");
    expect(() =>
      sseProcedure({
        args: {},
        yields: { kind: "object" },
        access: "public",
        handler: async function* () {},
      } as never),
    ).toThrow("sse yields must be a dbz validator");
  });

  test("rejects storage-only validators as chunk validators", () => {
    for (const yields of [dbz.primaryKey(), dbz.scheduleAt(), dbz.tag()]) {
      expect(() =>
        sseProcedure({
          args: {},
          yields,
          access: "public",
          handler: async function* () {},
        } as never),
      ).toThrow(`yields: dbz.${yields.kind}() is not a valid chunk validator`);
    }
  });

  test("keeps the transport-boundary and access invariants of other kinds", () => {
    const declared = sseProcedure({
      args: { label: dbz.string() },
      yields: dbz.object({ label: dbz.string() }),
      access: "public",
      handler: async function* (_ctx, args) {
        yield { label: args.label };
      },
    });
    expect(declared).toMatchObject({ isDbzz: true, kind: "sse" });
    expect(declared.yields.kind).toBe("object");
    expect(() => (declared as unknown as () => void)()).toThrow(
      "sses cannot be called in-process",
    );
    expect(() =>
      sseProcedure({
        args: {},
        yields: dbz.string(),
        access: "everyone",
        handler: async function* () {},
      } as never),
    ).toThrow("sse access must be public, authenticated, system, or a policy callback");
    expect(() =>
      sseProcedure({
        args: { at: dbz.scheduleAt() },
        yields: dbz.string(),
        access: "public",
        handler: async function* () {},
      } as never),
    ).toThrow("args.at: dbz.scheduleAt() is not a valid argument validator");
  });
});
