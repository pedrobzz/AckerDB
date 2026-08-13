import { parseReceivedFrame, parseSentFrame } from "ackerdb-test-support/client-transport";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import {
  decode,
  encode,
  parseClientMessage,
  parseServerMessage,
  type MutationReceipt,
} from "@ackerdb/core";
import { AckerDBClient, type AckerDBWebSocket } from "@ackerdb/client";
import { runCodegen } from "../../src/app/codegen.ts";
import { loadConfig } from "../../src/app/config.ts";
import { FIXTURE_APP, FIXTURE_MESSAGES, makeFixture } from "../support/fixture.ts";
import { freePort } from "../support/port.ts";

import { steps } from "../support/process.ts";

const CLI = new URL("../../src/commands/main.ts", import.meta.url).pathname;
const TEST_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 10_000;
const { withTimeout, eventually } = steps(STEP_TIMEOUT_MS);

const CRASH_BEFORE_COMMIT_MESSAGES = `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { v } from "@ackerdb/server";
import { mutation } from "../_generated/server.ts";

const crashSentinel = join(import.meta.dir, "..", ".precommit-crash-reached");

export const crashBeforeCommit = mutation({
  access: "public",
  args: { channelId: v.bigint(), body: v.string() },
  handler: async (ctx, args) => {
    const id = await ctx.db.messages.insert({
      ...args,
      body: \`\${args.body}:first\`,
      role: "member",
      payload: { tag: "nothing", value: null },
    });
    await ctx.db.messages.insert({
      ...args,
      body: \`\${args.body}:second\`,
      role: "member",
      payload: { tag: "nothing", value: null },
    });
    if (!existsSync(crashSentinel)) {
      writeFileSync(crashSentinel, "SQL work completed before SIGKILL", { flag: "wx" });
      process.kill(process.pid, "SIGKILL");
      await new Promise<never>(() => {});
    }
    return id;
  },
});
`;

const COMMIT_FAULT_SERVER = `
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  Engine,
  Registry,
  Runtime,
  reconcile,
  serve,
  type RuntimeHooks,
} from "@ackerdb/server";
import app from "./app.ts";
import * as messages from "./functions/messages.ts";

const port = Number(process.argv[2]);
const fault = process.env.ACKERDB_COMMIT_FAULT;
const durability = process.env.ACKERDB_DURABILITY;
if (durability !== "production" && durability !== "balanced") {
  throw new Error("ACKERDB_DURABILITY must be production or balanced");
}
const databaseDirectory = join(import.meta.dir, ".ackerdb");
mkdirSync(databaseDirectory, { recursive: true });
const engine = new Engine(app.schema, join(databaseDirectory, "data.db"), {
  durability,
  integrityCheck: "full",
});
reconcile(engine);
const hooks: RuntimeHooks | undefined = fault !== "wait" && fault !== "throw" ? undefined : {
  wait(stage, context) {
    if (stage !== "commit" || context.operation !== "mutation") return;
    console.log("@@durable-commit " + context.commitVersion.toString());
    if (fault === "wait") return new Promise<never>(() => {});
    if (fault === "throw") throw new Error("injected post-commit hook failure");
  },
};
const runtime = new Runtime({
  engine,
  registry: new Registry({ messages }),
  ...(hooks === undefined ? {} : { hooks }),
});
const server = serve({ runtime, port });
let draining: Promise<void> | undefined;
const drain = () => draining ??= server.drain().then(
  () => engine.close("clean"),
  (error) => {
    engine.close("unclean");
    throw error;
  },
);
const onSignal = () => void drain().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);
console.log("@@ready " + server.port);
await new Promise<never>(() => {});
`;

type CliProcess = Subprocess<"ignore", "pipe", "pipe">;

interface ObservedTransport {
  mutationRequestIds: string[];
  receipts: MutationReceipt[];
}

