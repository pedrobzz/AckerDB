import { createReadStream, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import type { Engine } from "@ackerdb/server";
import {
  addSafe,
  checkpointTotals,
  liveFileAt,
  safeNumber,
  SHA256,
  type LiveFile,
} from "./metadata.ts";
import { fsyncPath } from "../shared/durability.ts";
import { exactFields } from "../shared/json.ts";

const MAX_JOURNAL_LINE_BYTES = 16 * 1_024;

export type FileMigrationOutcome = "copied" | "already-present";

export interface MigrationProgress {
  objects: {
    completed: number;
    copied: number;
    alreadyPresent: number;
    resumed: number;
  };
  bytes: {
    completed: number;
    copied: number;
    alreadyPresent: number;
    resumed: number;
  };
}

export interface MigrationJournalContext {
  readonly database: string;
  readonly commitVersion: string;
  readonly schemaFingerprint: string;
  readonly manifestFingerprint: string;
  readonly source: string;
  readonly target: string;
  readonly journalPath: string;
}

export interface PreparedMigrationJournal {
  readonly handle?: FileHandle;
  readonly progress: MigrationProgress;
  readonly afterId: bigint;
  readonly complete: boolean;
}

interface JournalObjectRecord {
  readonly type: "object";
  readonly id: string;
  readonly objectKey: string;
  readonly size: number;
  readonly sha256: string;
  readonly outcome: FileMigrationOutcome;
  readonly verifiedAt: number;
}

export function emptyMigrationProgress(): MigrationProgress {
  return {
    objects: { completed: 0, copied: 0, alreadyPresent: 0, resumed: 0 },
    bytes: { completed: 0, copied: 0, alreadyPresent: 0, resumed: 0 },
  };
}

function recordProgress(
  progress: MigrationProgress,
  outcome: FileMigrationOutcome,
  size: number,
): void {
  progress.objects.completed = addSafe(progress.objects.completed, 1, "completed object count");
  progress.bytes.completed = addSafe(progress.bytes.completed, size, "completed byte count");
  if (outcome === "copied") {
    progress.objects.copied = addSafe(progress.objects.copied, 1, "copied object count");
    progress.bytes.copied = addSafe(progress.bytes.copied, size, "copied byte count");
  } else {
    progress.objects.alreadyPresent = addSafe(
      progress.objects.alreadyPresent,
      1,
      "already-present object count",
    );
    progress.bytes.alreadyPresent = addSafe(
      progress.bytes.alreadyPresent,
      size,
      "already-present byte count",
    );
  }
}

async function createJournal(context: MigrationJournalContext): Promise<FileHandle> {
  const directory = dirname(context.journalPath);
  await fs.mkdir(directory, { recursive: true });
  const handle = await fs.open(context.journalPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({
      type: "header",
      format: 1,
      database: context.database,
      commitVersion: context.commitVersion,
      schemaFingerprint: context.schemaFingerprint,
      manifestFingerprint: context.manifestFingerprint,
      source: context.source,
      target: context.target,
    })}\n`, "utf8");
    await handle.sync();
    await fsyncPath(directory);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(context.journalPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function journalRecord(value: unknown, line: number): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`FileStore migration journal line ${line} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** One journal line's own subject, so every refusal names the same place. */
function journalLine(line: number): string {
  return `FileStore migration journal line ${line}`;
}

function canonicalId(value: unknown, line: number): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`FileStore migration journal line ${line} has an invalid File id`);
  }
  return BigInt(value);
}

function parseHeader(
  record: Record<string, unknown>,
  context: MigrationJournalContext,
  line: number,
): void {
  exactFields(record, [
    "type",
    "format",
    "database",
    "commitVersion",
    "schemaFingerprint",
    "manifestFingerprint",
    "source",
    "target",
  ], journalLine(line));
  if (record.type !== "header" || record.format !== 1) {
    throw new Error(`FileStore migration journal line ${line} is not a format 1 header`);
  }
  const expected: Readonly<Record<string, string>> = {
    database: context.database,
    commitVersion: context.commitVersion,
    schemaFingerprint: context.schemaFingerprint,
    manifestFingerprint: context.manifestFingerprint,
    source: context.source,
    target: context.target,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (record[field] !== value) {
      throw new Error(`FileStore migration journal ${field} does not match this maintenance operation`);
    }
  }
}

