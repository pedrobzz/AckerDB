import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import {
  decode,
  parseClientMessage,
  parseServerMessage,
  type MutationReceipt,
} from "@dbzz/core";
import { DbzzClient, type DbzzWebSocket } from "@dbzz/client";
import { FIXTURE_MESSAGES, FIXTURE_SCHEMA, makeFixture } from "./fixture.ts";

const CLI = new URL("../src/main.ts", import.meta.url).pathname;
const TEST_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 10_000;

type CliProcess = Subprocess<"ignore", "pipe", "pipe">;

interface ObservedTransport {
  holdTransitions: boolean;
  heldTransitions: number;
  mutationRequestIds: string[];
  receipts: MutationReceipt[];
}

const dirs: string[] = [];
const clients: DbzzClient[] = [];
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

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(handle));
}

async function eventually(assertion: () => void | Promise<void>, label: string): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(25);
    }
  }
  throw new Error(`timed out waiting for ${label}`, { cause: lastError });
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

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

function spawnStart(dir: string): {
  child: CliProcess;
  output(): string;
  waitFor(needle: string): Promise<string>;
  drained: Promise<void>;
} {
  const child = Bun.spawn([process.execPath, CLI, "start", dir], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      DBZZ_DURABILITY: "production",
      DBZZ_TELEMETRY: "disabled",
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
        expect(stdout).toContain(needle);
      }, `${JSON.stringify(needle)} in CLI output`);
      return stdout;
    },
    drained,
  };
}

class ObservingWebSocket implements DbzzWebSocket {
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
        const message = parseServerMessage(decode(event.data));
        if (message.t === "transition" && this.observed.holdTransitions) {
          this.observed.heldTransitions++;
          return;
        }
        if (message.t === "ok" && message.kind === "mutation") {
          this.observed.receipts.push(message.receipt);
        }
      }
      this.onmessage?.({ data: event.data });
    };
  }

  send(data: string): void {
    const message = parseClientMessage(decode(data));
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

describe("CLI crash replay", () => {
  test("replays one pending UUIDv7 mutation exactly once after SIGKILL", async () => {
    const port = await freePort();
    await assertNoServer(port);
    const dir = makeFixture({
      "schema.ts": FIXTURE_SCHEMA,
      "functions/messages.ts": FIXTURE_MESSAGES,
      ".zdb.config.json": JSON.stringify({ port }),
    });
    dirs.push(dir);

    const first = spawnStart(dir);
    const firstOutput = await first.waitFor("ready on");
    expect(firstOutput).toContain(
      '@@dbzz-startup {"telemetry":"disabled","durability":"production"}',
    );

    const observed: ObservedTransport = {
      holdTransitions: false,
      heldTransitions: 0,
      mutationRequestIds: [],
      receipts: [],
    };
    const client = new DbzzClient({
      url: `http://127.0.0.1:${port}`,
      credential: { kind: "anonymous" },
      clientSessionId: "crash-replay-session",
      reconnect: { baseDelayMs: 20, maxDelayMs: 100, stableOpenMs: 100 },
      random: () => 0.5,
      createWebSocket: (url) => new ObservingWebSocket(url, observed),
    });
    clients.push(client);

    let initialResolve!: () => void;
    const initial = new Promise<void>((resolve) => {
      initialResolve = resolve;
    });
    client.subscribe<
      { channelId: bigint },
      Array<{ id: bigint; channelId: bigint; body: string }>
    >("messages.list", { channelId: 7n }, (rows) => {
      if (rows.length === 0) initialResolve();
    });
    await withTimeout(initial, "initial empty subscription");

    observed.holdTransitions = true;
    let mutationSettled = false;
    const mutation = client.mutation<{ channelId: bigint; body: string }, bigint>(
      "messages.send",
      { channelId: 7n, body: "survives-sigkill" },
    );
    void mutation.then(
      () => {
        mutationSettled = true;
      },
      () => {
        mutationSettled = true;
      },
    );

    const database = new Database(join(dir, ".zdb", "data.db"), { readonly: true });
    databases.push(database);
    await eventually(() => {
      expect(observed.receipts).toHaveLength(1);
      expect(observed.receipts[0]).toMatchObject({
        durability: "production",
        replay: "executed",
      });
      expect(observed.receipts[0]!.obligations).toHaveLength(1);
      expect(observed.heldTransitions).toBeGreaterThanOrEqual(1);
      expect(count(
        database,
        "SELECT COUNT(*) AS count FROM messages WHERE channelId = ? AND body = ?",
        7n,
        "survives-sigkill",
      )).toBe(1);
      expect(count(
        database,
        "SELECT COUNT(*) AS count FROM _dbz_mutations WHERE session_id = ? AND request_id = ? AND durability = 'production'",
        client.clientSessionId,
        observed.mutationRequestIds[0]!,
      )).toBe(1);
    }, "durable effect, ledger, held convergence, and receipt");
    expect(mutationSettled).toBe(false);

    const requestId = observed.mutationRequestIds[0]!;
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    first.child.kill("SIGKILL");
    expect(await withTimeout(first.child.exited, "first server SIGKILL exit")).not.toBe(0);
    await withTimeout(first.drained, "first server output drain");
    children.delete(first.child);
    await assertNoServer(port);

    observed.holdTransitions = false;
    const second = spawnStart(dir);
    await second.waitFor("ready on");
    expect(await withTimeout(mutation, "pending mutation replay result")).toBe(1n);
    await eventually(() => {
      expect(observed.mutationRequestIds.length).toBeGreaterThanOrEqual(2);
      expect(new Set(observed.mutationRequestIds)).toEqual(new Set([requestId]));
      expect(observed.receipts.some((receipt) => receipt.replay === "replayed")).toBe(true);
    }, "same mutation request replay receipt");

    expect(count(
      database,
      "SELECT COUNT(*) AS count FROM messages WHERE channelId = ? AND body = ?",
      7n,
      "survives-sigkill",
    )).toBe(1);
    expect(count(
      database,
      "SELECT COUNT(*) AS count FROM _dbz_mutations WHERE session_id = ? AND request_id = ?",
      client.clientSessionId,
      requestId,
    )).toBe(1);

    client.close();
    clients.splice(clients.indexOf(client), 1);
    second.child.kill("SIGTERM");
    expect(await withTimeout(second.child.exited, "second server graceful exit")).toBe(0);
    await withTimeout(second.drained, "second server output drain");
    children.delete(second.child);
  }, TEST_TIMEOUT_MS);
});
