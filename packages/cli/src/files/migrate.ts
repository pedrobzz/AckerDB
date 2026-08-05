import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  FileStoreError,
  type Engine,
  type FileStore,
} from "@ackerdb/server";
import { checkedFileStoreIdentity } from "@ackerdb/server/files/binding";
import {
  checkpointMigratedFile,
  completeMigrationJournal,
  emptyMigrationProgress,
  prepareMigrationJournal,
  type FileMigrationOutcome,
  type MigrationJournalContext,
  type MigrationProgress,
  type PreparedMigrationJournal,
} from "./journal.ts";
import {
  addSafe,
  liveFiles,
  scanLiveFileManifest,
  type FileMigrationTotals,
  type LiveFile,
} from "./metadata.ts";

const PROGRESS_CHECKPOINT_CADENCE = 64;

export type FileStoreMigrationStage =
  | "target-probe"
  | "database-scan"
  | "journal"
  | "target-verification"
  | "source-read"
  | "target-copy"
  | "journal-checkpoint"
  | "final-verification";

export interface FileStoreMigrationMeasure {
  /** Null when failure occurred before the live-File aggregate completed. */
  readonly total: number | null;
  /** Durably checkpointed objects/bytes, including earlier invocations. */
  readonly completed: number;
  /** Objects/bytes written to the target across the complete journal. */
  readonly copied: number;
  /** Objects/bytes already verified at the target without another write. */
  readonly alreadyPresent: number;
  /** Checkpointed before this invocation began; overlaps copied/alreadyPresent. */
  readonly resumed: number;
}

interface FileStoreMigrationReportBase {
  readonly format: 1;
  readonly operation: "file-store-migration";
  readonly database: string;
  readonly commitVersion: string;
  readonly source: string;
  readonly target: string;
  readonly journalPath: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  readonly objects: FileStoreMigrationMeasure;
  readonly bytes: FileStoreMigrationMeasure;
}

export interface FileStoreMigrationCompleteReport extends FileStoreMigrationReportBase {
  readonly state: "complete";
}

export interface FileStoreMigrationFailedReport extends FileStoreMigrationReportBase {
  readonly state: "failed";
  readonly failure: {
    readonly stage: FileStoreMigrationStage;
    readonly message: string;
    readonly file?: {
      readonly id: string;
      readonly objectKey: string;
      readonly size: number;
      readonly sha256: string;
    };
  };
}

export type FileStoreMigrationReport =
  | FileStoreMigrationCompleteReport
  | FileStoreMigrationFailedReport;

export interface FileStoreMigrationProgressEvent {
  readonly format: 1;
  readonly operation: "file-store-migration-progress";
  readonly state: "running" | "complete";
  readonly objects: FileStoreMigrationMeasure;
  readonly bytes: FileStoreMigrationMeasure;
}

export class FileStoreMigrationError extends Error {
  override readonly name = "FileStoreMigrationError";
  readonly report: FileStoreMigrationFailedReport;

  constructor(report: FileStoreMigrationFailedReport, cause: unknown) {
    const file = report.failure.file;
    super(
      `FileStore migration failed during ${report.failure.stage}` +
        (file === undefined ? "" : ` for ${file.objectKey}`) +
        `: ${report.failure.message}`,
      { cause },
    );
    this.report = report;
  }
}

export interface MigrateFileStoreInput {
  /** Maintenance-owned Engine. Its database ownership excludes a running app. */
  readonly engine: Engine;
  readonly source: FileStore;
  readonly target: FileStore;
  /** Stable, non-secret descriptions bound into the resumable journal. */
  readonly sourceIdentity: string;
  readonly targetIdentity: string;
  readonly journalPath: string;
  readonly signal?: AbortSignal;
  /** Aggregate durable progress only; object identities are intentionally absent. */
  readonly onProgress?: (
    event: FileStoreMigrationProgressEvent,
  ) => void | Promise<void>;
}

