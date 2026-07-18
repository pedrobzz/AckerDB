import { expect, test } from "bun:test";
import { api } from "@demo/dbzz-codegen/api";
import {
  issueToken,
  listedToolNames,
  structuredOf,
  withBackend,
  type JsonRpcResponse,
  type McpHarness,
} from "./mcp-harness.ts";

const INSUFFICIENT_SCOPE = 'Bearer realm="admin", error="insufficient_scope"';

interface AdvanceOutput {
  readonly orderItemId: string;
  readonly orderId: string;
  readonly status: string;
}

interface CancelOutput {
  readonly orderId: string;
  readonly tableId: string;
  readonly tableNumber: number;
  readonly itemsCancelled: number;
  readonly itemsPreserved: number;
}

interface TableRow {
  readonly number: number;
  readonly occupied: boolean;
  readonly orderId: string | null;
}

function callAction(
  backend: McpHarness,
  tool: string,
  args: Record<string, unknown>,
  token: string,
  id = 1,
): Promise<Response> {
  return backend.rpc("tools/call", { name: tool, arguments: args }, token, id);
}

async function tablesVia(backend: McpHarness, token: string): Promise<readonly TableRow[]> {
  const body = await backend.call("get_tables", {}, token);
  const structured = body.result?.structuredContent as { tables?: readonly TableRow[] };
  return structured?.tables ?? [];
}

test("action tools sit behind operate: discovery and direct calls are scope-gated", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();
    const readToken = await issueToken(staff, "Read only", ["read"]);
    const operateToken = await issueToken(staff, "Operate", ["operate"]);

    // The operate token discovers both action tools (containment, not an exact list).
    const operateTools = await listedToolNames(
      await backend.rpc("tools/list", {}, operateToken.token),
    );
    expect(operateTools).toContain("advance_kitchen_item");
    expect(operateTools).toContain("cancel_order");

    // The read-only token discovers neither.
    const readTools = await listedToolNames(
      await backend.rpc("tools/list", {}, readToken.token),
    );
    expect(readTools).not.toContain("advance_kitchen_item");
    expect(readTools).not.toContain("cancel_order");

    // A read-only token calling an action tool is denied before it runs — no hidden-then-run.
    for (const tool of ["advance_kitchen_item", "cancel_order"]) {
      const denied = await callAction(backend, tool, { orderItemId: "1", orderId: "1" }, readToken.token);
      expect(denied.status).toBe(403);
      expect(denied.headers.get("www-authenticate")).toBe(INSUFFICIENT_SCOPE);
    }
  });
});

test("advance_kitchen_item walks an item to SERVED, visible to staff, then refuses", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();
    const operateToken = await issueToken(staff, "Operate", ["operate"]);

    // A freshly ORDERED item from the live kitchen queue.
    const ordered = (await staff.query(api.kitchen.queue, {})).find(
      (row) => row.status === "ORDERED",
    );
    expect(ordered).toBeDefined();
    const orderItemId = ordered!.id;
    const statusOf = async (): Promise<string | undefined> =>
      (await staff.query(api.kitchen.queue, {})).find((row) => row.id === orderItemId)?.status;

    // ORDERED -> PREPARING; the structured output echoes the ids and the new status.
    const first = structuredOf<AdvanceOutput>(
      await backend.call("advance_kitchen_item", { orderItemId: String(orderItemId) }, operateToken.token),
    );
    expect(first).toMatchObject({ orderItemId: String(orderItemId), status: "PREPARING" });
    expect(typeof first.orderId).toBe("string");
    // The advance is visible to a staff query.
    expect(await statusOf()).toBe("PREPARING");

    // PREPARING -> PREPARED -> SERVED.
    expect(
      structuredOf<AdvanceOutput>(
        await backend.call("advance_kitchen_item", { orderItemId: String(orderItemId) }, operateToken.token),
      ).status,
    ).toBe("PREPARED");
    expect(
      structuredOf<AdvanceOutput>(
        await backend.call("advance_kitchen_item", { orderItemId: String(orderItemId) }, operateToken.token),
      ).status,
    ).toBe("SERVED");
    expect(await statusOf()).toBe("SERVED");

    // A SERVED item is final: advancing again is a safe error with no state change.
    const body = await backend.call(
      "advance_kitchen_item",
      { orderItemId: String(orderItemId) },
      operateToken.token,
    );
    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent).toBeUndefined();
    expect(await statusOf()).toBe("SERVED");
  });
});

test("cancel_order cancels an open order, frees its table, and reports the split", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();
    const readToken = await issueToken(staff, "Reader", ["read"]);
    const operateToken = await issueToken(staff, "Operate", ["operate"]);

    const open = (await staff.query(api.orders.list, {})).find((order) => order.status === "OPEN");
    expect(open).toBeDefined();
    const orderId = open!.id;
    const tableNumber = open!.table.number;
    const expectedPreserved = open!.items.filter(
      (item) => item.status === "SERVED" || item.status === "CANCELLED",
    ).length;
    const expectedCancelled = open!.items.length - expectedPreserved;

    // The table reads as occupied before the cancellation.
    const before = (await tablesVia(backend, readToken.token)).find((t) => t.number === tableNumber);
    expect(before?.occupied).toBe(true);

    const summary = structuredOf<CancelOutput>(
      await backend.call("cancel_order", { orderId: String(orderId) }, operateToken.token),
    );
    expect(summary).toMatchObject({
      orderId: String(orderId),
      tableNumber,
      itemsCancelled: expectedCancelled,
      itemsPreserved: expectedPreserved,
    });
    expect(typeof summary.tableId).toBe("string");

    // The order is now CANCELLED...
    expect((await staff.query(api.orders.detail, { id: orderId })).status).toBe("CANCELLED");
    // ...and the table is free, visible through the read tool.
    const after = (await tablesVia(backend, readToken.token)).find((t) => t.number === tableNumber);
    expect(after).toMatchObject({ occupied: false, orderId: null });
  });
});

test("cancel_order refuses an order that is not open, with no write", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();
    const operateToken = await issueToken(staff, "Operate", ["operate"]);

    const orders = await staff.query(api.orders.list, {});
    for (const closed of [
      orders.find((order) => order.status === "PAID"),
      orders.find((order) => order.status === "CANCELLED"),
    ]) {
      expect(closed).toBeDefined();
      const body = await backend.call("cancel_order", { orderId: String(closed!.id) }, operateToken.token);
      expect(body.result?.isError).toBe(true);
      expect(body.result?.structuredContent).toBeUndefined();
      // The order's status is untouched — the transaction rolled back.
      expect((await staff.query(api.orders.detail, { id: closed!.id })).status).toBe(closed!.status);
    }
  });
});

test("removing the operate scope denies the token's very next action call", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();
    const token = await issueToken(staff, "Downgradable", ["read", "operate"]);

    // While operate-scoped, an action tool runs.
    const ordered = (await staff.query(api.kitchen.queue, {})).find((row) => row.status === "ORDERED");
    expect(ordered).toBeDefined();
    const ok = structuredOf<AdvanceOutput>(
      await backend.call("advance_kitchen_item", { orderItemId: String(ordered!.id) }, token.token),
    );
    expect(ok.status).toBe("PREPARING");

    // Drop operate; the reduced scope is authoritative on the next call.
    await staff.mutation(api.admin.tokens.update, { id: token.id, name: null, scopes: ["read"] });

    const denied = await callAction(
      backend,
      "advance_kitchen_item",
      { orderItemId: String(ordered!.id) },
      token.token,
      9,
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get("www-authenticate")).toBe(INSUFFICIENT_SCOPE);
  });
});
