/**
 * Rotating the credential you are authenticated with, once per door.
 *
 * The whole operation is one transaction that mints a replacement and revokes
 * the old master, so the revocation reaches the very connection carrying the
 * new plaintext. Each test therefore asserts both halves: the new secret
 * arrives, and the old one is refused immediately afterwards. A door that
 * published the revocation from inside the commit would fail the first half,
 * and a door that never published it would fail the second.
 */
import { parseReceivedFrame } from "ackerdb-test-support/client-transport";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACKERDB_VERSION,
  decode,
  encode,
  parseServerMessage,
  type ServerMessage,
} from "@ackerdb/core";
import { ensureAdminCredential } from "../../src/admin/credentials.ts";
import { mutation, type MutationCtx } from "../../src/app/functions.ts";
import { Registry } from "../../src/app/registry.ts";
import { adminCredentials } from "../../src/auth/credential-context.ts";
import { credentialVaultOwner } from "../../src/auth/credential-vault.ts";
import {
  ADMINISTRATIVE_GRANT,
  knownScopeVocabulary,
} from "../../src/auth/scopes.ts";
import { Engine } from "../../src/database/engine.ts";
import { mcp } from "../../src/mcp/index.ts";
import {
  defineServiceLimits,
  PRODUCTION_LIMITS,
  type ServiceLimits,
} from "../../src/runtime/limits.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { serve } from "../../src/transport/server.ts";
import { v } from "../../src/validation/v.ts";
import { within } from "ackerdb-test-support/async";

const schema = defineSchema({
  records: defineTable({
    id: v.primaryKey(),
    value: v.string(),
  }),
});

/**
 * `admin.credentials.*` is deliberately absent from every MCP tool record, so
 * the MCP door has to be exercised through an application tool over the same
 * administration. What is under test is the door, not the surface: the endpoint
 * subscribes to invalidations directly, and a self-revocation published from
 * inside the commit would abort the signal the answer is produced under.
 */
const rotateAdminCredential = mutation({
  description: "Issue a new Admin Credential and revoke the one in use.",
  access: "authenticated",
  args: {},
  returns: v.object({ id: v.string(), token: v.string() }),
  handler: (ctx: MutationCtx) => {
    const created = adminCredentials.rotate(ctx, "rotated through MCP");
    return { id: created.id, token: created.token };
  },
});

const operatorMcp = mcp({
  name: "operator",
  path: "/operator/mcp",
  tools: {
    rotate_credential: { fn: rotateAdminCredential, access: "authenticated" },
  },
});

const modules = { operator: { operatorMcp, rotateAdminCredential } };

/**
 * The application declares scopes, so `*` and `_*` name two genuinely different
 * halves. Without them the whole vocabulary is the framework's, and "every
 * framework scope" would be indistinguishable from "everything".
 */
const APP_SCOPES = ["records:read", "records:write"] as const;
const VOCABULARY = knownScopeVocabulary(APP_SCOPES);

interface Fixture {
  readonly base: string;
  readonly token: string;
  readonly engine: Engine;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function fixture(limits?: ServiceLimits): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-admin-rotation-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const runtime = new Runtime({
    engine,
    registry: new Registry(modules),
    scopes: APP_SCOPES,
    ...(limits === undefined ? {} : { limits }),
  });
  const server = serve({ runtime, port: 0 });
  cleanups.push(async () => {
    await server.drain().catch(() => {});
    await runtime.drain().catch(() => {});
    engine.close("clean");
    rmSync(directory, { recursive: true, force: true });
  });
  const minted = await ensureAdminCredential(engine, runtime.system);
  if (minted.token === undefined) throw new Error("a fresh vault must mint an Admin Credential");
  return { base: `http://127.0.0.1:${server.port}`, token: minted.token, engine };
}

