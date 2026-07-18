/**
 * App configuration: `.zdb.config.json` in the server app directory. Every
 * field is optional; defaults give the layout from the design docs.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { DurabilityPolicy } from "@dbzz/core";
import type { OidcVerifierOptions } from "@dbzz/server";

export type TelemetryMode = "enabled" | "disabled";

export type AuthenticationConfig =
  | {
      readonly kind: "oidc";
      readonly options: Omit<OidcVerifierOptions, "fetch">;
    }
  | {
      readonly kind: "credential-verifier-module";
      readonly path: string;
    };

export interface AppConfig {
  appDir: string;
  /** The schema module (default export = defineSchema(...)). */
  schemaPath: string;
  /** Directory of function modules. */
  functionsDir: string;
  /** Directory of migration modules and their `meta/` sidecars. */
  migrationsDir: string;
  /** Where codegen writes _generated files. */
  generatedDir: string;
  /** Where the local database lives. */
  dbDir: string;
  port: number;
  durability: DurabilityPolicy;
  telemetry: TelemetryMode;
  /** The application's one configured authentication authority. Bearer credentials fail closed when omitted. */
  authentication?: AuthenticationConfig;
  /** Workload-principal OAuth scope required by the operational status endpoint. */
  statusScope: string;
}

interface RawConfig {
  schema?: string;
  functions?: string;
  migrations?: string;
  generated?: string;
  db?: string;
  port?: number;
  oidc?: Omit<OidcVerifierOptions, "fetch">;
  credentialVerifier?: string;
  statusScope?: string;
}

const OAUTH_SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/;

function statusScope(value: unknown): string {
  const scope = value ?? "dbzz:status";
  if (typeof scope !== "string" || !OAUTH_SCOPE_TOKEN.test(scope)) {
    throw new Error("statusScope must be one OAuth scope token of at most 128 characters");
  }
  return scope;
}

function listenerPort(value: unknown): number {
  const port = value ?? 3211;
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("port must be an integer from 1 through 65535");
  }
  return port;
}

function optionalModulePath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("credentialVerifier must be a non-empty module path");
  }
  return value;
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
  if (raw.oidc !== undefined && raw.credentialVerifier !== undefined) {
    throw new Error("oidc and credentialVerifier are mutually exclusive authentication sources");
  }
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(dir, p));
  const credentialVerifier = optionalModulePath(raw.credentialVerifier);
  const authentication: AuthenticationConfig | undefined = raw.oidc !== undefined
    ? { kind: "oidc", options: raw.oidc }
    : credentialVerifier === undefined
      ? undefined
      : { kind: "credential-verifier-module", path: abs(credentialVerifier) };
  return {
    appDir: dir,
    schemaPath: abs(raw.schema ?? "./schema.ts"),
    functionsDir: abs(raw.functions ?? "./functions"),
    migrationsDir: abs(raw.migrations ?? "./migrations"),
    generatedDir: abs(raw.generated ?? "./_generated"),
    dbDir: abs(raw.db ?? "./.zdb"),
    port: listenerPort(raw.port),
    durability: exactProfile(env, "DBZZ_DURABILITY", ["production", "balanced"], "production"),
    telemetry: exactProfile(env, "DBZZ_TELEMETRY", ["enabled", "disabled"], "enabled"),
    ...(authentication === undefined ? {} : { authentication }),
    statusScope: statusScope(raw.statusScope),
  };
}
