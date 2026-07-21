import { expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DbzzError,
  defineSchema,
  isDbzzError,
  isSchema,
  isTableDef,
  isUniqueConstraintError,
  isValidationError,
  Schema,
  TableDef,
  UniqueConstraintError,
  ValidationError,
  type TableDef as TableDefinition,
} from "@dbzz/server";
import { outcomeFromError } from "../../../server/src/runtime/outcome.ts";
import { importApp } from "../../src/app/manifest.ts";
import { loadConfig } from "../../src/app/config.ts";

const REPO = new URL("../../../..", import.meta.url).pathname;

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed:\n${result.stdout.toString()}${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
}

function installPackedPackage(app: string, tarballs: string, name: "core" | "server"): void {
  const output = run(
    [process.execPath, "pm", "pack", "--destination", tarballs],
    join(REPO, "packages", name),
  );
  const tarball = output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.endsWith(".tgz"));
  if (tarball === undefined) throw new Error(`bun pm pack did not report a ${name} tarball`);

  const target = join(app, "node_modules", "@dbzz", name);
  mkdirSync(target, { recursive: true });
  run(["tar", "-xzf", tarball, "-C", target, "--strip-components=1"], app);
}

test("packed @dbzz/server values keep identity across physical package copies", async () => {
  const app = mkdtempSync(join(tmpdir(), "dbzz-schema-identity-"));
  try {
    const tarballs = join(app, "tarballs");
    mkdirSync(tarballs);
    installPackedPackage(app, tarballs, "core");
    installPackedPackage(app, tarballs, "server");
    cpSync(
      realpathSync(join(REPO, "packages", "server", "node_modules", "jose")),
      join(app, "node_modules", "jose"),
      { recursive: true },
    );

    const appPath = join(app, "app.ts");
    writeFileSync(
      appPath,
      [
        `import { DbzzError, UniqueConstraintError, ValidationError, v, defineApp, defineSchema, defineTable } from "@dbzz/server";`,
        `export const records = defineTable({ id: v.primaryKey() });`,
        `export const conflict = new DbzzError("conflict", "foreign conflict");`,
        `export const invalid = new ValidationError("foreign validation");`,
        `export const unique = new UniqueConstraintError("foreign unique");`,
        `export const schema = defineSchema({ records });`,
        `export default defineApp({ schema });`,
        "",
      ].join("\n"),
    );

    const config = loadConfig(app);
    const schema = (await importApp(config)).schema;
    const foreign = (await import(pathToFileURL(appPath).href)) as {
      records: TableDefinition;
      conflict: unknown;
      invalid: unknown;
      unique: unknown;
    };

    expect(schema).not.toBeInstanceOf(Schema);
    expect(foreign.records).not.toBeInstanceOf(TableDef);
    expect(isSchema(schema)).toBe(true);
    expect(isTableDef(foreign.records)).toBe(true);
    expect(defineSchema({ records: foreign.records }).tables.records.primaryKey).toBe("id");
    expect(foreign.conflict).not.toBeInstanceOf(DbzzError);
    expect(foreign.invalid).not.toBeInstanceOf(ValidationError);
    expect(foreign.unique).not.toBeInstanceOf(UniqueConstraintError);
    expect(isDbzzError(foreign.conflict)).toBe(true);
    expect(isValidationError(foreign.invalid)).toBe(true);
    expect(isUniqueConstraintError(foreign.unique)).toBe(true);
    expect(outcomeFromError(foreign.conflict)).toMatchObject({ code: "conflict" });
    expect(outcomeFromError(foreign.invalid)).toMatchObject({ code: "validation" });

    expect(isSchema({ tables: schema.tables, namedTypes: schema.namedTypes })).toBe(false);
    expect(isTableDef({ columns: foreign.records.columns })).toBe(false);
    expect(isDbzzError({ code: "conflict", message: "lookalike" })).toBe(false);
    expect(isValidationError(new Error("lookalike"))).toBe(false);
    expect(isUniqueConstraintError(new Error("lookalike"))).toBe(false);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});
