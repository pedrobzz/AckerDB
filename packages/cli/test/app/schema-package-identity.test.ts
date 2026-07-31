import { expect, test } from "bun:test";
import {
  readFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AckerDBError,
  defineSchema,
  isAckerDBError,
  isSchema,
  isTableDef,
  isUniqueConstraintError,
  isValidationError,
  Schema,
  TableDef,
  UniqueConstraintError,
  ValidationError,
  type TableDef as TableDefinition,
} from "@ackerdb/server";
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
  run(
    [process.execPath, "pm", "pack", "--destination", tarballs],
    join(REPO, "packages", name),
  );
  const archive = readdirSync(tarballs).find(
    (file) => file.startsWith(`ackerdb-${name}-`) && file.endsWith(".tgz"),
  );
  if (archive === undefined) {
    throw new Error(`bun pm pack did not create a ${name} tarball`);
  }
  const tarball = join(tarballs, archive);

  const target = join(app, "node_modules", "@ackerdb", name);
  mkdirSync(target, { recursive: true });
  run(["tar", "-xzf", tarball, "-C", target, "--strip-components=1"], app);
}

function linkExternalDependencies(app: string, name: "core" | "server"): void {
  const manifest = JSON.parse(
    readFileSync(join(REPO, "packages", name, "package.json"), "utf8"),
  ) as { readonly dependencies?: Readonly<Record<string, string>> };
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (dependency.startsWith("@ackerdb/")) continue;
    const target = join(app, "node_modules", dependency);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(
      realpathSync(join(REPO, "packages", name, "node_modules", dependency)),
      target,
      "dir",
    );
  }
}

test("packed @ackerdb/server values keep identity across physical package copies", async () => {
  const app = mkdtempSync(join(tmpdir(), "ackerdb-schema-identity-"));
  try {
    const tarballs = join(app, "tarballs");
    mkdirSync(tarballs);
    installPackedPackage(app, tarballs, "core");
    installPackedPackage(app, tarballs, "server");
    linkExternalDependencies(app, "core");
    linkExternalDependencies(app, "server");

    const appPath = join(app, "app.ts");
    writeFileSync(
      appPath,
      [
        `import { AckerDBError, UniqueConstraintError, ValidationError, v, defineApp, defineSchema, defineTable } from "@ackerdb/server";`,
        `export const records = defineTable({ id: v.primaryKey() });`,
        `export const conflict = new AckerDBError("conflict", "foreign conflict");`,
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
    expect(foreign.conflict).not.toBeInstanceOf(AckerDBError);
    expect(foreign.invalid).not.toBeInstanceOf(ValidationError);
    expect(foreign.unique).not.toBeInstanceOf(UniqueConstraintError);
    expect(isAckerDBError(foreign.conflict)).toBe(true);
    expect(isValidationError(foreign.invalid)).toBe(true);
    expect(isUniqueConstraintError(foreign.unique)).toBe(true);
    expect(outcomeFromError(foreign.conflict)).toMatchObject({ code: "conflict" });
    expect(outcomeFromError(foreign.invalid)).toMatchObject({ code: "validation" });

    expect(isSchema({ tables: schema.tables, namedTypes: schema.namedTypes })).toBe(false);
    expect(isTableDef({ columns: foreign.records.columns })).toBe(false);
    expect(isAckerDBError({ code: "conflict", message: "lookalike" })).toBe(false);
    expect(isValidationError(new Error("lookalike"))).toBe(false);
    expect(isUniqueConstraintError(new Error("lookalike"))).toBe(false);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});