async function digestStream(
  body: ReadableStream<Uint8Array>,
): Promise<{ size: number; sha256: string }> {
  const digest = createHash("sha256");
  let size = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size = addSafe(size, result.value.byteLength, "File stream byte count");
      digest.update(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return { size, sha256: digest.digest("hex") };
}

type TargetInspection =
  | { readonly state: "absent" }
  | { readonly state: "valid" }
  | {
      readonly state: "invalid";
      readonly actual: {
        readonly attributesSize: number;
        readonly bodySize: number;
        readonly sha256: string;
      };
    };

async function inspectTarget(
  target: FileStore,
  file: LiveFile,
  signal: AbortSignal | undefined,
): Promise<TargetInspection> {
  let opened: Awaited<ReturnType<FileStore["open"]>>;
  try {
    opened = await target.open(file.objectKey, { signal });
  } catch (error) {
    if (error instanceof FileStoreError && error.code === "not_found") return { state: "absent" };
    throw error;
  }
  const actual = await digestStream(opened.body);
  return opened.attributes.size === file.size &&
    actual.size === file.size &&
    actual.sha256 === file.sha256
    ? { state: "valid" }
    : {
        state: "invalid",
        actual: {
          attributesSize: opened.attributes.size,
          bodySize: actual.size,
          sha256: actual.sha256,
        },
      };
}

function invalidTargetDescription(
  inspection: Extract<TargetInspection, { readonly state: "invalid" }>,
): string {
  return `provider size ${inspection.actual.attributesSize}, streamed size ` +
    `${inspection.actual.bodySize}, and SHA-256 ${inspection.actual.sha256}`;
}

function progressMeasure(
  total: number | null,
  progress: MigrationProgress,
  dimension: "objects" | "bytes",
): FileStoreMigrationMeasure {
  return { total, ...progress[dimension] };
}

function baseReport(
  context: MigrationJournalContext,
  startedAt: number,
  finishedAt: number,
  totals: FileMigrationTotals | null,
  progress: MigrationProgress,
): FileStoreMigrationReportBase {
  return {
    format: 1,
    operation: "file-store-migration",
    database: context.database,
    commitVersion: context.commitVersion,
    source: context.source,
    target: context.target,
    journalPath: context.journalPath,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt - startedAt),
    objects: progressMeasure(totals?.objects ?? null, progress, "objects"),
    bytes: progressMeasure(totals?.bytes ?? null, progress, "bytes"),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ensureNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("FileStore migration was canceled", { cause: signal.reason });
}

async function copyAndVerify(
  input: MigrateFileStoreInput,
  file: LiveFile,
  setStage: (stage: FileStoreMigrationStage) => void,
): Promise<FileMigrationOutcome> {
  setStage("target-verification");
  if ((await inspectTarget(input.target, file, input.signal)).state === "valid") {
    return "already-present";
  }

  setStage("source-read");
  const source = await input.source.open(file.objectKey, { signal: input.signal });
  if (source.attributes.size !== file.size) {
    await source.body.cancel().catch(() => undefined);
    throw new Error(
      `source size ${source.attributes.size} does not match File metadata size ${file.size}`,
    );
  }

  setStage("target-copy");
  const stored = await input.target.put(file.objectKey, source.body, {
    signal: input.signal,
    contentLength: file.size,
  });
  if (stored.size !== file.size || stored.sha256 !== file.sha256) {
    throw new Error(
      `copied bytes (${stored.size}, ${stored.sha256}) do not match File metadata ` +
        `(${file.size}, ${file.sha256})`,
    );
  }

  setStage("target-verification");
  const verified = await inspectTarget(input.target, file, input.signal);
  if (verified.state !== "valid") {
    const actual = verified.state === "absent"
      ? "missing"
      : invalidTargetDescription(verified);
    throw new Error(`target verification found ${actual} after copy`);
  }
  return "copied";
}

async function requireValidTarget(
  target: FileStore,
  file: LiveFile,
  signal: AbortSignal | undefined,
): Promise<void> {
  const inspected = await inspectTarget(target, file, signal);
  if (inspected.state === "valid") return;
  const actual = inspected.state === "absent"
    ? "missing"
    : invalidTargetDescription(inspected);
  throw new Error(`final target verification found ${actual}`);
}

/**
 * Copy every live immutable File into another FileStore under its unchanged
 * object key. The caller owns an offline Engine and switches configuration only
 * after this returns `complete`; this operation never deletes source bytes or
 * mutates database metadata.
 */
export async function migrateFileStore(
  input: MigrateFileStoreInput,
): Promise<FileStoreMigrationCompleteReport> {
  const startedAt = Date.now();
  const database = input.engine.path;
  const commitVersion = input.engine.commitVersion().toString();
  const schemaFingerprint = input.engine.schemaFingerprint();
  const sourceIdentity = checkedFileStoreIdentity(input.sourceIdentity, "sourceIdentity");
  const targetIdentity = checkedFileStoreIdentity(input.targetIdentity, "targetIdentity");
  const resolvedJournalPath = resolve(input.journalPath);
  let progress = emptyMigrationProgress();
  let totals: FileMigrationTotals | null = null;
  let stage: FileStoreMigrationStage = "target-probe";
  let currentFile: LiveFile | undefined;
  let journal: PreparedMigrationJournal["handle"];
  let lastProgressObjects = 0;
  let context: MigrationJournalContext = {
    database,
    commitVersion,
    schemaFingerprint,
    manifestFingerprint: "unavailable",
    source: sourceIdentity,
    target: targetIdentity,
    journalPath: resolvedJournalPath,
  };

  try {
    ensureNotAborted(input.signal);
    // Prove the destination is writable before reading File metadata or source bytes.
    await input.target.probe({ signal: input.signal });

    stage = "database-scan";
    const initialManifest = await scanLiveFileManifest(input.engine);
    totals = initialManifest;
    context = { ...context, manifestFingerprint: initialManifest.fingerprint };

    stage = "journal";
    const prepared = await prepareMigrationJournal(input.engine, context);
    progress = prepared.progress;
    lastProgressObjects = progress.objects.completed;
    if (progress.objects.completed > totals.objects || progress.bytes.completed > totals.bytes) {
      throw new Error("FileStore migration journal progress exceeds live File metadata");
    }
    if (!prepared.complete) {
      journal = prepared.handle;
      if (journal === undefined) {
        throw new Error("resumable FileStore migration journal is not writable");
      }

      for await (const file of liveFiles(input.engine, prepared.afterId)) {
        ensureNotAborted(input.signal);
        currentFile = file;
        const outcome = await copyAndVerify(input, file, (value) => {
          stage = value;
        });
        stage = "journal-checkpoint";
        await checkpointMigratedFile(journal, progress, file, outcome, Date.now());
        if (
          input.onProgress !== undefined &&
          progress.objects.completed - lastProgressObjects >= PROGRESS_CHECKPOINT_CADENCE
        ) {
          await input.onProgress({
            format: 1,
            operation: "file-store-migration-progress",
            state: "running",
            objects: progressMeasure(totals.objects, progress, "objects"),
            bytes: progressMeasure(totals.bytes, progress, "bytes"),
          });
          lastProgressObjects = progress.objects.completed;
        }
      }
    }

    if (
      progress.objects.completed !== totals.objects ||
      progress.bytes.completed !== totals.bytes
    ) {
      throw new Error("FileStore migration journal does not match live File totals");
    }

    stage = "final-verification";
    const finalManifest = await scanLiveFileManifest(input.engine, async (file) => {
      ensureNotAborted(input.signal);
      currentFile = file;
      await requireValidTarget(input.target, file, input.signal);
    });
    if (
      finalManifest.fingerprint !== initialManifest.fingerprint ||
      finalManifest.objects !== initialManifest.objects ||
      finalManifest.bytes !== initialManifest.bytes
    ) {
      currentFile = undefined;
      throw new Error("live File metadata changed during maintenance migration");
    }

    const finishedAt = Date.now();
    if (!prepared.complete) {
      stage = "journal-checkpoint";
      await completeMigrationJournal(journal!, progress, finishedAt);
      await journal!.close();
      journal = undefined;
    }
    if (input.onProgress !== undefined) {
      await input.onProgress({
        format: 1,
        operation: "file-store-migration-progress",
        state: "complete",
        objects: progressMeasure(totals.objects, progress, "objects"),
        bytes: progressMeasure(totals.bytes, progress, "bytes"),
      });
    }
    return { ...baseReport(context, startedAt, finishedAt, totals, progress), state: "complete" };
  } catch (error) {
    const cleanup: unknown[] = [];
    if (journal !== undefined) {
      try {
        await journal.close();
      } catch (closeError) {
        cleanup.push(closeError);
      }
    }
    const cause = cleanup.length === 0
      ? error
      : new AggregateError([error, ...cleanup], "FileStore migration and journal cleanup both failed");
    const finishedAt = Date.now();
    const report: FileStoreMigrationFailedReport = {
      ...baseReport(context, startedAt, finishedAt, totals, progress),
      state: "failed",
      failure: {
        stage,
        message: errorMessage(error),
        ...(currentFile === undefined
          ? {}
          : {
              file: {
                id: currentFile.id.toString(),
                objectKey: currentFile.objectKey,
                size: currentFile.size,
                sha256: currentFile.sha256,
              },
            }),
      },
    };
    throw new FileStoreMigrationError(report, cause);
  }
}