const dirs: string[] = [];
const clients: AckerDBClient[] = [];
const databases: Database[] = [];
const children = new Set<CliProcess>();

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    [...children].map(async (child) => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process already exited.
      }
      await child.exited.catch(() => {});
    }),
  );
  children.clear();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function portResponds(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/live`, {
      signal: AbortSignal.timeout(200),
    });
    await response.arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

async function assertNoServer(port: number): Promise<void> {
  await eventually(async () => {
    expect(await portResponds(port)).toBe(false);
  }, `port ${port} to have no running dev/start server`);
}

function spawnProcess(
  command: string[],
  env: Readonly<Record<string, string>> = {},
): {
  child: CliProcess;
  output(): string;
  waitFor(needle: string): Promise<string>;
  drained: Promise<void>;
} {
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ACKERDB_DURABILITY: "production",
      ...env,
    },
  }) as CliProcess;
  children.add(child);
  let stdout = "";
  let stderr = "";
  const drain = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        append(decoder.decode(chunk.value, { stream: true }));
      }
      append(decoder.decode());
    } finally {
      reader.releaseLock();
    }
  };
  const drained = Promise.all([
    drain(child.stdout, (text) => {
      stdout += text;
    }),
    drain(child.stderr, (text) => {
      stderr += text;
    }),
  ]).then(() => undefined);
  return {
    child,
    output: () => `${stdout}${stderr.length === 0 ? "" : `\n[stderr]\n${stderr}`}`,
    waitFor: async (needle) => {
      await eventually(() => {
        expect(`${stdout}\n[stderr]\n${stderr}`).toContain(needle);
      }, `${JSON.stringify(needle)} in CLI output`);
      return stdout;
    },
    drained,
  };
}

class ObservingWebSocket implements AckerDBWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  private readonly socket: WebSocket;

  constructor(url: string, private readonly observed: ObservedTransport) {
    this.socket = new WebSocket(url);
    this.socket.onopen = () => this.onopen?.();
    this.socket.onclose = () => this.onclose?.();
    this.socket.onerror = () => this.onerror?.();
    this.socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        const message = parseReceivedFrame(event.data, this.receivedCount++);
        if (message.t === "ok" && message.kind === "mutation") {
          this.observed.receipts.push(message.receipt);
        }
      }
      this.onmessage?.({ data: event.data });
    };
  }

  private sentCount = 0;
  private receivedCount = 0;

  send(data: string): void {
    const message = parseSentFrame(data, this.sentCount++);
    if (message.t === "m") this.observed.mutationRequestIds.push(message.mutationRequestId);
    this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }
}

function count(database: Database, sql: string, ...bindings: Array<string | bigint>): number {
  const row = database.query(sql).get(...bindings) as { count: number | bigint } | null;
  if (row === null) return 0;
  return Number(row.count);
}

function storageState(database: Database): {
  commitVersion: number;
  mutationRecords: number;
  mutationResultBytes: number;
} {
  const row = database
    .query(
      "SELECT commit_version, mutation_records, mutation_result_bytes FROM _ackerdb_state WHERE singleton = 1",
    )
    .get() as {
      commit_version: number | bigint;
      mutation_records: number | bigint;
      mutation_result_bytes: number | bigint;
    };
  return {
    commitVersion: Number(row.commit_version),
    mutationRecords: Number(row.mutation_records),
    mutationResultBytes: Number(row.mutation_result_bytes),
  };
}

function storedMutation(
  database: Database,
  sessionId: string,
  requestId: string,
): { result: string; commitVersion: number; durability: string } | null {
  const row = database.query(
    `SELECT result, commit_version AS commitVersion, durability
     FROM _ackerdb_mutations WHERE session_id = ? AND request_id = ?`,
  ).get(sessionId, requestId) as {
    result: string;
    commitVersion: number | bigint;
    durability: string;
  } | null;
  return row === null ? null : { ...row, commitVersion: Number(row.commitVersion) };
}

async function makeCommitFaultFixture(port: number): Promise<string> {
  const dir = makeFixture({
    "app.ts": FIXTURE_APP,
    "functions/messages.ts": FIXTURE_MESSAGES,
    "commit-fault-server.ts": COMMIT_FAULT_SERVER,
    ".ackerdb.config.json": JSON.stringify({ port }),
  });
  dirs.push(dir);
  await runCodegen(loadConfig(dir));
  return dir;
}

describe("process crash replay", () => {
  test("rolls back pre-COMMIT SQL and metadata, then executes the pending retry once", async () => {
    const port = await freePort();
    await assertNoServer(port);
    const dir = makeFixture({
      "app.ts": FIXTURE_APP,
      "functions/messages.ts": FIXTURE_MESSAGES,
      "functions/crash.ts": CRASH_BEFORE_COMMIT_MESSAGES,
      ".ackerdb.config.json": JSON.stringify({ port }),
    });
    dirs.push(dir);
    const sentinel = join(dir, ".precommit-crash-reached");

    const first = spawnProcess([process.execPath, CLI, "start", dir]);
    await first.waitFor("ready on");

    const observed: ObservedTransport = {
      mutationRequestIds: [],
      receipts: [],
    };
    const client = new AckerDBClient({
      url: `http://127.0.0.1:${port}`,
      credential: { kind: "anonymous" },
      clientSessionId: "precommit-crash-session",
      reconnect: { baseDelayMs: 20, maxDelayMs: 100, stableOpenMs: 100 },
      random: () => 0.5,
      createWebSocket: (url) => new ObservingWebSocket(url, observed),
    });
    clients.push(client);

    let mutationSettled = false;
    const mutation = client.mutation<{ channelId: bigint; body: string }, bigint>(
      "api.crash.crashBeforeCommit",
      { channelId: 9n, body: "precommit-sigkill" },
    );
    void mutation.then(
      () => {
        mutationSettled = true;
      },
      () => {
        mutationSettled = true;
      },
    );

    expect(await withTimeout(first.child.exited, "pre-COMMIT fixture SIGKILL exit")).not.toBe(0);
    await withTimeout(first.drained, "pre-COMMIT fixture output drain");
    children.delete(first.child);
    await assertNoServer(port);

    expect(existsSync(sentinel)).toBe(true);
    expect(observed.mutationRequestIds).toHaveLength(1);
    const requestId = observed.mutationRequestIds[0]!;
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(observed.receipts).toHaveLength(0);
    expect(mutationSettled).toBe(false);

    const database = new Database(join(dir, ".ackerdb", "data.db"), { readonly: true });
    databases.push(database);
    expect(count(
      database,
      "SELECT COUNT(*) AS count FROM messages WHERE channelId = ? AND body IN (?, ?)",
      9n,
      "precommit-sigkill:first",
      "precommit-sigkill:second",
    )).toBe(0);
    expect(count(
      database,
      "SELECT COUNT(*) AS count FROM _ackerdb_mutations WHERE session_id = ? AND request_id = ?",
      client.clientSessionId,
      requestId,
    )).toBe(0);
    // Version 1 is the first boot's Admin Credential mint; the killed mutation
    // contributed nothing, which is the point of the assertion.
    expect(storageState(database)).toEqual({
      commitVersion: 1,
      mutationRecords: 0,
      mutationResultBytes: 0,
    });

    const second = spawnProcess([process.execPath, CLI, "start", dir]);
    await second.waitFor("ready on");
    expect(typeof await withTimeout(mutation, "pre-COMMIT pending mutation retry")).toBe("bigint");
    await eventually(() => {
      expect(observed.mutationRequestIds.length).toBeGreaterThanOrEqual(2);
      expect(new Set(observed.mutationRequestIds)).toEqual(new Set([requestId]));
      expect(observed.receipts).toHaveLength(1);
      expect(observed.receipts[0]).toMatchObject({
        mutationRequestId: requestId,
        durability: "production",
        replay: "executed",
      });
    }, "same pre-COMMIT request ID to execute after restart");

    expect(count(
      database,
      "SELECT COUNT(*) AS count FROM messages WHERE channelId = ? AND body IN (?, ?)",
      9n,
      "precommit-sigkill:first",
      "precommit-sigkill:second",
    )).toBe(2);
    expect(count(
      database,
      "SELECT COUNT(*) AS count FROM messages WHERE channelId = ? AND body = ?",
      9n,
      "precommit-sigkill:first",
    )).toBe(1);
    expect(count(
      database,
      "SELECT COUNT(*) AS count FROM messages WHERE channelId = ? AND body = ?",
      9n,
      "precommit-sigkill:second",
    )).toBe(1);
    expect(count(
      database,
      "SELECT COUNT(*) AS count FROM _ackerdb_mutations WHERE session_id = ? AND request_id = ? AND commit_version = 2 AND durability = 'production'",
      client.clientSessionId,
      requestId,
    )).toBe(1);
    // Version 1 was the Admin Credential mint on the first boot, so the retried
    // mutation is the second commit this database has ever taken.
    const committedState = storageState(database);
    expect(committedState).toMatchObject({ commitVersion: 2, mutationRecords: 1 });
    expect(committedState.mutationResultBytes).toBeGreaterThan(0);

    client.close();
    clients.splice(clients.indexOf(client), 1);
    second.child.kill("SIGTERM");
    expect(await withTimeout(second.child.exited, "pre-COMMIT retry server graceful exit")).toBe(0);
    await withTimeout(second.drained, "pre-COMMIT retry server output drain");
    children.delete(second.child);
  }, TEST_TIMEOUT_MS);

  test("replays the same UUIDv7 after SIGKILL between durable commit and publication", async () => {
    const port = await freePort();
    await assertNoServer(port);
    const dir = await makeCommitFaultFixture(port);
    const command = [process.execPath, join(dir, "commit-fault-server.ts"), String(port)];
    const first = spawnProcess(command, { ACKERDB_COMMIT_FAULT: "wait" });
    await first.waitFor("@@ready");

    const observed: ObservedTransport = { mutationRequestIds: [], receipts: [] };
    const client = new AckerDBClient({
      url: `http://127.0.0.1:${port}`,
      credential: { kind: "anonymous" },
      clientSessionId: "post-commit-crash-session",
      reconnect: { baseDelayMs: 20, maxDelayMs: 100, stableOpenMs: 100 },
      random: () => 0.5,
      createWebSocket: (url) => new ObservingWebSocket(url, observed),
    });
    clients.push(client);

    let initialSnapshot!: () => void;
    const initial = new Promise<void>((resolve) => {
      initialSnapshot = resolve;
    });
    let committedSnapshot!: (rows: Array<{ id: bigint; body: string }>) => void;
    const committed = new Promise<Array<{ id: bigint; body: string }>>((resolve) => {
      committedSnapshot = resolve;
    });
    let committedSnapshotObserved = false;
    const resolutionOrder: string[] = [];
    client.subscribe<
      { channelId: bigint },
      Array<{ id: bigint; body: string }>
    >("api.messages.list", { channelId: 7n }, (rows) => {
      if (rows.length === 0) {
        initialSnapshot();
        return;
      }
      if (rows.some((row) => row.body === "post-commit-sigkill")) {
        committedSnapshotObserved = true;
        resolutionOrder.push("subscription");
        committedSnapshot(rows);
      }
    });
    await withTimeout(initial, "initial empty post-commit subscription");

    let mutationSettled = false;
    let mutationResolvedAfterSubscription = false;
    const mutation = client.mutation<{ channelId: bigint; body: string }, bigint>(
      "api.messages.send",
      { channelId: 7n, body: "post-commit-sigkill" },
    );
    void mutation.then(
      () => {
        mutationSettled = true;
        mutationResolvedAfterSubscription = committedSnapshotObserved;
        resolutionOrder.push("mutation");
      },
      () => {
        mutationSettled = true;
        resolutionOrder.push("mutation-error");
      },
    );
    await first.waitFor("@@durable-commit 1");

    expect(observed.mutationRequestIds).toHaveLength(1);
    const requestId = observed.mutationRequestIds[0]!;
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(observed.receipts).toHaveLength(0);
    expect(mutationSettled).toBe(false);
    expect(committedSnapshotObserved).toBe(false);
    expect(resolutionOrder).toEqual([]);

    const database = new Database(join(dir, ".ackerdb", "data.db"), { readonly: true });
    databases.push(database);
    expect(count(
      database,
      "SELECT COUNT(*) AS count FROM messages WHERE channelId = ? AND body = ?",
      7n,
      "post-commit-sigkill",
    )).toBe(1);
    expect(storedMutation(database, client.clientSessionId, requestId)).toEqual({
      result: encode({ ok: true, data: 1n }),
      commitVersion: 1,
      durability: "production",
    });
    expect(storageState(database)).toMatchObject({ commitVersion: 1, mutationRecords: 1 });

    first.child.kill("SIGKILL");
    expect(await withTimeout(first.child.exited, "post-commit fixture SIGKILL exit")).not.toBe(0);
    await withTimeout(first.drained, "post-commit fixture output drain");
    children.delete(first.child);
    await assertNoServer(port);

    const second = spawnProcess(command, { ACKERDB_COMMIT_FAULT: "off" });
    await second.waitFor("@@ready");
    expect(await withTimeout(mutation, "post-commit pending mutation replay")).toBe(1n);
    expect(await withTimeout(committed, "committed subscription snapshot after restart")).toEqual([
      expect.objectContaining({ id: 1n, body: "post-commit-sigkill" }),
    ]);
    expect(mutationResolvedAfterSubscription).toBe(true);
    expect(resolutionOrder).toEqual(["subscription", "mutation"]);
    await eventually(() => {
      expect(observed.mutationRequestIds.length).toBeGreaterThanOrEqual(2);
      expect(new Set(observed.mutationRequestIds)).toEqual(new Set([requestId]));
      expect(observed.receipts).toContainEqual({
        mutationRequestId: requestId,
        commitVersion: 1n,
        durability: "production",
        replay: "replayed",
        obligations: [1],
      });
    }, "same post-commit request ID and replayed receipt");

    expect(count(
      database,
      "SELECT COUNT(*) AS count FROM messages WHERE channelId = ? AND body = ?",
      7n,
      "post-commit-sigkill",
    )).toBe(1);
    expect(count(
      database,
      "SELECT COUNT(*) AS count FROM _ackerdb_mutations WHERE session_id = ? AND request_id = ?",
      client.clientSessionId,
      requestId,
    )).toBe(1);
    expect(storageState(database)).toMatchObject({ commitVersion: 1, mutationRecords: 1 });

    client.close();
    clients.splice(clients.indexOf(client), 1);
    second.child.kill("SIGTERM");
    expect(await withTimeout(second.child.exited, "post-commit replay server graceful exit")).toBe(0);
    await withTimeout(second.drained, "post-commit replay server output drain");
    children.delete(second.child);
  }, TEST_TIMEOUT_MS);

  // SIGKILL proves application-process crash consistency; it is not a balanced-mode power-loss claim.
  for (const durability of ["production", "balanced"] as const) {
    test(`preserves an acknowledged ${durability} mutation across process SIGKILL and advances its version`, async () => {
      const port = await freePort();
      await assertNoServer(port);
      const dir = await makeCommitFaultFixture(port);
      const command = [process.execPath, join(dir, "commit-fault-server.ts"), String(port)];
      const first = spawnProcess(command, {
        ACKERDB_COMMIT_FAULT: "throw",
        ACKERDB_DURABILITY: durability,
      });
      await first.waitFor("@@ready");

      const observed: ObservedTransport = { mutationRequestIds: [], receipts: [] };
      const client = new AckerDBClient({
        url: `http://127.0.0.1:${port}`,
        credential: { kind: "anonymous" },
        clientSessionId: `acknowledged-${durability}-crash-session`,
        reconnect: { baseDelayMs: 20, maxDelayMs: 100, stableOpenMs: 100 },
        random: () => 0.5,
        createWebSocket: (url) => new ObservingWebSocket(url, observed),
      });
      clients.push(client);

      const acknowledgedValue = await withTimeout(client.mutation<
        { channelId: bigint; body: string },
        bigint
      >(
        "api.messages.send",
        { channelId: 11n, body: "acknowledged-before-sigkill" },
      ), "acknowledged mutation");
      first.child.kill("SIGKILL");
      expect(acknowledgedValue).toBe(1n);
      expect(observed.receipts).toHaveLength(1);
      const acknowledgedReceipt = observed.receipts[0]!;
      const acknowledgedRequestId = acknowledgedReceipt.mutationRequestId;
      expect(acknowledgedReceipt).toEqual({
        mutationRequestId: acknowledgedRequestId,
        commitVersion: 1n,
        durability,
        replay: "executed",
        obligations: [],
      });

      expect(await withTimeout(first.child.exited, "acknowledged fixture SIGKILL exit")).not.toBe(0);
      await withTimeout(first.drained, "acknowledged fixture output drain");
      expect(first.output()).toContain("@@durable-commit 1");
      children.delete(first.child);
      await assertNoServer(port);

      const database = new Database(join(dir, ".ackerdb", "data.db"), { readonly: true });
      databases.push(database);
      expect(storedMutation(database, client.clientSessionId, acknowledgedRequestId)).toEqual({
        result: encode({ ok: true, data: 1n }),
        commitVersion: 1,
        durability,
      });
      expect(storageState(database)).toMatchObject({ commitVersion: 1, mutationRecords: 1 });

      const second = spawnProcess(command, {
        ACKERDB_COMMIT_FAULT: "off",
        ACKERDB_DURABILITY: durability,
      });
      await second.waitFor("@@ready");
      const rows = await withTimeout(client.query<
        { channelId: bigint },
        Array<{ id: bigint; body: string }>
      >("api.messages.list", { channelId: 11n }), "query after acknowledged crash");
      expect(rows).toEqual([
        expect.objectContaining({ id: 1n, body: "acknowledged-before-sigkill" }),
      ]);

      expect(await withTimeout(client.mutation<
        { channelId: bigint; body: string },
        bigint
      >("api.messages.send", { channelId: 11n, body: "after-restart" }), "mutation after restart")).toBe(2n);
      expect(observed.receipts.at(-1)).toMatchObject({
        commitVersion: 2n,
        durability,
        replay: "executed",
      });
      expect(count(
        database,
        "SELECT COUNT(*) AS count FROM messages WHERE channelId = ? AND body = ?",
        11n,
        "acknowledged-before-sigkill",
      )).toBe(1);
      expect(count(
        database,
        "SELECT COUNT(*) AS count FROM messages WHERE channelId = ? AND body = ?",
        11n,
        "after-restart",
      )).toBe(1);
      expect(count(
        database,
        "SELECT COUNT(*) AS count FROM _ackerdb_mutations WHERE session_id = ?",
        client.clientSessionId,
      )).toBe(2);
      expect(storageState(database)).toMatchObject({ commitVersion: 2, mutationRecords: 2 });

      client.close();
      clients.splice(clients.indexOf(client), 1);
      second.child.kill("SIGTERM");
      expect(await withTimeout(second.child.exited, "acknowledged restart server graceful exit")).toBe(0);
      await withTimeout(second.drained, "acknowledged restart server output drain");
      children.delete(second.child);
    }, TEST_TIMEOUT_MS);
  }
});
