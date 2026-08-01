/**
 * App configuration: `.ackerdb.config.json` in the server app directory. Every
 * field is optional; defaults give the layout from the design docs.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { DurabilityPolicy } from "@ackerdb/core";
import type { OidcVerifierOptions } from "@ackerdb/server";

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
  /** The application manifest (default export = defineApp(...)). */
  appPath: string;
  /** Directory of function modules. */
  functionsDir: string;
  /** Directory of application service modules. */
  servicesDir: string;
  /** Directory of migration modules and their `meta/` sidecars. */
  migrationsDir: string;
  /** Where codegen writes _generated files. */
  generatedDir: string;
  /** Where the local database lives. */
  dbDir: string;
  hostname: string;
  port: number;
  durability: DurabilityPolicy;
  telemetry: TelemetryMode;
  /** The application's one configured authentication authority. Bearer credentials fail closed when omitted. */
  authentication?: AuthenticationConfig;
  /** Workload-principal OAuth scope required by the operational status endpoint. */
  statusScope: string;
}

interface RawConfig {
  app?: string;
  functions?: string;
  services?: string;
  migrations?: string;
  generated?: string;
  db?: string;
  hostname?: string;
  port?: number;
  oidc?: Omit<OidcVerifierOptions, "fetch">;
  credentialVerifier?: string;
  statusScope?: string;
}

const RAW_CONFIG_FIELDS: ReadonlySet<string> = new Set<keyof RawConfig>([
  "app",
  "functions",
  "services",
  "migrations",
  "generated",
  "db",
  "hostname",
  "port",
  "oidc",
  "credentialVerifier",
  "statusScope",
]);
const OAUTH_SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/;

function parseRawConfig(value: unknown): RawConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("application configuration must be a JSON object");
  }
  const unknown = Object.keys(value).filter((field) => !RAW_CONFIG_FIELDS.has(field));
  if (unknown.length > 0) {
    throw new Error(`unknown configuration field: ${unknown.join(", ")}`);
  }
  return value as RawConfig;
}

function statusScope(value: unknown): string {
  const scope = value ?? "ackerdb:status";
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

function listenerHostname(value: unknown): string {
  const hostname = value === undefined ? "127.0.0.1" : value;
  if (
    typeof hostname !== "string" ||
    hostname.length === 0 ||
    hostname.length > 253 ||
    hostname.trim() !== hostname ||
    /[\u0000-\u0020\u007f]/.test(hostname)
  ) {
    throw new Error("hostname must be a non-empty host name or IP address");
  }
  return hostname;
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
  const configPath = join(dir, ".ackerdb.config.json");
  let raw: RawConfig = {};
  if (existsSync(configPath)) {
    raw = parseRawConfig(JSON.parse(readFileSync(configPath, "utf8")));
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
    appPath: abs(raw.app ?? "./app.ts"),
    functionsDir: abs(raw.functions ?? "./functions"),
    servicesDir: abs(raw.services ?? "./services"),
    migrationsDir: abs(raw.migrations ?? "./migrations"),
    generatedDir: abs(raw.generated ?? "./_generated"),
    dbDir: abs(raw.db ?? "./.ackerdb"),
    hostname: listenerHostname(raw.hostname),
    port: listenerPort(raw.port),
    durability: exactProfile(env, "ACKERDB_DURABILITY", ["production", "balanced"], "production"),
    telemetry: exactProfile(env, "ACKERDB_TELEMETRY", ["enabled", "disabled"], "enabled"),
    ...(authentication === undefined ? {} : { authentication }),
    statusScope: statusScope(raw.statusScope),
  };
}
