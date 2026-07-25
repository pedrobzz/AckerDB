import { expect, test } from "bun:test";
import { api } from "@demo/dbzz-codegen/api";
import { STAFF_TOKEN, issueToken, withBackend } from "./mcp-harness.ts";
import { expectOk } from "./result.ts";

// The reactive seam: a write committed by an Admin MCP action (over the /mcp
// HTTP path, under an owner token) shares the store with every live WS
// subscription. It must land as a normal delivery on those subscriptions, never
// break them. This is the demo-side guard for the framework's reactive execution
// root — on 0.3.0 an MCP commit tore down other clients' subscriptions; on 0.3.1
// the update is delivered clean. The control case pins the same expectation to a
// plain WS mutation from another client.

async function until(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("an MCP action over HTTP delivers to a live staff subscription without breaking it", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();
    const updates: unknown[] = [];
    const errors: { code: string; message: string }[] = [];
    const unsubscribe = staff.subscribe(
      api.dashboard.overview,
      {},
      (value) => updates.push(value),
      (error) => errors.push({ code: error.code, message: error.message }),
    );
    try {
      await until(() => updates.length >= 1 || errors.length > 0, "first snapshot");

      // Advance a live kitchen item through the raw /mcp surface under an
      // owner token — the exact path an external host would drive.
      const ordered = expectOk(
        await staff.query(api.kitchen.queue, {}),
      ).find(
        (row) => row.status === "ORDERED",
      );
      expect(ordered).toBeDefined();
      const token = await issueToken(staff, "Actor", ["read", "operate"]);
      const body = await backend.call(
        "advance_kitchen_item",
        { orderItemId: String(ordered!.id) },
        token.token,
      );
      expect(body.result?.isError ?? false).toBe(false);

      // The commit is delivered to the live subscription as a clean update.
      await until(() => updates.length >= 2 || errors.length > 0, "post-action delivery");
      expect(errors).toEqual([]);
      expect(updates.length).toBeGreaterThanOrEqual(2);
    } finally {
      unsubscribe();
    }
  });
});

test("control: a normal WS mutation from another client delivers without breaking the subscription", async () => {
  await withBackend(async (backend) => {
    const watcher = await backend.staff();
    const updates: unknown[] = [];
    const errors: { code: string; message: string }[] = [];
    const unsubscribe = watcher.subscribe(
      api.dashboard.overview,
      {},
      (value) => updates.push(value),
      (error) => errors.push({ code: error.code, message: error.message }),
    );
    try {
      await until(() => updates.length >= 1 || errors.length > 0, "first snapshot");

      const actor = backend.client(STAFF_TOKEN);
      const ordered = expectOk(
        await actor.query(api.kitchen.queue, {}),
      ).find(
        (row) => row.status === "ORDERED",
      );
      expect(ordered).toBeDefined();
      expectOk(
        await actor.mutation(api.kitchen.advance, {
          orderItemId: ordered!.id,
        }),
      );

      await until(() => updates.length >= 2 || errors.length > 0, "post-mutation delivery");
      expect(errors).toEqual([]);
      expect(updates.length).toBeGreaterThanOrEqual(2);
    } finally {
      unsubscribe();
    }
  });
});
