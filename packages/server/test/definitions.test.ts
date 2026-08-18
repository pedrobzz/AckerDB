import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AckerDBServer,
  Engine,
  PRODUCTION_LIMITS,
  Runtime,
  channel,
  defineSchema,
  http,
  job,
  mutation,
  procedure,
  query,
  reconcile,
  sseProcedure,
  v,
} from "@ackerdb/server";
import { testDefinitions } from "ackerdb-test-support/server";

test("registers every factory result with its real owner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-definitions-"));
  const engine = new Engine(defineSchema({}), join(directory, "data.db"));
  reconcile(engine);
  const server = new AckerDBServer({ limits: PRODUCTION_LIMITS, port: 0 });
  const registry = server.registerDefinitions(testDefinitions({
    definitions: {
      find: query({ args: {}, access: "public", handler: () => null }),
      change: mutation({ args: {}, access: "public", handler: () => null }),
      run: procedure({ args: {}, access: "public", handler: () => null }),
      stream: sseProcedure({
        args: {},
        yields: v.string(),
        access: "public",
        handler: async function* () {},
      }),
      hook: http("/hooks/test", { POST: () => new Response(null, { status: 204 }) }),
      background: job({ mode: "mutation", args: {}, handler: () => null }),
      chat: channel({
        args: {},
        clientEvents: {},
        serverEvents: {},
        access: "public",
        on: {},
      }),
    },
  }));
  const runtime = new Runtime({ engine, registry, limits: PRODUCTION_LIMITS });
  try {
    expect([...registry.functions.values()].map(({ kind }) => kind)).toEqual([
      "mutation",
      "query",
      "procedure",
      "sse",
    ]);
    expect(registry.getChannel("api.definitions.chat")?.kind).toBe("channel");
    expect(registry.getJob("definitions.background")?.kind).toBe("job");

    await runtime.start();
    server.activate(runtime);
    expect((await fetch(`http://127.0.0.1:${server.port}/hooks/test`, {
      method: "POST",
    })).status).toBe(204);
  } finally {
    await server.drain().catch(() => {});
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  }
});
