import { describe, expect, test } from "bun:test";
import type { AckerDBClient } from "@ackerdb/client";
import { callThroughCell, type LifetimeCell } from "../src/lifetime-call.ts";

// Direct exercises of the shared queue's re-entrancy edges: snapshotting a
// queued call runs caller getters, and a getter can synchronously flip the
// cell's owner state (what the hook's commit effects do) before the waiter
// would be enqueued. These transitions cannot be driven deterministically
// through the rendered hooks — React only performs them inside its own
// flushes — but the exactly-one-owner invariant is the module's, so it is
// pinned here.

const fakeClient = {} as AckerDBClient;

function liveCell(): LifetimeCell<string> {
  return { ref: "api.tools.echo", client: null, ended: false, waiters: new Set() };
}

describe("callThroughCell snapshot re-entrancy", () => {
  test("a getter that ends the lifetime mid-snapshot still gets the typed discard", async () => {
    const cell = liveCell();
    const args = {
      get value(): string {
        // What the hook's lifetime-end cleanup does, re-entrantly: after this,
        // no future drain exists to settle a late waiter.
        cell.ended = true;
        cell.client = null;
        return "poison";
      },
    };
    let dispatches = 0;
    const result = callThroughCell(cell, args, async () => {
      dispatches++;
      return "never";
    });
    expect(await result.catch((error) => error)).toMatchObject({
      name: "AckerDBClientError",
      code: "unavailable",
      message: "client closed",
      resource: "operation",
    });
    expect(dispatches).toBe(0);
    expect(cell.waiters.size).toBe(0);
  });

  test("a getter that delivers the client mid-snapshot dispatches immediately with the snapshot", async () => {
    const cell = liveCell();
    const args = {
      get value(): string {
        // What the arrival drain does, re-entrantly: it has already run, so a
        // waiter enqueued afterwards would never dispatch.
        cell.client = fakeClient;
        return "call-time";
      },
    };
    const seen: unknown[] = [];
    const result = callThroughCell(cell, args, async (_client, value) => {
      seen.push(value);
      return "ok";
    });
    expect(await result).toBe("ok");
    // Exactly one dispatch, carrying the already-taken snapshot — the getter
    // ran once, during encoding.
    expect(seen).toEqual([{ value: "call-time" }]);
    expect(cell.waiters.size).toBe(0);
  });
});
