import { expect, test } from "bun:test";
import { api } from "@demo/dbzz-codegen/api";
import {
  issueToken,
  listedToolNames,
  structuredOf,
  withBackend,
  type McpHarness,
} from "./mcp-harness.ts";

/** The bash tool's structured output (mirrors workspace.ts). */
interface WorkspaceResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

/** Run a script in the workspace as the given token and return its structured result. */
async function run(
  backend: McpHarness,
  token: string,
  script: string,
): Promise<WorkspaceResult> {
  return structuredOf<WorkspaceResult>(
    await backend.call("bash", { script }, token),
  );
}

test("discovery: the workspace is a read tool, invisible to operate-only", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();
    const read = await issueToken(staff, "Reader", ["read"]);
    const operate = await issueToken(staff, "Operator", ["operate"]);

    // Containment only — the full surface is asserted elsewhere.
    expect(
      await listedToolNames(await backend.rpc("tools/list", {}, read.token)),
    ).toContain("bash");
    expect(
      await listedToolNames(await backend.rpc("tools/list", {}, operate.token)),
    ).not.toContain("bash");

    // And it is denied, not silently hidden-then-run, without the read scope.
    const denied = await backend.rpc(
      "tools/call",
      { name: "bash", arguments: { script: "echo hi" } },
      operate.token,
    );
    expect(denied.status).toBe(403);
  });
});

test("a jq pipeline computes the median wait over seeded data", async () => {
  await withBackend(async (backend) => {
    // Bound the live-clock component of in-flight waits: everything between here
    // and the tool call happens within `elapsed` milliseconds.
    const before = Date.now();
    const staff = await backend.staff();
    const read = await issueToken(staff, "Reader", ["read"]);

    // Median wait, in milliseconds, across every item currently on the board.
    const medianScript = `jq -s 'map(.waitMs) | sort
      | if length % 2 == 1 then .[length / 2 | floor]
        else (.[length / 2 - 1] + .[length / 2]) / 2 end' \
      /data/views/wait_times.jsonl`;
    const board = await run(backend, read.token, medianScript);
    const elapsed = Date.now() - before;

    expect(board.exitCode).toBe(0);
    expect(board.stderr).toBe("");
    const median = Number(board.stdout.trim());
    // Independently derived from the seed: the two middle items (of 18) are the
    // two lines of the 24-minute-old order, so the median is 24 min = 1_440_000
    // ms, plus however much wall-clock elapsed while those in-flight waits were
    // measured against the snapshot's `now`.
    expect(median).toBeGreaterThanOrEqual(1_440_000);
    expect(median).toBeLessThanOrEqual(1_440_000 + elapsed);

    // The settled-wait subset is fully deterministic (no clock): the only guests
    // who waited past the first plate are on the paid check (its 2nd and 3rd
    // items, at +1 and +2 min); every other completed item was served or
    // cancelled at index 0. Median of those six completed waits is therefore 0.
    const finals = await run(
      backend,
      read.token,
      `jq -s 'map(select(.final).waitMs) | sort' /data/views/wait_times.jsonl`,
    );
    expect(finals.exitCode).toBe(0);
    expect(JSON.parse(finals.stdout)).toEqual([0, 0, 0, 0, 60_000, 120_000]);
  });
});

test("the workspace reflects mutations made between two calls (never stale)", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();
    const read = await issueToken(staff, "Reader", ["read"]);

    // First call: pick a still-ORDERED item straight out of the live workspace.
    const pick = await run(
      backend,
      read.token,
      `jq -r 'select(.status == "ORDERED") | .orderItemId' /data/views/wait_times.jsonl | head -1`,
    );
    const orderItemId = pick.stdout.trim();
    expect(orderItemId).toMatch(/^\d+$/);

    // `item` is digits (asserted above), so it embeds into the jq program safely.
    const statusOf = (item: string) =>
      run(
        backend,
        read.token,
        `jq -r 'select(.orderItemId == "${item}") | .status' /data/views/wait_times.jsonl`,
      );

    expect((await statusOf(orderItemId)).stdout.trim()).toBe("ORDERED");

    // Advance it through the ordinary staff path — no workspace side channel.
    await staff.mutation(api.kitchen.advance, { orderItemId: BigInt(orderItemId) });

    // A brand-new workspace, materialized fresh, sees the change immediately.
    expect((await statusOf(orderItemId)).stdout.trim()).toBe("PREPARING");
  });
});

test("a runaway script terminates fast with a safe, non-zero error", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();
    const read = await issueToken(staff, "Reader", ["read"]);

    const started = Date.now();
    const result = await run(backend, read.token, "while true; do echo spin; done");
    const wall = Date.now() - started;

    // Bounded, non-zero, and explained — not a hang or a crash.
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(wall).toBeLessThan(5_000);
  });
});

test("oversized output is bounded and flags truncation", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();
    const read = await issueToken(staff, "Reader", ["read"]);

    const big = await run(backend, read.token, "seq 1 60000");
    expect(big.exitCode).toBe(0);
    expect(big.truncated).toBe(true);
    // Capped near 32 KiB (the byte cap plus a short truncation marker).
    expect(Buffer.byteLength(big.stdout)).toBeLessThanOrEqual(32 * 1024 + 64);
    expect(big.stdout).toContain("truncated");

    // A small result is returned whole, with the flag clear.
    const small = await run(backend, read.token, "echo tiny");
    expect(small.truncated).toBe(false);
    expect(small.stdout).toBe("tiny\n");
  });
});

// Regression: `dbzz dev`/`dbzz start` run with telemetry enabled, where dbzz
// times reads with performance.now(). just-bash's sandbox blocks that global
// during exec(), so files must be materialized BEFORE the shell runs — lazy
// providers die here with a SecurityViolationError surfaced as ENOENT.
test("workspace materializes under the dev config (telemetry enabled)", async () => {
  await withBackend(
    async (backend) => {
      const staff = await backend.staff();
      const token = await issueToken(staff, "Dev config", ["read"]);
      const body = await backend.call(
        "bash",
        { script: "head -c 40 /data/tables.jsonl" },
        token.token,
      );
      const result = structuredOf<WorkspaceResult>(body);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"number":1');
    },
    { DBZZ_TELEMETRY: "enabled", DBZZ_DURABILITY: "production" },
  );
});
