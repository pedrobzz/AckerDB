import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  renameSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import {
  DatabaseAlreadyOpenError,
  DatabaseOwnership,
  coordinationDatabaseEntries,
  coordinationDatabasePath,
  coordinationStagingArtifactPaths,
} from "../../src/database/ownership.ts";

const ownershipModule = new URL("../../src/database/ownership.ts", import.meta.url).href;
const RACE_CONTENDERS = Number(process.env.ACKERDB_OWNERSHIP_RACE_CONTENDERS ?? 30);
const roots: string[] = [];
const children = new Set<Subprocess>();
const servers = new Set<Server>();

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all([...children].map((child) => child.exited));
  children.clear();
  await Promise.all([...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.clear();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function freshDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), "ackerdb-ownership-"));
  roots.push(root);
  return join(root, "data.db");
}

function coordinationStage(path: string, suffix: string): string {
  return `${coordinationDatabasePath(path)}.ackerdb-bootstrap-${suffix}`;
}

type Outcome =
  | { readonly kind: "acquired" }
  | { readonly kind: "busy" }
  | { readonly kind: "error"; readonly message: string };

interface Gate {
  readonly server: Server;
  readonly socketPath: string;
  readonly ready: Promise<void>;
  readonly outcomes: Promise<ReadonlyMap<number, Outcome>>;
  start(): void;
  release(id: number): void;
  close(): Promise<void>;
}

async function createGate(expected: number, socketPath: string): Promise<Gate> {
  const sockets = new Map<number, Socket>();
  const results = new Map<number, Outcome>();
  let readyResolve!: () => void;
  let outcomesResolve!: (outcomes: ReadonlyMap<number, Outcome>) => void;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  const outcomes = new Promise<ReadonlyMap<number, Outcome>>((resolve) => {
    outcomesResolve = resolve;
  });
  const server = createServer((socket) => {
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffered += chunk;
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const message = JSON.parse(buffered.slice(0, newline)) as {
          readonly id: number;
          readonly kind: "ready" | Outcome["kind"];
          readonly message?: string;
        };
        buffered = buffered.slice(newline + 1);
        if (message.kind === "ready") {
          sockets.set(message.id, socket);
          if (sockets.size === expected) readyResolve();
          continue;
        }
        const outcome: Outcome = message.kind === "error"
          ? { kind: "error", message: message.message ?? "unknown child ownership error" }
          : { kind: message.kind };
        results.set(message.id, outcome);
        if (results.size === expected) outcomesResolve(new Map(results));
      }
    });
  });
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    server,
    socketPath,
    ready,
    outcomes,
    start() {
      for (const socket of sockets.values()) socket.write("start\n");
    },
    release(id: number) {
      const socket = sockets.get(id);
      if (socket === undefined) throw new Error(`ownership gate has no participant ${id}`);
      socket.write("release\n");
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      servers.delete(server);
    },
  };
}

