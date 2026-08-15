import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../../src/database/engine.ts";
import { resolveFileStoreBinding } from "../../../src/files/binding.ts";
import { LocalFileStore } from "../../../src/files/store/local.ts";
import { defineSchema } from "../../../src/schema/definition.ts";
import { fileStoreContract } from "./contract.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("LocalFileStore contract", () => {
  fileStoreContract("local", {
    create() {
      const root = mkdtempSync(join(tmpdir(), "ackerdb-files-local-"));
      roots.push(root);
      return new LocalFileStore({ root });
    },
  });

  test("startup probe reclaims staging files left by a crashed put", async () => {
    const root = mkdtempSync(join(tmpdir(), "ackerdb-files-local-crash-"));
    roots.push(root);
    const staging = join(root, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "crashed-put"), "partial bytes");

    await new LocalFileStore({ root }).probe();

    expect(readdirSync(staging)).toEqual([]);
  });

  test("identity survives a directory move with its durable marker", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ackerdb-files-local-move-"));
    roots.push(parent);
    const source = join(parent, "source");
    const target = join(parent, "target");

    const before = await new LocalFileStore({ root: source }).identity();
    renameSync(source, target);

    expect(await new LocalFileStore({ root: target }).identity()).toBe(before);
    expect(before).toMatch(/^filesystem:[0-9a-f-]{36}$/);
  });

  test("identity refuses a newly empty directory at the old configured path", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ackerdb-files-local-replaced-"));
    roots.push(parent);
    const root = join(parent, "files");
    const database = join(parent, "data.db");
    const original = await new LocalFileStore({ root }).identity();
    const engine = new Engine(defineSchema({}), database);
    resolveFileStoreBinding(engine, original);
    engine.close("clean");

    rmSync(root, { recursive: true, force: true });
    const replacement = await new LocalFileStore({ root }).identity();
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