function parseObject(
  record: Record<string, unknown>,
  line: number,
  afterId: bigint,
): JournalObjectRecord & { readonly parsedId: bigint } {
  exactFields(record, [
    "type",
    "id",
    "objectKey",
    "size",
    "sha256",
    "outcome",
    "verifiedAt",
  ], journalLine(line));
  const parsedId = canonicalId(record.id, line);
  if (parsedId <= afterId) {
    throw new Error(`FileStore migration journal line ${line} does not advance by File id`);
  }
  if (typeof record.objectKey !== "string" || record.objectKey.length === 0) {
    throw new Error(`FileStore migration journal line ${line} has an invalid object key`);
  }
  const size = safeNumber(record.size, `FileStore migration journal line ${line} size`);
  if (typeof record.sha256 !== "string" || !SHA256.test(record.sha256)) {
    throw new Error(`FileStore migration journal line ${line} has an invalid SHA-256 digest`);
  }
  if (record.outcome !== "copied" && record.outcome !== "already-present") {
    throw new Error(`FileStore migration journal line ${line} has an invalid outcome`);
  }
  const verifiedAt = safeNumber(
    record.verifiedAt,
    `FileStore migration journal line ${line} verification time`,
  );
  return {
    type: "object",
    id: record.id as string,
    parsedId,
    objectKey: record.objectKey,
    size,
    sha256: record.sha256,
    outcome: record.outcome,
    verifiedAt,
  };
}

