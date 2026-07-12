/**
 * App configuration: `.zdb.config.json` in the server app directory. Every
 * field is optional; defaults give the layout from the design docs.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface AppConfig {
  appDir: string;
  /** The schema module (default export = defineSchema(...)). */
  schemaPath: string;
  /** Directory of function modules. */
  functionsDir: string;
  /** Where codegen writes _generated files. */
  generatedDir: string;
  /** Where the local database lives. */
  dbDir: string;
  port: number;
}

interface RawConfig {
  schema?: string;
  functions?: string;
  generated?: string;
  db?: string;
  port?: number;
}

export function loadConfig(appDir: string): AppConfig {
  const dir = resolve(appDir);
  const configPath = join(dir, ".zdb.config.json");
  let raw: RawConfig = {};
  if (existsSync(configPath)) {
    raw = JSON.parse(readFileSync(configPath, "utf8")) as RawConfig;
  }
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(dir, p));
  return {
    appDir: dir,
    schemaPath: abs(raw.schema ?? "./schema.ts"),
    functionsDir: abs(raw.functions ?? "./functions"),
    generatedDir: abs(raw.generated ?? "./_generated"),
    dbDir: abs(raw.db ?? "./.zdb"),
    port: raw.port ?? 3211,
  };
}
