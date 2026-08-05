import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@ackerdb/server";
import { resolveFileStoreBinding } from "@ackerdb/server/files/binding";
import type { FilesConfig } from "../../src/app/config.ts";
import { fileStoreIdentity } from "../../src/files/identity.ts";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function filesystem(root: string): FilesConfig {
  return {
    backend: "filesystem",
    root,
    publicUrl: "http://127.0.0.1/",
    maxBytes: 1024,
  };
}

describe("filesystem FileStore identity", () => {
  test("survives a directory move with its durable marker", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ackerdb-file-identity-move-"));
    directories.push(parent);
    const source = join(parent, "source");
    const target = join(parent, "target");

    const before = await fileStoreIdentity(filesystem(source));
    renameSync(source, target);

    expect(await fileStoreIdentity(filesystem(target))).toBe(before);
  });

  test("refuses a newly empty directory at the old configured path", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ackerdb-file-identity-replaced-"));
    directories.push(parent);
    const root = join(parent, "files");
    const database = join(parent, "data.db");
    const original = await fileStoreIdentity(filesystem(root));
    const engine = new Engine(defineSchema({}), database);
    resolveFileStoreBinding(engine, original);
    engine.close("clean");

    rmSync(root, { recursive: true, force: true });
    const replacement = await fileStoreIdentity(filesystem(root));
    expect(replacement).not.toBe(original);

    const reopened = new Engine(defineSchema({}), database);
    try {
      expect(() => resolveFileStoreBinding(reopened, replacement)).toThrow(
        "configured FileStore does not match the database",
      );
    } finally {
      reopened.close("clean");
    }
  });
});
