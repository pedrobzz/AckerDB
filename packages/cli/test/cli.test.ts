import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { decode, encode } from "@dbzz/core";
import { FIXTURE_ADMIN_USERS, FIXTURE_MESSAGES, FIXTURE_SCHEMA, makeFixture } from "./fixture.ts";

const CLI = new URL("../src/main.ts", import.meta.url).pathname;

const dirs: string[] = [];
const children: Subprocess<"ignore", "pipe", "inherit">[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill();
    await child.exited;
  }
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Spawn the CLI, tailing (and fully draining) its stdout into a buffer. */
function spawnCli(args: string[]) {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    stdout: "pipe",
    stderr: "inherit",
  }) as Subprocess<"ignore", "pipe", "inherit">;
  children.push(child);
  let buffer = "";
  const drained = (async () => {
    for await (const chunk of child.stdout) {
      buffer += new TextDecoder().decode(chunk);
    }
  })();
  const waitFor = async (needle: string, timeoutMs = 10_000): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    let from = 0;
    while (Date.now() < deadline) {
      const at = buffer.indexOf(needle, from);
      if (at !== -1) return buffer;
      await Bun.sleep(25);
    }
    throw new Error(`timed out waiting for ${JSON.stringify(needle)} in:\n${buffer}`);
  };
  return { child, waitFor, output: () => buffer, drained };
}

const freePort = () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop(true);
  return port;
};

const fixture = (port: number) => {
  const dir = makeFixture({
    "schema.ts": FIXTURE_SCHEMA,
    "functions/messages.ts": FIXTURE_MESSAGES,
    "functions/admin/users.ts": FIXTURE_ADMIN_USERS,
    ".zdb.config.json": JSON.stringify({ port }),
  });
  dirs.push(dir);
  return dir;
};

const call = async (port: number, body: unknown) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/call`, {
    method: "POST",
    body: encode(body),
  });
  return decode(await res.text()) as Record<string, unknown>;
};

describe("dbz CLI", () => {
  test("start: codegen + serve, functions callable, reset wipes the db", async () => {
    const port = freePort();
    const dir = fixture(port);
    const started = spawnCli(["start", dir]);
    await started.waitFor("ready on");
    expect(existsSync(join(dir, "_generated", "api.ts"))).toBe(true);

    const id = await call(port, { ref: "messages.send", args: { channelId: 1n, body: "hi" }, mid: "c1" });
    expect(id).toEqual({ value: 1n });
    const rows = await call(port, { ref: "messages.list", args: { channelId: 1n } });
    expect((rows["value"] as unknown[]).length).toBe(1);
    const count = await call(port, { ref: "admin.users.count", args: {} });
    expect(count).toEqual({ value: 1 });

    started.child.kill();
    await started.child.exited;

    expect(existsSync(join(dir, ".zdb", "data.db"))).toBe(true);
    const reset = spawnCli(["reset", dir]);
    await reset.child.exited;
    expect(existsSync(join(dir, ".zdb"))).toBe(false);
  });

  test("dev: watches, re-runs codegen debounced, restarts the server", async () => {
    const port = freePort();
    const dir = fixture(port);
    const dev = spawnCli(["dev", dir]);
    await dev.waitFor("ready on");

    // survives data before the edit
    await call(port, { ref: "messages.send", args: { channelId: 2n, body: "before" }, mid: "d1" });

    // edit the schema: add a table (a safe change)
    writeFileSync(
      join(dir, "schema.ts"),
      FIXTURE_SCHEMA.replace(
        "typingEvents: defineEventTable({",
        `notes: defineTable({ id: dbz.primaryKey(), text: dbz.string() }),
  typingEvents: defineEventTable({`,
      ),
    );
    await dev.waitFor("reloaded in");
    // wait for the restarted server to answer
    const deadline = Date.now() + 5000;
    let alive = false;
    while (Date.now() < deadline && !alive) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        alive = res.ok;
      } catch {
        await Bun.sleep(50);
      }
    }
    expect(alive).toBe(true);

    // codegen picked up the new table
    const types = readFileSync(join(dir, "_generated", "types.ts"), "utf8");
    expect(types).toContain('export type Note = RowOf<typeof schema, "notes">;');

    // data survived the reload (safe reconciliation, same database)
    const rows = await call(port, { ref: "messages.list", args: { channelId: 2n } });
    expect((rows["value"] as unknown[]).length).toBe(1);
  }, 20_000);
});
