import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@ackerdb/core";
import { ANONYMOUS_PRINCIPAL } from "../../src/auth/credentials.ts";
import { Engine } from "../../src/database/engine.ts";
import {
  mutation,
  procedure,
  query,
  type MutationBuilder,
  type ProcedureBuilder,
  type QueryBuilder,
} from "../../src/app/functions.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { RuntimeHttpResponse } from "../../src/runtime/contracts/requests.ts";
import { defineSchema } from "../../src/schema/definition.ts";
import type { SessionRuntimeContext } from "../../src/subscriptions/session/contract.ts";
import { mutationMessage, queryMessage, request } from "../support/credential-fixture.ts";
import { testHttpCodec } from "../support/http.ts";

const cleanups: Array<() => Promise<void>> = [];
const schema = defineSchema({});
const typedMutation = mutation as MutationBuilder<typeof schema>;
const typedProcedure = procedure as ProcedureBuilder<typeof schema>;
const typedQuery = query as QueryBuilder<typeof schema>;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function bareRuntime(): Promise<{ readonly runtime: Runtime; readonly session: SessionRuntimeContext }> {
  const list = typedQuery({
    access: "public",
    args: {},
    handler: (ctx) => ctx.credentials.query().collect(),
  });
  const create = typedMutation({
    access: "public",
    args: {},
    handler: (ctx) => ctx.credentials.issue({ name: "hidden", metadata: {} }),
  });
  const transact = typedProcedure({
    access: "public",
    http: true,
    args: {},
    handler: (ctx) => ctx.tx((tx) => tx.credentials.query().collect()),
  });
  const registry = new Registry({ ordinary: { create, list, transact } });

  const directory = mkdtempSync(join(tmpdir(), "ackerdb-owner-scope-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const runtime = new Runtime({ engine, registry });
  await runtime.start();
  const session = Object.freeze({
    clientSessionId: "owner-scope",
    principal: ANONYMOUS_PRINCIPAL,
    fairnessKey: "test:owner-scope",
    authEpoch: 0,
    signal: new AbortController().signal,
    publish: async () => true,
  });
  cleanups.push(async () => {
    await runtime.drain().catch(() => {});
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  });
  return { runtime, session };
}

describe("owner-scoped credential operations", () => {
  test("bind everywhere, and refuse a caller with no user Identity to own", async () => {
    const { runtime, session } = await bareRuntime();
    await runtime.openSession(session);

    await expect(runtime.query(
      session,
      request(queryMessage(1, "api.ordinary.list")),
    )).rejects.toMatchObject({
      code: "unauthenticated",
      message: "owner-scoped credential operations require a user identity",
    });
    await expect(runtime.mutation(
      session,
      request(mutationMessage(2, "2", {}, "api.ordinary.create")),
    )).rejects.toMatchObject({
      code: "unauthenticated",
      message: "owner-scoped credential operations require a user identity",
    });

    const response = await runtime.runProcedure({
      id: 3,
      address: "api.ordinary.transact",
      args: {},
      codec: testHttpCodec,
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }: RuntimeHttpResponse) => new Response(body, { status }),
    });
    expect(decode(await response.text())).toMatchObject({
      code: "unauthenticated",
      message: "owner-scoped credential operations require a user identity",
    });
  });
});
