import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { DbzzClient } from "@dbzz/client";
import type { CredentialVerifier } from "@dbzz/server";
import { startApp } from "../src/app.ts";
import { runCodegen } from "../src/codegen.ts";
import { loadConfig } from "../src/config.ts";
import { FIXTURE_ADMIN_USERS, FIXTURE_APP, FIXTURE_MESSAGES, makeFixture } from "./fixture.ts";

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
    "app.ts": FIXTURE_APP,
    "functions/messages.ts": FIXTURE_MESSAGES,
    "functions/admin/users.ts": FIXTURE_ADMIN_USERS,
    ".dbzz.config.json": JSON.stringify({ port }),
  });
  dirs.push(dir);
  return dir;
};

const clientFor = (port: number) => new DbzzClient({
  url: `http://127.0.0.1:${port}`,
  credential: { kind: "anonymous" },
});

const IDENTITY_PROCEDURE = `
import { procedure } from "../_generated/server.ts";

export const current = procedure({
  access: "authenticated",
  args: {},
  handler: (ctx) => {
    if (ctx.auth.kind !== "user") throw new Error("user identity required");
    return ctx.auth.identity;
  },
});
`;

const CREDENTIAL_VERIFIER_MODULE = `
import type { CredentialVerifier } from "@dbzz/server";

const verifier = {
  revocationBound: { kind: "token-expiration" },
  verify: async (credential: string) => {
    if (credential !== "accepted-token") throw new Error("credential rejected");
    return {
      kind: "user" as const,
      issuer: "https://identity.example.test/",
      subject: "durable-user",
      claims: {},
      expiresAt: Date.now() + 60 * 60 * 1_000,
      tokenId: null,
    };
  },
  subscribeInvalidation: () => () => {},
} satisfies CredentialVerifier;

export default verifier;
`;

const verifierFor = (subject: string): CredentialVerifier => ({
  revocationBound: { kind: "token-expiration" },
  verify: async (credential) => {
    if (credential !== "accepted-token") throw new Error("credential rejected");
    return {
      kind: "user",
      issuer: "https://identity.example.test/",
      subject,
      claims: {},
      expiresAt: Date.now() + 60 * 60 * 1_000,
      tokenId: null,
    };
  },
  subscribeInvalidation: () => () => {},
});

const authenticatedClientFor = (port: number) => new DbzzClient({
  url: `http://127.0.0.1:${port}`,
  credential: { kind: "bearer", token: "accepted-token" },
});

function shutdownMarker(dir: string): bigint {
  const db = new Database(join(dir, ".dbzz", "data.db"), { readonly: true, safeIntegers: true });
  try {
    return (db.query("SELECT clean_shutdown FROM _dbzz_state WHERE singleton = 1").get() as {
      clean_shutdown: bigint;
    }).clean_shutdown;
  } finally {
    db.close();
  }
}

function within<T>(work: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    work,
    Bun.sleep(2_000).then(() => {
      throw new Error(`${label} did not release its resources`);
    }),
  ]);
}

