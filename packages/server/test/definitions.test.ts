import { describe, expect, test } from "bun:test";
import {
  channel,
  declareJobs,
  http,
  job,
  mutation,
  procedure,
  query,
  Registry,
  sseProcedure,
  v,
} from "@ackerdb/server";

function definitions() {
  return {
    find: query({ args: {}, access: "public", handler: () => null }),
    change: mutation({ args: {}, access: "public", handler: () => null }),
    run: procedure({ args: {}, access: "public", handler: () => null }),
    stream: sseProcedure({
      args: {},
      yields: v.string(),
      access: "public",
      handler: async function* () {},
    }),
    hook: http("/hooks/test", { POST: () => new Response(null) }),
    background: job({ mode: "mutation", args: {}, handler: () => null }),
    chat: channel({
      args: {},
      clientEvents: {},
      serverEvents: {},
      access: "public",
      on: {},
    }),
  };
}

describe("server definitions", () => {
  test("routes every factory result through its kind", () => {
    const { background, ...functions } = definitions();
    const httpDefinitions: unknown[] = [];
    const registry = new Registry(
      { definitions: functions },
      (definition) => httpDefinitions.push(definition),
    );

    expect(registry.get("api.definitions.find")?.kind).toBe("query");
    expect(registry.get("api.definitions.change")?.kind).toBe("mutation");
    expect(registry.get("api.definitions.run")?.kind).toBe("procedure");
    expect(registry.get("api.definitions.stream")?.kind).toBe("sse");
    expect(httpDefinitions).toMatchObject([{ kind: "http" }]);
    expect(registry.getChannel("api.definitions.chat")?.kind).toBe("channel");
    expect(declareJobs({ definitions: { background } })).toMatchObject([
      { name: "definitions.background", job: { kind: "job", mode: "mutation" } },
    ]);
  });

  test("keeps kind as the sole identity discriminator", () => {
    const declared = definitions();
    for (const definition of Object.values(declared)) {
      expect(Object.hasOwn(definition, "kind")).toBe(true);
      expect(Object.hasOwn(definition, "isAckerDB")).toBe(false);
      expect(Object.hasOwn(definition, "isAckerDBServerOnly")).toBe(false);
      expect(Object.hasOwn(definition, "isAckerDBChannel")).toBe(false);
    }
    expect(Object.getOwnPropertySymbols(declared.background)).toEqual([]);
  });

  test("refuses unknown kinds at each module-loading boundary", () => {
    const unknown = { kind: "unknown" };
    expect(() => new Registry({ definitions: { unknown } })).toThrow(
      'function module export "definitions.unknown" has unknown definition kind "unknown"',
    );
    expect(() => declareJobs({ definitions: { unknown } })).toThrow(
      'job module export "definitions.unknown" has unknown definition kind "unknown"',
    );
  });
});
