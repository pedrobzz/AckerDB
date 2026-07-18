import { expect, test } from "bun:test";
import { api } from "@demo/dbzz-codegen/api";
import {
  expectCode,
  identityOf,
  issueToken,
  listedToolNames,
  withBackend,
  MCP_PROTOCOL_VERSION,
  STAFF_TOKEN,
  type JsonRpcResponse,
  type McpHarness,
} from "./mcp-harness.ts";

interface TableRow {
  readonly id: string;
  readonly number: number;
  readonly seats: number;
  readonly active: boolean;
  readonly occupied: boolean;
  readonly orderId: string | null;
}

async function callTables(
  backend: McpHarness,
  token: string | undefined,
  args: Record<string, unknown>,
  id = 1,
): Promise<Response> {
  return backend.rpc("tools/call", { name: "get_tables", arguments: args }, token, id);
}

function tablesFrom(body: JsonRpcResponse): readonly TableRow[] {
  const structured = body.result?.structuredContent as { tables?: readonly TableRow[] };
  return structured?.tables ?? [];
}

test("staff resolves to one shared durable user Identity", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();
    expect(staff.currentAuthentication).toMatchObject({ principal: "user" });
    const identity = identityOf(staff);

    // Existing staff flows still work under the user-kind principal.
    expect((await staff.query(api.dashboard.overview, {})).tableCount).toBe(12);

    // A second staff session shares the same durable Identity and token vault.
    const created = await issueToken(staff, "Shared identity", ["read"]);
    const otherStaff = backend.client(STAFF_TOKEN);
    await otherStaff.query(api.users.current, {});
    expect(identityOf(otherStaff)).toBe(identity);
    const seen = await otherStaff.query(api.admin.tokens.list, {});
    expect(seen.map((token) => token.id)).toContain(created.id);
  });
});

test("initialize advertises the admin endpoint and its instructions", async () => {
  await withBackend(async (backend) => {
    await backend.staff();
    const response = await backend.rpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "seam-test", version: "1" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as JsonRpcResponse;
    expect(body.result).toMatchObject({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "admin", title: "Savoria Admin" },
    });
    expect(String(body.result?.instructions)).toContain("Savoria");
  });
});

test("tool discovery is least-privilege for the caller's scopes", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();
    const readToken = await issueToken(staff, "Read only", ["read"]);
    const operateToken = await issueToken(staff, "Operate only", ["operate"]);

    // Anonymous callers see only genuinely public tools — the admin surface has none.
    expect(await listedToolNames(await backend.rpc("tools/list", {}))).toEqual([]);

    // A read-scoped token discovers get_tables. (Exact full-surface discovery
    // is asserted once in mcp-surface.test.ts, after every tool exists.)
    expect(
      await listedToolNames(await backend.rpc("tools/list", {}, readToken.token)),
    ).toContain("get_tables");

    // An operate-only token does not — get_tables sits behind `read`.
    expect(
      await listedToolNames(await backend.rpc("tools/list", {}, operateToken.token)),
    ).not.toContain("get_tables");

    // Calling the read tool without the read scope is denied, not hidden-then-run.
    const denied = await callTables(backend, operateToken.token, {});
    expect(denied.status).toBe(403);
    expect(denied.headers.get("www-authenticate")).toBe(
      'Bearer realm="admin", error="insufficient_scope"',
    );

    // An anonymous call to a non-public tool is rejected before it runs.
    const anonymous = await callTables(backend, undefined, {});
    expect(anonymous.status).toBe(401);
  });
});

test("get_tables answers over authenticated tools/call with seeded occupancy", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();
    const readToken = await issueToken(staff, "Reader", ["read"]);

    const response = await callTables(backend, readToken.token, {});
    expect(response.status).toBe(200);
    const tables = tablesFrom((await response.json()) as JsonRpcResponse);
    expect(tables).toHaveLength(12);
    // BigInt identifiers serialize losslessly as strings.
    expect(tables.every((table) => typeof table.id === "string")).toBe(true);

    const occupied = tables.find((table) => table.number === 7);
    expect(occupied).toMatchObject({ occupied: true, active: true });
    expect(typeof occupied?.orderId).toBe("string");

    const free = tables.find((table) => table.number === 1);
    expect(free).toMatchObject({ occupied: false, orderId: null });

    // The limit filter caps the result.
    const limited = tablesFrom(
      (await (await callTables(backend, readToken.token, { limit: 3 }, 2)).json()) as JsonRpcResponse,
    );
    expect(limited.map((table) => table.number)).toEqual([1, 2, 3]);

    // Retiring a free table lets the active-only filter exclude it.
    await staff.mutation(api.tables.remove, { id: BigInt(free!.id) });
    const activeOnly = tablesFrom(
      (await (await callTables(backend, readToken.token, { activeOnly: true }, 3)).json()) as JsonRpcResponse,
    );
    expect(activeOnly.some((table) => table.number === 1)).toBe(false);
    expect(activeOnly).toHaveLength(11);
    const all = tablesFrom(
      (await (await callTables(backend, readToken.token, { activeOnly: false }, 4)).json()) as JsonRpcResponse,
    );
    expect(all.find((table) => table.number === 1)).toMatchObject({ active: false });
  });
});

test("malformed tool input returns a safe MCP error, not a crash", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();
    const readToken = await issueToken(staff, "Reader", ["read"]);

    const response = await callTables(backend, readToken.token, { limit: "lots" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as JsonRpcResponse;
    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent).toBeUndefined();
  });
});

test("owner tokens: create reveals the secret once, list hides it, revoke ends access", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();

    const created = await issueToken(staff, "Codex", ["read"]);
    expect(created.token).toMatch(/^dbzz_mcp\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(created.token.split(".")[1]).toBe(created.id);
    expect(created.scopes).toEqual(["read"]);

    // The descriptor is listable, but the secret is never retrievable again.
    const listed = await staff.query(api.admin.tokens.list, {});
    const descriptor = listed.find((token) => token.id === created.id);
    expect(descriptor).toMatchObject({ name: "Codex", scopes: ["read"] });
    expect(descriptor).not.toHaveProperty("token");

    // The token works against the endpoint before revocation.
    expect((await callTables(backend, created.token, {})).status).toBe(200);

    // Update renames and rescopes in place.
    await staff.mutation(api.admin.tokens.update, {
      id: created.id,
      name: "Codex (renamed)",
      scopes: ["read", "operate"],
    });
    const afterUpdate = (await staff.query(api.admin.tokens.list, {})).find(
      (token) => token.id === created.id,
    );
    expect(afterUpdate).toMatchObject({
      name: "Codex (renamed)",
      scopes: ["read", "operate"],
    });

    // Revocation takes effect on the very next call.
    await staff.mutation(api.admin.tokens.revoke, { id: created.id });
    expect((await callTables(backend, created.token, {}, 9)).status).toBe(401);
    expect(
      (await staff.query(api.admin.tokens.list, {})).some(
        (token) => token.id === created.id,
      ),
    ).toBe(false);
  });
});

test("guests and anonymous callers cannot administer owner tokens", async () => {
  await withBackend(async (backend) => {
    await backend.staff();
    const anonymous = backend.client();
    const guest = await backend.guest("guest@example.com", "Denied Guest");

    await expectCode(anonymous.query(api.admin.tokens.list, {}), "unauthenticated");
    await expectCode(guest.query(api.admin.tokens.list, {}), "unauthorized");
    await expectCode(
      guest.mutation(api.admin.tokens.create, { name: "Sneaky", scopes: ["read"] }),
      "unauthorized",
    );
  });
});