function participant(path: string, id: number, socketPath: string): Subprocess {
  const script = `
    import { createConnection } from "node:net";
    import { DatabaseAlreadyOpenError, DatabaseOwnership } from ${JSON.stringify(ownershipModule)};
    const id = ${id};
    const socket = createConnection(${JSON.stringify(socketPath)});
    let buffered = "";
    let ownership;
    const send = (value) => socket.write(JSON.stringify({ id, ...value }) + "\\n");
    socket.setEncoding("utf8");
    socket.on("connect", () => send({ kind: "ready" }));
    socket.on("data", (chunk) => {
      buffered += chunk;
      while (true) {
        const newline = buffered.indexOf("\\n");
        if (newline < 0) break;
        const command = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (command === "start") {
          try {
            ownership = DatabaseOwnership.acquire(${JSON.stringify(path)});
            send({ kind: "acquired" });
          } catch (error) {
            if (error instanceof DatabaseAlreadyOpenError) {
              send({ kind: "busy" });
              socket.end();
              process.exitCode = 0;
            } else {
              send({ kind: "error", message: String(error?.stack ?? error) });
              socket.end();
              process.exitCode = 1;
            }
          }
        } else if (command === "release" && ownership !== undefined) {
          try {
            ownership.release();
            socket.end();
            process.exitCode = 0;
          } catch (error) {
            send({ kind: "error", message: String(error?.stack ?? error) });
            socket.end();
            process.exitCode = 1;
          }
        }
      }
    });
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  children.add(child);
  return child;
}

async function childFailure(child: Subprocess): Promise<string> {
  if (child.stderr === null || typeof child.stderr === "number") return "";
  return new Response(child.stderr).text();
}

async function expectSingleRaceWinner(paths: readonly string[], canonicalPath: string): Promise<void> {
  const gate = await createGate(paths.length, join(dirname(canonicalPath), `race-${paths.length}-gate.sock`));
  const contenders = paths.map((path, id) => participant(path, id, gate.socketPath));
  await gate.ready;
  gate.start();
  const outcomes = await gate.outcomes;
  expect([...outcomes.values()].filter((outcome) => outcome.kind === "error")).toEqual([]);
  expect([...outcomes.values()].filter((outcome) => outcome.kind === "acquired")).toHaveLength(1);
  expect([...outcomes.values()].filter((outcome) => outcome.kind === "busy")).toHaveLength(
    paths.length - 1,
  );

  const winner = [...outcomes].find(([, outcome]) => outcome.kind === "acquired")![0];
  gate.release(winner);
  const exits = await Promise.all(contenders.map((child) => child.exited));
  for (const contender of contenders) children.delete(contender);
  if (exits.some((code) => code !== 0)) {
    const diagnostics = await Promise.all(contenders.map(childFailure));
    throw new Error(`ownership contenders failed: ${diagnostics.join("\n")}`);
  }
  expect(exits).toEqual(Array(paths.length).fill(0));
  const canonical = statSync(coordinationDatabasePath(canonicalPath), { bigint: true });
  expect(canonical.nlink).toBe(1n);
  expect(canonical.mode & 0o777n).toBe(0o600n);
  expect(coordinationStagingArtifactPaths(canonicalPath)).toEqual([]);
  await gate.close();
}

describe("persistent SQLite database ownership", () => {
  test("one existing database has one owner through its real path and a symbolic-link alias", () => {
    const path = freshDatabase();
    const alias = join(dirname(path), "data-alias.db");
    writeFileSync(path, "existing database identity");
    symlinkSync(path, alias);

    const owner = DatabaseOwnership.acquire(path);
    expect(() => DatabaseOwnership.acquire(alias)).toThrow(DatabaseAlreadyOpenError);
    expect(existsSync(coordinationDatabasePath(alias))).toBe(false);
    owner.release();

    const aliasOwner = DatabaseOwnership.acquire(alias);
    expect(aliasOwner.path).toBe(realpathSync(path));
    expect(aliasOwner.coordinationPath).toBe(coordinationDatabasePath(realpathSync(path)));
    aliasOwner.release();
  });

  test("fails closed before opening a database that has an unknown hard-link alias", () => {
    const path = freshDatabase();
    const alias = join(dirname(path), "data-hard-link.db");
    writeFileSync(path, "existing database identity");
    linkSync(path, alias);

    expect(() => DatabaseOwnership.acquire(path)).toThrow("unproven hard links");
    expect(() => DatabaseOwnership.acquire(alias)).toThrow("unproven hard links");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(alias)).toBe(true);
    expect(statSync(path, { bigint: true }).nlink).toBe(2n);
  });

  test("removes only exact AckerDB data-publication aliases while holding ownership", () => {
    for (const kind of ["init", "restore"] as const) {
      const path = freshDatabase();
      const stage = `${path}.ackerdb-${kind}-00000000-0000-4000-8000-000000000004`;
      writeFileSync(path, "existing database identity");
      linkSync(path, stage);

      const owner = DatabaseOwnership.acquire(path);
      expect(existsSync(stage)).toBe(false);
      expect(statSync(path, { bigint: true }).nlink).toBe(1n);
      owner.release();
    }
  });

  test("fails closed for nonempty, foreign, corrupt, or non-DELETE coordination files", () => {
    const nonemptyPath = freshDatabase();
    const nonempty = new Database(coordinationDatabasePath(nonemptyPath), { create: true });
    try {
      nonempty.exec("CREATE TABLE foreign_state (value TEXT)");
    } finally {
      nonempty.close(false);
    }
    expect(() => DatabaseOwnership.acquire(nonemptyPath)).toThrow("invalid identity");

    const foreignPath = freshDatabase();
    const foreign = new Database(coordinationDatabasePath(foreignPath), { create: true });
    try {
      foreign.exec("PRAGMA application_id = 42");
    } finally {
      foreign.close(false);
    }
    expect(() => DatabaseOwnership.acquire(foreignPath)).toThrow("invalid identity");

    const corruptPath = freshDatabase();
    writeFileSync(coordinationDatabasePath(corruptPath), "not sqlite");
    expect(() => DatabaseOwnership.acquire(corruptPath)).toThrow();

    const walPath = freshDatabase();
    const owner = DatabaseOwnership.acquire(walPath);
    owner.release();
    const wal = new Database(coordinationDatabasePath(walPath));
    try {
      wal.query("PRAGMA journal_mode = WAL").get();
    } finally {
      wal.close(false);
    }
    expect(() => DatabaseOwnership.acquire(walPath)).toThrow("unsupported journal mode");

    const schemaPath = freshDatabase();
    const branded = DatabaseOwnership.acquire(schemaPath);
    branded.release();
    const schemaDatabase = new Database(coordinationDatabasePath(schemaPath));
    try {
      schemaDatabase.exec("CREATE TABLE unexpected_state (value TEXT)");
    } finally {
      schemaDatabase.close(false);
    }
    expect(() => DatabaseOwnership.acquire(schemaPath)).toThrow("unexpected schema objects");
  });

  test("allows exactly one winner in a gated two-process initialization race", async () => {
    const path = freshDatabase();
    await expectSingleRaceWinner([path, path], path);
  }, 10_000);

  test("allows exactly one winner in a gated 30-process initialization race", async () => {
    const path = freshDatabase();
    await expectSingleRaceWinner(Array(RACE_CONTENDERS).fill(path), path);
  }, 60_000);

  test("allows exactly one winner in a gated 30-process symbolic-link alias race", async () => {
    const path = freshDatabase();
    const alias = join(dirname(path), "data-alias.db");
    writeFileSync(path, "existing database identity");
    symlinkSync(path, alias);
    expect(existsSync(coordinationDatabasePath(path))).toBe(false);

    await expectSingleRaceWinner(
      Array.from({ length: RACE_CONTENDERS }, (_, index) => index % 2 === 0 ? path : alias),
      path,
    );
    expect(existsSync(coordinationDatabasePath(alias))).toBe(false);
  }, 60_000);

  test("preserves a pre-link crash file and removes only a post-link publication alias", () => {
    const path = freshDatabase();
    const coordination = coordinationDatabasePath(path);
    const preLink = coordinationStage(path, "00000000-0000-4000-8000-000000000001");

    const seed = DatabaseOwnership.acquire(path);
    seed.release();
    renameSync(coordination, preLink);
    expect(statSync(preLink, { bigint: true }).nlink).toBe(1n);

    const replacement = DatabaseOwnership.acquire(path);
    expect(existsSync(preLink)).toBe(true);
    expect(statSync(preLink, { bigint: true }).ino).not.toBe(
      statSync(coordination, { bigint: true }).ino,
    );
    expect(statSync(coordination, { bigint: true }).nlink).toBe(1n);
    expect(coordinationDatabaseEntries(path)).toContain(preLink);
    replacement.release();

    const postLink = coordinationStage(path, "00000000-0000-4000-8000-000000000002");
    linkSync(coordination, postLink);
    expect(statSync(coordination, { bigint: true }).nlink).toBe(2n);
    const recovered = DatabaseOwnership.acquire(path);
    expect(existsSync(postLink)).toBe(false);
    expect(existsSync(preLink)).toBe(true);
    expect(statSync(coordination, { bigint: true }).nlink).toBe(1n);
    recovered.release();
  });

  test("rejects an unknown hard-link alias instead of opening a multiply-linked canonical file", () => {
    const path = freshDatabase();
    const coordination = coordinationDatabasePath(path);
    const owner = DatabaseOwnership.acquire(path);
    owner.release();
    const unknownAlias = `${coordination}.manual-alias`;
    linkSync(coordination, unknownAlias);

    expect(() => DatabaseOwnership.acquire(path)).toThrow("expected exactly one");
    expect(existsSync(unknownAlias)).toBe(true);
    expect(statSync(coordination, { bigint: true }).nlink).toBe(2n);
  });

  test("never removes a publication-shaped alias after opening canonical SQLite", () => {
    const path = freshDatabase();
    const coordination = coordinationDatabasePath(path);
    const alias = coordinationStage(path, "00000000-0000-4000-8000-000000000003");
    const owner = DatabaseOwnership.acquire(path);

    linkSync(coordination, alias);
    expect(existsSync(alias)).toBe(true);
    expect(statSync(coordination, { bigint: true }).nlink).toBe(2n);
    owner.release();
    expect(existsSync(alias)).toBe(true);

    const next = DatabaseOwnership.acquire(path);
    expect(existsSync(alias)).toBe(false);
    expect(statSync(coordination, { bigint: true }).nlink).toBe(1n);
    next.release();
  });

  test("maps a live owner to the typed busy outcome and reacquires immediately after SIGKILL", async () => {
    const path = freshDatabase();
    const gate = await createGate(1, join(dirname(path), "kill-gate.sock"));
    const owner = participant(path, 0, gate.socketPath);
    await gate.ready;
    gate.start();
    expect((await gate.outcomes).get(0)).toEqual({ kind: "acquired" });

    expect(() => DatabaseOwnership.acquire(path)).toThrow(DatabaseAlreadyOpenError);
    owner.kill("SIGKILL");
    await owner.exited;
    children.delete(owner);

    const replacement = DatabaseOwnership.acquire(path);
    expect(coordinationDatabasePath(path)).toEndWith(".ackerdb-coordination");
    replacement.release();
    replacement.release();
    await gate.close();
  }, 10_000);

  test("does not clean a data-publication alias until the live owner has exited", async () => {
    const path = freshDatabase();
    const stage = `${path}.ackerdb-init-00000000-0000-4000-8000-000000000005`;
    writeFileSync(path, "existing database identity");
    const gate = await createGate(1, join(dirname(path), "publication-alias-gate.sock"));
    const owner = participant(path, 0, gate.socketPath);
    await gate.ready;
    gate.start();
    expect((await gate.outcomes).get(0)).toEqual({ kind: "acquired" });

    linkSync(path, stage);
    expect(() => DatabaseOwnership.acquire(path)).toThrow(DatabaseAlreadyOpenError);
    expect(existsSync(stage)).toBe(true);
    owner.kill("SIGKILL");
    await owner.exited;
    children.delete(owner);

    const replacement = DatabaseOwnership.acquire(path);
    expect(existsSync(stage)).toBe(false);
    expect(statSync(path, { bigint: true }).nlink).toBe(1n);
    replacement.release();
    await gate.close();
  }, 10_000);
});
