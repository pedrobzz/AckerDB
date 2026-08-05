import type { Engine } from "../database/engine.ts";
import {
  CorruptDatabaseError,
  IncompatibleDatabaseError,
} from "../shared/errors.ts";

const BINDING_KEY = "file_store_binding";
const MAX_IDENTITY_LENGTH = 1_024;

type FileStoreBinding =
  | {
      readonly format: 1;
      readonly state: "stable";
      readonly identity: string;
    }
  | {
      readonly format: 1;
      readonly state: "verified-transition";
      readonly source: string;
      readonly target: string;
    };

export function checkedFileStoreIdentity(value: string, path: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    value.length > MAX_IDENTITY_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(
      `${path} must be a non-empty, trimmed FileStore identity of at most ${MAX_IDENTITY_LENGTH} characters`,
    );
  }
  return value;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length &&
    actual.every((field, index) => field === expected[index]);
}

function parseBinding(value: string): FileStoreBinding {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new CorruptDatabaseError("FileStore binding is not valid JSON", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CorruptDatabaseError("FileStore binding must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.format === 1 &&
    record.state === "stable" &&
    exactFields(record, ["format", "state", "identity"]) &&
    typeof record.identity === "string"
  ) {
    try {
      return {
        format: 1,
        state: "stable",
        identity: checkedFileStoreIdentity(record.identity, "stored FileStore"),
      };
    } catch (error) {
      throw new CorruptDatabaseError("FileStore binding contains an invalid stable identity", {
        cause: error,
      });
    }
  }
  if (
    record.format === 1 &&
    record.state === "verified-transition" &&
    exactFields(record, ["format", "state", "source", "target"]) &&
    typeof record.source === "string" &&
    typeof record.target === "string"
  ) {
    try {
      const source = checkedFileStoreIdentity(record.source, "stored FileStore transition source");
      const target = checkedFileStoreIdentity(record.target, "stored FileStore transition target");
      if (source === target) {
        throw new TypeError("FileStore transition source and target must differ");
      }
      return { format: 1, state: "verified-transition", source, target };
    } catch (error) {
      throw new CorruptDatabaseError("FileStore binding contains an invalid verified transition", {
        cause: error,
      });
    }
  }
  throw new CorruptDatabaseError("FileStore binding has an unsupported shape");
}

function readBinding(engine: Engine): FileStoreBinding | null {
  const row = engine.writer
    .query("SELECT value FROM _ackerdb_meta WHERE key = ?")
    .get(BINDING_KEY) as { value: unknown } | null;
  if (row === null) return null;
  if (typeof row.value !== "string") {
    throw new CorruptDatabaseError("FileStore binding metadata is not text");
  }
  return parseBinding(row.value);
}

function writeBinding(engine: Engine, binding: FileStoreBinding): void {
  let transactionOpen = false;
  try {
    engine.writer.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    engine.writer.query(
      "INSERT INTO _ackerdb_meta (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(BINDING_KEY, JSON.stringify(binding));
    engine.writer.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        engine.writer.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "FileStore binding write and rollback both failed",
        );
      }
    }
    throw error;
  }
}

function stable(identityValue: string): FileStoreBinding {
  return { format: 1, state: "stable", identity: identityValue };
}

/**
 * Bind a fresh database, accept its stable configured store, or resolve a
 * crash-interrupted verified transition to the complete config that survived.
 */
export function resolveFileStoreBinding(engine: Engine, configuredIdentity: string): void {
  const configured = checkedFileStoreIdentity(configuredIdentity, "configured FileStore");
  const binding = readBinding(engine);
  if (binding === null) {
    const filesTable = engine.writer.query(
      "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = '_ackerdb_files'",
    ).get() as { present: number } | null;
    const existingFile = filesTable === null
      ? null
      : engine.writer
          .query("SELECT 1 AS present FROM _ackerdb_files LIMIT 1")
          .get() as { present: number } | null;
    if (existingFile !== null) {
      throw new IncompatibleDatabaseError(
        "database has File metadata but no physical FileStore binding; refusing to guess its store",
      );
    }
    writeBinding(engine, stable(configured));
    return;
  }
  if (binding.state === "stable") {
    if (binding.identity === configured) return;
    throw new IncompatibleDatabaseError(
      "configured FileStore does not match the database; use `acker files migrate` to change physical storage",
    );
  }
  if (configured !== binding.source && configured !== binding.target) {
    throw new IncompatibleDatabaseError(
      "configured FileStore matches neither side of the database's verified FileStore transition",
    );
  }
  writeBinding(engine, stable(configured));
}

/** Record only a fully copied and verified migration while source ownership is held. */
export function recordVerifiedFileStoreTransition(
  engine: Engine,
  sourceIdentity: string,
  targetIdentity: string,
): void {
  const source = checkedFileStoreIdentity(sourceIdentity, "FileStore transition source");
  const target = checkedFileStoreIdentity(targetIdentity, "FileStore transition target");
  if (source === target) throw new TypeError("FileStore transition source and target must differ");
  const binding = readBinding(engine);
  if (binding?.state !== "stable" || binding.identity !== source) {
    throw new IncompatibleDatabaseError(
      "database FileStore binding changed before the verified migration transition was recorded",
    );
  }
  writeBinding(engine, { format: 1, state: "verified-transition", source, target });
}

/** Rebind only an isolated restored database whose target bytes are unpublished. */
export function rebindRestoredFileStore(engine: Engine, targetIdentity: string): void {
  writeBinding(engine, stable(checkedFileStoreIdentity(targetIdentity, "restored FileStore")));
}
