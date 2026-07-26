import { expect, test } from "bun:test";
import { api } from "@demo/ackerdb-codegen/api";
import { issueToken, listedToolNames, withBackend } from "./mcp-harness.ts";
import { expectOk } from "./result.ts";

// The Admin MCP's complete tool surface — ADR-0001 calls this a public
// contract external agents depend on. Per-ticket suites assert containment
// only; THIS file owns exactness. Adding, renaming, or re-scoping a tool must
// consciously edit these lists.
const READ_TOOLS = [
  "bash",
  "get_guests",
  "get_menu_categories",
  "get_menu_items",
  "get_order_items",
  "get_orders",
  "get_tables",
];
const OPERATE_TOOLS = ["advance_kitchen_item", "cancel_order"];
const ALL_TOOLS = [...READ_TOOLS, ...OPERATE_TOOLS].sort();

test("discovery reveals exactly the tool surface each scope grants", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();
    const read = await issueToken(staff, "Read only", ["read"]);
    const operate = await issueToken(staff, "Operate only", ["operate"]);
    const both = await issueToken(staff, "Full", ["read", "operate"]);

    expect(await listedToolNames(await backend.rpc("tools/list", {}))).toEqual([]);
    expect(
      await listedToolNames(await backend.rpc("tools/list", {}, read.token)),
    ).toEqual(READ_TOOLS);
    expect(
      await listedToolNames(await backend.rpc("tools/list", {}, operate.token)),
    ).toEqual(OPERATE_TOOLS);
    expect(
      await listedToolNames(await backend.rpc("tools/list", {}, both.token)),
    ).toEqual(ALL_TOOLS);
  });
});

test("a guest credential never reaches the Admin MCP", async () => {
  await withBackend(async (backend) => {
    await backend.staff();
    // A real guest bearer JWT is a valid demo credential, but it is not an
    // owner token — the MCP boundary rejects it outright.
    const login = expectOk(
      await backend
        .client()
        .procedure(api.auth.login, {
          name: "Mallory",
          email: "mallory@example.com",
        }),
    );

    const discovery = await backend.rpc("tools/list", {}, login.token);
    expect(discovery.status).toBe(401);
    const call = await backend.rpc(
      "tools/call",
      { name: "get_tables", arguments: {} },
      login.token,
    );
    expect(call.status).toBe(401);
  });
});
