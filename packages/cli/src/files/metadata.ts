import { createHash } from "node:crypto";
import type { Engine } from "@ackerdb/server";

const FILES_TABLE = "_ackerdb_files";
const FILE_BATCH_SIZE = 128;

export const SHA256 = /^[0-9a-f]{64}$/;

export interface LiveFile {
  readonly id: bigint;
  readonly objectKey: string;
  readonly size: number;
  readonly sha256: string;
}

export interface FileMigrationTotals {
  readonly objects: number;
  readonly bytes: number;
}

export interface LiveFileManifest extends FileMigrationTotals {
  readonly fingerprint: string;
}

export function safeNumber(value: unknown, path: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${path} is not a non-negative safe integer`);
  }
  return number;
}

export function addSafe(left: number, right: number, path: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new Error(`${path} exceeds JavaScript's safe integer range`);
  return sum;
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function liveFile(engine: Engine, raw: Record<string, unknown>): LiveFile {
  const row = engine.rowFromSql(engine.plan(FILES_TABLE), raw);
  if (row.state !== "active" && row.state !== "pending") {
    throw new Error(`File ${String(row.id)} has invalid live state ${JSON.stringify(row.state)}`);
  }
  if (typeof row.id !== "bigint" || row.id <= 0n) {
    throw new Error("File metadata has an invalid id");
  }
  if (typeof row.objectKey !== "string" || row.objectKey.length === 0) {
    throw new Error(`File ${row.id} has an invalid object key`);
  }
  if (typeof row.size !== "number" || !Number.isSafeInteger(row.size) || row.size < 0) {
    throw new Error(`File ${row.id} has an invalid byte size`);
  }
  if (typeof row.sha256 !== "string" || !SHA256.test(row.sha256)) {
    throw new Error(`File ${row.id} has an invalid SHA-256 digest`);
  }
  return {
    id: row.id,
    objectKey: row.objectKey,
    size: row.size,
    sha256: row.sha256,
  };
}

export function checkpointTotals(engine: Engine, throughId: bigint): FileMigrationTotals {
  const plan = engine.plan(FILES_TABLE);
  const primaryKey = plan.columns.get(plan.pk)?.phys[0]?.name;
  const state = plan.columns.get("state")?.phys[0]?.name;
  const size = plan.columns.get("size")?.phys[0]?.name;
  if (primaryKey === undefined || state === undefined || size === undefined) {
    throw new Error("File framework schema is unavailable");
  }
  const row = engine.statement(
    engine.reader,
    `SELECT COUNT(*) AS objects, COALESCE(SUM(${quote(size)}), 0) AS bytes ` +
      `FROM ${quote(plan.name)} WHERE ${quote(primaryKey)} <= ? AND ${quote(state)} <> ?`,
  ).get(throughId, "deleting") as { objects: unknown; bytes: unknown } | null;
  if (row === null) throw new Error("File checkpoint aggregate returned no row");
  return {
    objects: safeNumber(row.objects, "checkpointed File object count"),
    bytes: safeNumber(row.bytes, "checkpointed File byte count"),
  };
}

export function liveFileAt(engine: Engine, id: bigint): LiveFile | null {
  const plan = engine.plan(FILES_TABLE);
  const primaryKey = plan.columns.get(plan.pk)?.phys[0]?.name;
  const state = plan.columns.get("state")?.phys[0]?.name;
  if (primaryKey === undefined || state === undefined) {
    throw new Error("File framework schema is unavailable");
  }
  const raw = engine.statement(
    engine.reader,
    `SELECT ${plan.readProjection} FROM ${quote(plan.name)} ` +
      `WHERE ${quote(primaryKey)} = ? AND ${quote(state)} <> ?`,
  ).get(id, "deleting") as Record<string, unknown> | null;
  return raw === null ? null : liveFile(engine, raw);
}

/** Enumerate bounded pages in File-id order; no global row collection is retained. */
export async function* liveFiles(engine: Engine, afterId: bigint): AsyncGenerator<LiveFile> {
  const plan = engine.plan(FILES_TABLE);
  const primaryKey = plan.columns.get(plan.pk)?.phys[0]?.name;
  const state = plan.columns.get("state")?.phys[0]?.name;
  if (primaryKey === undefined || state === undefined) {
    throw new Error("File framework schema is unavailable");
  }
  const statement = engine.statement(
    engine.reader,
    `SELECT ${plan.readProjection} FROM ${quote(plan.name)} ` +
      `WHERE ${quote(primaryKey)} > ? AND ${quote(state)} <> ? ` +
      `ORDER BY ${quote(primaryKey)} ASC LIMIT ?`,
  );
  let cursor = afterId;
  for (;;) {
    const page = statement.all(cursor, "deleting", FILE_BATCH_SIZE) as Record<string, unknown>[];
    if (page.length === 0) return;
    for (const raw of page) {
      const file = liveFile(engine, raw);
      if (file.id <= cursor) throw new Error("File enumeration did not advance monotonically");
      cursor = file.id;
      yield file;
    }
  }
}

/**
 * Hash every live immutable byte identity in File-id order without retaining
 * the manifest in memory. An optional visitor shares the same bounded scan.
 */
export async function scanLiveFileManifest(
  engine: Engine,
  visit?: (file: LiveFile) => void | Promise<void>,
): Promise<LiveFileManifest> {
  const hash = createHash("sha256");
  hash.update("ackerdb-live-file-manifest-v1\n");
  let objects = 0;
  let bytes = 0;
  for await (const file of liveFiles(engine, 0n)) {
    hash.update(JSON.stringify([
      file.id.toString(),
      file.objectKey,
      file.size,
      file.sha256,
    ]));
    hash.update("\n");
    objects = addSafe(objects, 1, "File object count");
    bytes = addSafe(bytes, file.size, "File byte count");
    await visit?.(file);
  }
  return { objects, bytes, fingerprint: hash.digest("hex") };
}