/** `GET`-free probe of administrative authority: 200 with a grant, 401 without. */
function listCredentials(fixtureValue: Fixture, token: string): Promise<Response> {
  return fetch(`${fixtureValue.base}/admin/credentials/list`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
}

interface WsClient {
  send(frame: unknown): void;
  next(): Promise<ServerMessage>;
  closed(): Promise<CloseEvent>;
}

function connect(base: string, token: string): Promise<WsClient> {
  const socket = new WebSocket(`${base.replace("http://", "ws://")}/_ws`);
  const frames: ServerMessage[] = [];
  const waiters: Array<(frame: ServerMessage) => void> = [];
  let closeEvent: CloseEvent | null = null;
  const closeWaiters: Array<(event: CloseEvent) => void> = [];
  // The reader mirrors a client's own two phases: the first frame a server
  // sends is its handshake, and only a welcome opens the session parser.
  let received = 0;
  socket.onmessage = (event) => {
    const frame = parseReceivedFrame(String(event.data), received++);
    const waiter = waiters.shift();
    if (waiter === undefined) frames.push(frame);
    else waiter(frame);
  };
  socket.onclose = (event) => {
    closeEvent = event;
    for (const waiter of closeWaiters.splice(0)) waiter(event);
  };
  return within(new Promise<WsClient>((resolve, reject) => {
    socket.onopen = () => {
      const client: WsClient = {
        send: (frame) => socket.send(encode(frame)),
        next: () => {
          const frame = frames.shift();
          return frame === undefined
            ? new Promise<ServerMessage>((accept) => waiters.push(accept))
            : Promise.resolve(frame);
        },
        closed: () => closeEvent === null
          ? new Promise<CloseEvent>((accept) => closeWaiters.push(accept))
          : Promise.resolve(closeEvent),
      };
      client.send({
        v: ACKERDB_VERSION,
        t: "hello",
        clientSessionId: "admin-rotation",
        credential: { kind: "bearer", token },
      });
      resolve(client);
    };
    socket.onerror = () => reject(new Error("WebSocket connection failed"));
  }));
}

function uuidV7(sequence: number): string {
  const timestamp = Date.now().toString(16).padStart(12, "0");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

describe("rotating the Admin Credential a caller is authenticated with", () => {
  test("answers over exposed HTTP, then refuses the credential it replaced", async () => {
    const value = await fixture();

    const response = await fetch(`${value.base}/admin/credentials/rotate`, {
      method: "POST",
      headers: { authorization: `Bearer ${value.token}` },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const rotated = await response.json() as { id: string; token: string };
    expect(rotated.token).not.toBe(value.token);

    expect((await listCredentials(value, value.token)).status).toBe(401);
    const survivor = await listCredentials(value, rotated.token);
    expect(survivor.status).toBe(200);
    expect(await survivor.json()).toMatchObject([{ id: rotated.id }]);
  });

  test("answers over the WebSocket session, then closes it and refuses the old token", async () => {
    const value = await fixture();
    const client = await connect(value.base, value.token);
    expect(await within(client.next())).toMatchObject({ t: "welcome", principal: "user" });

    client.send({
      t: "m",
      id: 1,
      ref: "admin.credentials.rotate",
      args: {},
      mutationRequestId: uuidV7(1),
      issuedAt: Date.now(),
    });
    const frame = await within(client.next());
    expect(frame).toMatchObject({ t: "ok", id: 1, kind: "mutation" });
    if (frame.t !== "ok") throw new Error("expected the rotation result frame");
    const rotated = frame.value as { id: string; token: string };
    expect(rotated.token).not.toBe(value.token);

    // The session is the origin, so its own termination is what the deferral
    // postponed — not what it cancelled. It arrives, after the frame.
    expect((await within(client.closed())).code).toBe(1008);
    expect((await listCredentials(value, value.token)).status).toBe(401);
    expect((await listCredentials(value, rotated.token)).status).toBe(200);
  });

  test("answers over the MCP endpoint, whose lease is a direct subscriber", async () => {
    const value = await fixture();

    const response = await fetch(`${value.base}/operator/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${value.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "rotate_credential", arguments: {} },
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      result?: { isError?: boolean; structuredContent?: { id: string; token: string } };
    };
    expect(body.result?.isError).toBeUndefined();
    const rotated = body.result?.structuredContent;
    if (rotated === undefined) throw new Error(`no rotation result: ${JSON.stringify(body)}`);
    expect(rotated.token).not.toBe(value.token);

    expect((await listCredentials(value, value.token)).status).toBe(401);
    expect((await listCredentials(value, rotated.token)).status).toBe(200);
  });
});

describe("who may mint administrative authority", () => {
  test("refuses a child credential holding the administrative patterns", async () => {
    const value = await fixture();
    const vault = value.engine[credentialVaultOwner];
    const master = vault.listAdministrative(value.engine.reader)[0]!;
    // Its effective grant is its own expansion intersected with the master's,
    // so it covers the whole vocabulary — and it is still a delegate. Minting a
    // root from here would trade authority its parent can narrow at any moment
    // for authority nobody can.
    const child = value.engine.writer.transaction(() =>
      vault.create(
        master.identity,
        { name: "full-scope delegate", scopes: ADMINISTRATIVE_GRANT },
        VOCABULARY,
        PRODUCTION_LIMITS.credentials,
        Date.now(),
      ))();

    const response = await fetch(`${value.base}/admin/credentials/rotate`, {
      method: "POST",
      headers: { authorization: `Bearer ${child.token}` },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(403);
    const listed = await listCredentials(value, value.token);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([{
      id: master.id,
      name: "Admin Credential",
      createdAt: expect.any(Number),
    }]);
  });

  test("refuses a caller whose own grant does not already cover it", async () => {
    const value = await fixture();
    // Every framework scope and nothing else — which includes
    // `_admin:credentials:write`, so this caller passes the funnel and is
    // stopped by the subset invariant instead. A root credential has no parent
    // to bound it at use, so issuance is the only place that can hold the line.
    const agent = value.engine.writer.transaction(() =>
      value.engine[credentialVaultOwner].create(
        null,
        { name: "agent", scopes: ["_*"] },
        VOCABULARY,
        PRODUCTION_LIMITS.credentials,
        Date.now(),
      ))();

    const response = await fetch(`${value.base}/admin/credentials/rotate`, {
      method: "POST",
      headers: { authorization: `Bearer ${agent.token}` },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(403);
    // The master it tried to displace is untouched, and no second one exists.
    const listed = await listCredentials(value, value.token);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toHaveLength(1);
  });

  test("still replaces the master when the root capacity bucket is full", async () => {
    // Root credentials share one bucket, and boot-mint has taken the only slot
    // here. Minting the replacement before revoking what it replaces would make
    // a full bucket the one state rotation cannot get out of — while a full
    // bucket is exactly what a rotation is about to make room in.
    const value = await fixture(defineServiceLimits({
      ...PRODUCTION_LIMITS,
      credentials: { ...PRODUCTION_LIMITS.credentials, maxPerIdentity: 1 },
    }));

    const response = await fetch(`${value.base}/admin/credentials/rotate`, {
      method: "POST",
      headers: { authorization: `Bearer ${value.token}` },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const rotated = await response.json() as { id: string; token: string };
    expect((await listCredentials(value, rotated.token)).status).toBe(200);
    expect((await listCredentials(value, value.token)).status).toBe(401);
  });

  test("leaves exactly one master behind, whatever it replaced", async () => {
    const value = await fixture();
    const extra = value.engine.writer.transaction(() =>
      value.engine[credentialVaultOwner].create(
        null,
        { name: "second master", scopes: ADMINISTRATIVE_GRANT },
        VOCABULARY,
        PRODUCTION_LIMITS.credentials,
        Date.now(),
      ))();

    const response = await fetch(`${value.base}/admin/credentials/rotate`, {
      method: "POST",
      headers: { authorization: `Bearer ${value.token}` },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const rotated = await response.json() as { id: string; token: string };

    const listed = await listCredentials(value, rotated.token);
    expect(await listed.json()).toEqual([{
      id: rotated.id,
      name: "Admin Credential",
      createdAt: expect.any(Number),
    }]);
    expect((await listCredentials(value, extra.token)).status).toBe(401);
  });
});
