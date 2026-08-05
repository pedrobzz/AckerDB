import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CorruptDatabaseError,
  Engine,
  IncompatibleDatabaseError,
  defineSchema,
  reconcile,
} from "../../src/index.ts";
import {
  rebindRestoredFileStore,
  recordVerifiedFileStoreTransition,
  resolveFileStoreBinding,
} from "../../src/files/binding.ts";

const directories: string[] = [];
const schema = defineSchema({});

function database(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `ackerdb-file-binding-${name}-`));
  directories.push(directory);
  return join(directory, "data.db");
}

function close(engine: Engine): void {
  engine.close("clean");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database FileStore binding", () => {
  test("rejects a stable database opened against another physical store", () => {
    const path = database("stable");
    const engine = new Engine(schema, path);
    resolveFileStoreBinding(engine, "filesystem:source");
    close(engine);

    const reopened = new Engine(schema, path);
    expect(() => resolveFileStoreBinding(reopened, "filesystem:target")).toThrow(
      IncompatibleDatabaseError,
    );
    close(reopened);
  });

  test("does not guess a store for unbound File metadata", () => {
    const engine = new Engine(schema, database("unbound-existing"));
    reconcile(engine);
    engine.writer.query(`INSERT INTO _ackerdb_files (
      state, objectKey, owner, size, sha256, contentType, name, createdAt, pendingExpiresAt
    ) VALUES ('active', 'existing/object', NULL, 1, ?, NULL, NULL, 1, NULL)`).run(
      "a".repeat(64),
    );

    expect(() => resolveFileStoreBinding(engine, "filesystem:configured")).toThrow(
      IncompatibleDatabaseError,
    );
    close(engine);
  });

  test("resolves either complete config after a verified transition", () => {
    for (const survivor of ["filesystem:source", "filesystem:target"] as const) {
      const path = database(survivor.endsWith("source") ? "source" : "target");
      const engine = new Engine(schema, path);
      resolveFileStoreBinding(engine, "filesystem:source");
      recordVerifiedFileStoreTransition(
        engine,
        "filesystem:source",
        "filesystem:target",
      );
      close(engine);

      const recovering = new Engine(schema, path);
      resolveFileStoreBinding(recovering, survivor);
      close(recovering);

      const stable = new Engine(schema, path);
      resolveFileStoreBinding(stable, survivor);
      expect(() => resolveFileStoreBinding(
        stable,
        survivor === "filesystem:source" ? "filesystem:target" : "filesystem:source",
      )).toThrow(IncompatibleDatabaseError);
      close(stable);
    }
  });

  test("restore rebinding replaces the artifact's physical store identity", () => {
    const path = database("restore");
    const engine = new Engine(schema, path);
    resolveFileStoreBinding(engine, "filesystem:backup-source");
    rebindRestoredFileStore(engine, "filesystem:restore-target");
    close(engine);

    const restored = new Engine(schema, path);
    resolveFileStoreBinding(restored, "filesystem:restore-target");
    expect(() => resolveFileStoreBinding(restored, "filesystem:backup-source")).toThrow(
      IncompatibleDatabaseError,
    );
    close(restored);
  });

  test("rejects malformed binding metadata as database corruption", () => {
    const engine = new Engine(schema, database("corrupt"));
    engine.writer.query(
      "INSERT INTO _ackerdb_meta (key, value) VALUES ('file_store_binding', ?)",
    ).run('{"format":1,"state":"stable"}');

    expect(() => resolveFileStoreBinding(engine, "filesystem:source")).toThrow(
      CorruptDatabaseError,
    );
    close(engine);
  });
});