describe("dbzz CLI", () => {
  test("start loads a configured verifier and preserves the bearer user's durable Identity", async () => {
    const port = freePort();
    const dir = makeFixture({
      "app.ts": FIXTURE_APP,
      "functions/identity.ts": IDENTITY_PROCEDURE,
      "functions/messages.ts": FIXTURE_MESSAGES,
      "credential-verifier.ts": CREDENTIAL_VERIFIER_MODULE,
      ".dbzz.config.json": JSON.stringify({
        port,
        credentialVerifier: "./credential-verifier.ts",
      }),
    });
    dirs.push(dir);

    const first = spawnCli(["start", dir], { DBZZ_TELEMETRY: "disabled" });
    await first.waitFor("ready on");
    const firstClient = authenticatedClientFor(port);
    const firstIdentity = await firstClient.procedure<Record<string, never>, bigint>(
      "identity.current",
      {},
    );
    firstClient.close();
    first.child.kill("SIGTERM");
    expect(await first.child.exited).toBe(0);

    const second = spawnCli(["start", dir], { DBZZ_TELEMETRY: "disabled" });
    await second.waitFor("ready on");
    const secondClient = authenticatedClientFor(port);
    expect(await secondClient.procedure<Record<string, never>, bigint>(
      "identity.current",
      {},
    )).toBe(firstIdentity);
    secondClient.close();
    second.child.kill("SIGTERM");
    expect(await second.child.exited).toBe(0);
  }, 20_000);

  test("startApp accepts one programmatic verifier alongside preparation and rejects competition", async () => {
    const port = freePort();
    const dir = makeFixture({
      "app.ts": FIXTURE_APP,
      "functions/identity.ts": IDENTITY_PROCEDURE,
      "functions/messages.ts": FIXTURE_MESSAGES,
      ".dbzz.config.json": JSON.stringify({ port }),
    });
    dirs.push(dir);
    const config = loadConfig(dir, { DBZZ_TELEMETRY: "disabled" });
    const credentialVerifier = verifierFor("injected-user");
    const app = await startApp(config, { prepare: runCodegen, credentialVerifier });
    try {
      const client = authenticatedClientFor(port);
      expect(await client.procedure<Record<string, never>, bigint>(
        "identity.current",
        {},
      )).toBe(1n);
      client.close();
    } finally {
      await app.drain();
    }

    await expect(startApp(
      {
        ...config,
        authentication: {
          kind: "credential-verifier-module",
          path: join(dir, "credential-verifier.ts"),
        },
      },
      { credentialVerifier },
    )).rejects.toThrow(
      "startApp credentialVerifier cannot be combined with configured oidc or credentialVerifier",
    );
  }, 20_000);

  test("startApp rejects a malformed verifier default export before activation", async () => {
    const port = freePort();
    const dir = makeFixture({
      "app.ts": FIXTURE_APP,
      "credential-verifier.ts": "export default { revocationBound: { kind: 'token-expiration' } };",
      ".dbzz.config.json": JSON.stringify({
        port,
        credentialVerifier: "./credential-verifier.ts",
      }),
    });
    dirs.push(dir);

    await expect(startApp(loadConfig(dir, { DBZZ_TELEMETRY: "disabled" }))).rejects.toThrow(
      "must implement verify(credential)",
    );

    const rebound = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => new Response("ok"),
    });
    await rebound.stop(true);
  });

  test("start: codegen + serve, functions callable, reset clears only exact database artifacts", async () => {
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
    const chunks: unknown[] = [];
    for await (const chunk of client.sse("messages.tail", { channelId: 1n })) chunks.push(chunk);
    expect(chunks).toEqual([{ body: "channel 1" }]);
    client.close();

    started.child.kill("SIGTERM");
    expect(await started.child.exited).toBe(0);

    const database = join(dir, ".dbzz", "data.db");
    const unrelated = join(dir, ".dbzz", "keep-me");
    expect(existsSync(database)).toBe(true);
    writeFileSync(unrelated, "unrelated");
    const reset = spawnCli(["reset", dir]);
    await reset.child.exited;
    expect(reset.output()).toContain("coordination retained");
    expect(existsSync(database)).toBe(false);
    expect(existsSync(`${database}.dbzz-coordination`)).toBe(true);
    expect(readFileSync(unrelated, "utf8")).toBe("unrelated");
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
    expect(output.indexOf(marker)).toBeLessThan(output.indexOf("[dbzz] ready on"));
    expect(await (await fetch(`http://127.0.0.1:${port}/ready`)).json()).toEqual({
      version: 1,
      ready: true,
      state: "ready",
    });

    started.child.kill("SIGTERM");
    expect(await started.child.exited).toBe(0);
  });

  test("failed drain releases ownership without recording a clean shutdown", async () => {
    const port = freePort();
    const dir = makeFixture({
      "app.ts": `
        import { v, defineApp, defineSchema, defineTable } from "@dbzz/server";
        const schema = defineSchema({ records: defineTable({ id: v.primaryKey() }) });
        export default defineApp({ schema });
      `,
      ".dbzz.config.json": JSON.stringify({ port }),
    });
    dirs.push(dir);
    const config = loadConfig(dir, { DBZZ_TELEMETRY: "disabled" });
    const failed = await startApp(config);
    const failure = new Error("injected drain failure");
    const drainServer = failed.server.drain.bind(failed.server);
    failed.server.drain = async () => {
      await drainServer();
      throw failure;
    };

    await expect(within(failed.drain(), "failed drain")).rejects.toBe(failure);
    await expect(failed.drain()).rejects.toBe(failure);
    expect(shutdownMarker(dir)).toBe(0n);

    const restarted = await startApp(config);
    try {
      expect(restarted.engine.recoveredFromCrash).toBe(true);
      await within(restarted.drain(), "successful drain");
      expect(shutdownMarker(dir)).toBe(1n);
    } finally {
      await restarted.drain().catch(() => {});
    }
  }, 20_000);

  test("start owns one live port continuously from codegen through readiness", async () => {
    const port = freePort();
    const dir = fixture(port);
    const gate = join(dir, "startup-gate");
    writeFileSync(
      join(dir, "app.ts"),
      `import { existsSync } from "node:fs";
while (!existsSync(${JSON.stringify(gate)})) await Bun.sleep(5);
${FIXTURE_APP}`,
    );
    const started = spawnCli(["start", dir], { DBZZ_TELEMETRY: "disabled" });

    const deadline = Date.now() + 5_000;
    let starting: Response | undefined;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/ready`);
        const body = await response.clone().json() as Record<string, unknown>;
        if (body.phase === "codegen") {
          starting = response;
          break;
        }
        await Bun.sleep(2);
      } catch {
        await Bun.sleep(5);
      }
    }
    expect(starting).toBeDefined();
    expect(starting!.status).toBe(503);
    expect(await starting!.json()).toEqual({
      version: 1,
      ready: false,
      state: "starting",
      phase: "codegen",
    });
    expect(await (await fetch(`http://127.0.0.1:${port}/live`)).json()).toEqual({
      version: 1,
      live: true,
    });

    let polling = true;
    let successfulLivenessProbes = 0;
    let refusedLivenessProbes = 0;
    const continuity = (async () => {
      while (polling) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/live`);
          if (response.ok) successfulLivenessProbes++;
          else refusedLivenessProbes++;
        } catch {
          refusedLivenessProbes++;
        }
        await Bun.sleep(2);
      }
    })();

    writeFileSync(gate, "continue");
    await started.waitFor("ready on");
    polling = false;
    await continuity;
    expect(successfulLivenessProbes).toBeGreaterThan(0);
    expect(refusedLivenessProbes).toBe(0);
    expect(await (await fetch(`http://127.0.0.1:${port}/ready`)).json()).toEqual({
      version: 1,
      ready: true,
      state: "ready",
    });

    started.child.kill("SIGTERM");
    expect(await started.child.exited).toBe(0);
  });

  test("SIGTERM during startup releases the listener without activating afterward", async () => {
    const port = freePort();
    const dir = fixture(port);
    const gate = join(dir, "startup-gate");
    writeFileSync(
      join(dir, "app.ts"),
      `import { existsSync } from "node:fs";
while (!existsSync(${JSON.stringify(gate)})) await Bun.sleep(5);
${FIXTURE_APP}`,
    );
    const started = spawnCli(["start", dir], { DBZZ_TELEMETRY: "disabled" });

    const deadline = Date.now() + 5_000;
    let observedStartup = false;
    while (Date.now() < deadline && !observedStartup) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/ready`);
        const body = await response.json() as Record<string, unknown>;
        observedStartup = response.status === 503 && body.phase === "codegen";
        if (!observedStartup) await Bun.sleep(2);
      } catch {
        await Bun.sleep(5);
      }
    }
    expect(observedStartup).toBe(true);

    started.child.kill("SIGTERM");
    const exitCode = await Promise.race([
      started.child.exited,
      Bun.sleep(2_000).then(() => {
        throw new Error("startup did not terminate after SIGTERM");
      }),
    ]);
    expect(exitCode).toBe(0);
    await started.drained;
    expect(started.output()).not.toContain("@@dbzz-startup");
    expect(started.output()).not.toContain("ready on");

    const rebound = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    await rebound.stop(true);
  }, 20_000);

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

    const db = new Database(join(dir, ".dbzz", "data.db"));
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
      join(dir, "app.ts"),
      FIXTURE_APP.replace(
        "typingEvents: defineEventTable({",
        `notes: defineTable({ id: v.primaryKey(), text: v.string() }),
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
    expect(types).toContain('export type Note = RowOf<Schema, "notes">;');

    // data survived the reload (safe reconciliation, same database)
    expect(await client.query<unknown, unknown[]>("messages.list", { channelId: 2n })).toHaveLength(1);
    client.close();
  }, 20_000);
});
