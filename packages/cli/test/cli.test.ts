import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { DbzzClient } from "@dbzz/client";
import { FIXTURE_ADMIN_USERS, FIXTURE_MESSAGES, FIXTURE_SCHEMA, makeFixture } from "./fixture.ts";

const CLI = new URL("../src/main.ts", import.meta.url).pathname;

const dirs: string[] = [];
const children: Subprocess<"ignore", "pipe", "inherit">[] = [];
const portReservations = new Set<Server>();
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill();
    await child.exited;
  }
  await Promise.all([...portReservations].map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  portReservations.clear();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Spawn the CLI, tailing (and fully draining) its stdout into a buffer. */
function spawnCli(args: string[], env: Readonly<Record<string, string>> = {}) {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, ...env },
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

const reservePort = async (): Promise<{ port: number; release(): Promise<void> }> => {
  const server = createServer();
  portReservations.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("port reservation has no address");
  return {
    port: address.port,
    release: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        portReservations.delete(server);
        if (error === undefined) resolve();
        else reject(error);
      });
    }),
  };
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

const clientFor = (port: number) => new DbzzClient({
  url: `http://127.0.0.1:${port}`,
  credential: { kind: "anonymous" },
});

describe("dbz CLI", () => {
  test("start: codegen + serve, functions callable, reset wipes the db", async () => {
    const port = freePort();
    const dir = fixture(port);
    const started = spawnCli(["start", dir]);
    await started.waitFor("ready on");
    expect(started.output()).toContain(
      '@@dbzz-startup {"telemetry":"enabled","durability":"production"}',
    );
    expect(existsSync(join(dir, "_generated", "api.ts"))).toBe(true);

    const client = clientFor(port);
    expect(await client.mutation<{ channelId: bigint; body: string }, bigint>(
      "messages.send",
      { channelId: 1n, body: "hi" },
    )).toBe(1n);
    expect(await client.query<unknown, unknown[]>("messages.list", { channelId: 1n })).toHaveLength(1);
    expect(await client.query<Record<never, never>, number>("admin.users.count", {})).toBe(1);
    client.close();

    started.child.kill("SIGTERM");
    expect(await started.child.exited).toBe(0);

    expect(existsSync(join(dir, ".zdb", "data.db"))).toBe(true);
    const reset = spawnCli(["reset", dir]);
    await reset.child.exited;
    expect(existsSync(join(dir, ".zdb"))).toBe(false);
  });

  test("start confirms the effective balanced/no-telemetry profile exactly once before readiness", async () => {
    const port = freePort();
    const dir = fixture(port);
    const started = spawnCli(["start", dir], {
      DBZZ_DURABILITY: "balanced",
      DBZZ_TELEMETRY: "disabled",
    });
    const output = await started.waitFor("ready on");
    const marker = '@@dbzz-startup {"telemetry":"disabled","durability":"balanced"}';
    expect(output.split("@@dbzz-startup")).toHaveLength(2);
    expect(output.indexOf(marker)).toBeGreaterThanOrEqual(0);
    expect(output.indexOf(marker)).toBeLessThan(output.indexOf("[dbz] ready on"));
    expect(await (await fetch(`http://127.0.0.1:${port}/ready`)).json()).toEqual({
      version: 1,
      ready: true,
    });

    started.child.kill("SIGTERM");
    expect(await started.child.exited).toBe(0);
  });

  test("a startup failure releases Runtime and storage ownership before retry", async () => {
    const reservation = await reservePort();
    const dir = fixture(reservation.port);
    const failed = spawnCli(["start", dir], { DBZZ_TELEMETRY: "disabled" });
    expect(await failed.child.exited).toBe(1);
    await failed.drained;
    expect(failed.output()).not.toContain("@@dbzz-startup");

    await reservation.release();
    const retried = spawnCli(["start", dir], { DBZZ_TELEMETRY: "disabled" });
    await retried.waitFor("ready on");
    retried.child.kill("SIGTERM");
    expect(await retried.child.exited).toBe(0);
  }, 20_000);

  test("start exits without readiness when the live database schema is corrupt", async () => {
    const port = freePort();
    const dir = fixture(port);
    const first = spawnCli(["start", dir], { DBZZ_TELEMETRY: "disabled" });
    await first.waitFor("ready on");
    first.child.kill("SIGTERM");
    expect(await first.child.exited).toBe(0);

    const db = new Database(join(dir, ".zdb", "data.db"));
    db.exec("DROP INDEX ix_messages_by_channel");
    db.close();

    const failed = spawnCli(["start", dir], { DBZZ_TELEMETRY: "disabled" });
    expect(await failed.child.exited).toBe(1);
    await failed.drained;
    expect(failed.output()).not.toContain("@@dbzz-startup");
    expect(failed.output()).not.toContain("ready on");
  }, 20_000);

  test("dev: watches, re-runs codegen debounced, restarts the server", async () => {
    const port = freePort();
    const dir = fixture(port);
    const dev = spawnCli(["dev", dir]);
    await dev.waitFor("ready on");
    const client = clientFor(port);

    // survives data before the edit
    await client.mutation("messages.send", { channelId: 2n, body: "before" });

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
        const res = await fetch(`http://127.0.0.1:${port}/ready`);
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
    expect(await client.query<unknown, unknown[]>("messages.list", { channelId: 2n })).toHaveLength(1);
    client.close();
  }, 20_000);
});
