/**
 * App configuration: `.zdb.config.json` in the server app directory. Every
 * field is optional; defaults give the layout from the design docs.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { DurabilityPolicy } from "@dbzz/core";

export type TelemetryMode = "enabled" | "disabled";

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
  durability: DurabilityPolicy;
  telemetry: TelemetryMode;
}

interface RawConfig {
  schema?: string;
  functions?: string;
  generated?: string;
  db?: string;
  port?: number;
}

function exactProfile<const T extends string>(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = env[name] ?? fallback;
  if (!allowed.includes(value as T)) {
    throw new Error(`${name} must be exactly ${allowed.join(" or ")}; received ${JSON.stringify(value)}`);
  }
  return value as T;
}

export function loadConfig(
  appDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): AppConfig {
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
    durability: exactProfile(env, "DBZZ_DURABILITY", ["production", "balanced"], "production"),
    telemetry: exactProfile(env, "DBZZ_TELEMETRY", ["enabled", "disabled"], "enabled"),
  };
}