async function parseJournal(
  engine: Engine,
  context: MigrationJournalContext,
): Promise<PreparedMigrationJournal & { readonly durableBytes: number; readonly fileBytes: number }> {
  const metadata = await fs.lstat(context.journalPath);
  if (!metadata.isFile()) throw new Error("FileStore migration journal must be a regular file");

  const progress = emptyMigrationProgress();
  let afterId = 0n;
  let lastObject: JournalObjectRecord | undefined;
  let header = false;
  let complete = false;
  let lineNumber = 0;
  let durableBytes = 0;
  let pending = Buffer.alloc(0);
  const decoder = new TextDecoder("utf-8", { fatal: true });

  const parseLine = (bytes: Buffer): void => {
    lineNumber += 1;
    if (bytes.length === 0 || bytes.length > MAX_JOURNAL_LINE_BYTES) {
      throw new Error(
        `FileStore migration journal line ${lineNumber} must contain 1-${MAX_JOURNAL_LINE_BYTES} bytes`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(bytes));
    } catch (error) {
      throw new Error(`FileStore migration journal line ${lineNumber} is not valid JSON`, {
        cause: error,
      });
    }
    const record = journalRecord(parsed, lineNumber);
    if (!header) {
      parseHeader(record, context, lineNumber);
      header = true;
      return;
    }
    if (complete) throw new Error("FileStore migration journal contains records after completion");
    if (record.type === "object") {
      const object = parseObject(record, lineNumber, afterId);
      afterId = object.parsedId;
      lastObject = object;
      recordProgress(progress, object.outcome, object.size);
      return;
    }
    if (record.type === "complete") {
      exactFields(record, ["type", "objects", "bytes", "finishedAt"], journalLine(lineNumber));
      const objects = safeNumber(record.objects, `FileStore migration journal line ${lineNumber} objects`);
      const bytes = safeNumber(record.bytes, `FileStore migration journal line ${lineNumber} bytes`);
      safeNumber(record.finishedAt, `FileStore migration journal line ${lineNumber} finish time`);
      if (objects !== progress.objects.completed || bytes !== progress.bytes.completed) {
        throw new Error("FileStore migration journal completion does not match its checkpoints");
      }
      complete = true;
      return;
    }
    throw new Error(`FileStore migration journal line ${lineNumber} has an unknown record type`);
  };

  for await (const chunk of createReadStream(context.journalPath, { highWaterMark: 4_096 })) {
    const bytes = pending.length === 0
      ? chunk as Buffer
      : Buffer.concat([pending, chunk as Buffer]);
    let start = 0;
    for (;;) {
      const newline = bytes.indexOf(0x0a, start);
      if (newline === -1) break;
      const line = bytes.subarray(start, newline);
      parseLine(line);
      durableBytes = addSafe(durableBytes, line.length + 1, "journal byte offset");
      start = newline + 1;
    }
    pending = Buffer.from(bytes.subarray(start));
    if (pending.length > MAX_JOURNAL_LINE_BYTES) {
      throw new Error(`FileStore migration journal has a line larger than ${MAX_JOURNAL_LINE_BYTES} bytes`);
    }
  }
  // A crash can tear only the final append. It was never a durable checkpoint
  // without its newline, so discard it before appending the resumed record.
  if (!header) throw new Error("FileStore migration journal has no complete header");

  if (lastObject !== undefined) {
    const current = liveFileAt(engine, afterId);
    if (
      current === null ||
      current.objectKey !== lastObject.objectKey ||
      current.size !== lastObject.size ||
      current.sha256 !== lastObject.sha256
    ) {
      throw new Error("FileStore migration journal checkpoint does not match File metadata");
    }
    const checkpoint = checkpointTotals(engine, afterId);
    if (
      checkpoint.objects !== progress.objects.completed ||
      checkpoint.bytes !== progress.bytes.completed
    ) {
      throw new Error("FileStore migration journal does not cover every earlier live File");
    }
  }
  progress.objects.resumed = progress.objects.completed;
  progress.bytes.resumed = progress.bytes.completed;
  return { progress, afterId, complete, durableBytes, fileBytes: metadata.size };
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

export async function prepareMigrationJournal(
  engine: Engine,
  context: MigrationJournalContext,
): Promise<PreparedMigrationJournal> {
  try {
    return {
      handle: await createJournal(context),
      progress: emptyMigrationProgress(),
      afterId: 0n,
      complete: false,
    };
  } catch (error) {
    if (nodeErrorCode(error) !== "EEXIST") throw error;
  }

  const parsed = await parseJournal(engine, context);
  if (parsed.durableBytes !== parsed.fileBytes) {
    const repair = await fs.open(context.journalPath, "r+");
    try {
      await repair.truncate(parsed.durableBytes);
      await repair.sync();
    } finally {
      await repair.close();
    }
  }
  return parsed.complete
    ? parsed
    : { ...parsed, handle: await fs.open(context.journalPath, "a", 0o600) };
}

async function appendJournal(handle: FileHandle, record: object): Promise<void> {
  await handle.appendFile(`${JSON.stringify(record)}\n`, "utf8");
  await handle.sync();
}

/** Advance in-memory progress only after the complete per-object line is fsynced. */
export async function checkpointMigratedFile(
  handle: FileHandle,
  progress: MigrationProgress,
  file: LiveFile,
  outcome: FileMigrationOutcome,
  verifiedAt: number,
): Promise<void> {
  await appendJournal(handle, {
    type: "object",
    id: file.id.toString(),
    objectKey: file.objectKey,
    size: file.size,
    sha256: file.sha256,
    outcome,
    verifiedAt,
  } satisfies JournalObjectRecord);
  recordProgress(progress, outcome, file.size);
}

export function completeMigrationJournal(
  handle: FileHandle,
  progress: MigrationProgress,
  finishedAt: number,
): Promise<void> {
  return appendJournal(handle, {
    type: "complete",
    objects: progress.objects.completed,
    bytes: progress.bytes.completed,
    finishedAt,
  });
}
