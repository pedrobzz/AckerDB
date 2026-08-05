import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFileStore } from "../../../src/files/store/local.ts";
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
});
