/**
 * App configuration: `.ackerdb.config.json` in the server app directory. Every
 * field is optional; defaults give the layout from the design docs.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DurabilityPolicy } from "@ackerdb/core";
import type {
  OidcVerifierOptions,
  S3FileStoreChecksum,
  S3FileStoreEncryption,
} from "@ackerdb/server";

export type AuthenticationConfig =
  | {
      readonly kind: "oidc";
      readonly options: Omit<OidcVerifierOptions, "fetch">;
    }
  | {
      readonly kind: "credential-verifier-module";
      readonly path: string;
    };

interface FilesCommonConfig {
  readonly publicUrl: string;
  readonly maxBytes: number;
}

export type FilesConfig = FilesCommonConfig & (
  | {
      readonly backend: "filesystem";
      readonly root: string;
    }
  | {
      readonly backend: "s3";
      readonly endpoint?: string;
      readonly region: string;
      readonly bucket: string;
      readonly forcePathStyle: boolean;
      readonly checksum: S3FileStoreChecksum;
      readonly encryption: S3FileStoreEncryption;
    }
);

export interface AppConfig {
  appDir: string;
  /** The application manifest (default export = defineApp(...)). */
  entrypoint: string;
  /** Filesystem roots containing server definitions. */
  definitions: readonly string[];
  /** Directory of migration modules and their `meta/` sidecars. */
  migrationsDir: string;
  /** Where codegen writes _generated files. */
  generatedDir: string;
  /** Where the local database lives. */
  dbDir: string;
  hostname: string;
  port: number;
  durability: DurabilityPolicy;
  /** The application's one configured authentication authority. Bearer credentials fail closed when omitted. */
  authentication?: AuthenticationConfig;
  /** Module whose default export resolves an Identity's scope grant. Every grant is empty when omitted. */
  scopeResolver?: string;
  /** Workload-principal OAuth scope the status endpoint requires; the listener validates and defaults it. */
  statusScope?: string;
  /** One active immutable File byte backend. */
  files: FilesConfig;
  /** What the application calls itself, from its package manifest: the OpenAPI document's identity. */
  application: ApplicationIdentity;
}

/** The application's own name and version, as its package manifest declares them. */
export interface ApplicationIdentity {
  readonly name: string;
  readonly version: string;
}

/** The one database file under the configured data directory. */
export function databasePath(config: Pick<AppConfig, "dbDir">): string {
  return join(config.dbDir, "data.db");
}

interface RawConfig {
  entrypoint?: string;
  definitions?: unknown;
  migrations?: string;
  generated?: string;
  db?: string;
  hostname?: string;
  port?: number;
  oidc?: Omit<OidcVerifierOptions, "fetch">;
  credentialVerifier?: string;
  scopeResolver?: string;
  statusScope?: string;
  files?: unknown;
}

const RAW_CONFIG_FIELDS: ReadonlySet<string> = new Set<keyof RawConfig>([
  "entrypoint",
  "definitions",
  "migrations",
  "generated",
  "db",
  "hostname",
  "port",
  "oidc",
  "credentialVerifier",
  "scopeResolver",
  "statusScope",
  "files",
]);

function parseRawConfig(value: unknown): RawConfig {
  return exactObject(value, [...RAW_CONFIG_FIELDS], "configuration") as RawConfig;
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

function optionalModulePath(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty module path`);
  }
  return value;
}

function definitionEntries(value: unknown): readonly string[] {
  const entries = value ?? ["./app"];
  if (
    !Array.isArray(entries) ||
    entries.length === 0 ||
    entries.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
  ) {
    throw new Error("definitions must be a non-empty array of module paths");
  }
  return entries;
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

function filePublicUrl(value: unknown, hostname: string, port: number): string {
  const raw = value ?? `http://${hostname}:${port}`;
  if (typeof raw !== "string") throw new Error("files.publicUrl must be an absolute HTTP URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("files.publicUrl must be an absolute HTTP URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error("files.publicUrl must be an HTTP or HTTPS URL without credentials or a fragment");
  }
  return url.href;
}

function fileMaxBytes(value: unknown): number {
  const maxBytes = value ?? 1024 ** 3;
  if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) <= 0 || (maxBytes as number) > 5 * 1024 ** 3) {
    throw new Error(`files.maxBytes must be an integer from 1 through ${5 * 1024 ** 3}`);
  }
  return maxBytes as number;
}

function exactObject(value: unknown, allowed: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be a JSON object`);
  }
  const unknown = Object.keys(value).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) throw new Error(`unknown ${path} field: ${unknown.join(", ")}`);
  return value as Record<string, unknown>;
}

/**
 * What the application package says about itself, which is the closest thing
 * to a name this project has, and so what the OpenAPI document is titled with.
 * A manifest field is a default rather than a declaration, so an unusable one
 * is simply absent: the directory name and `0.0.0` answer instead.
 */
function resolveApplicationIdentity(appDir: string): ApplicationIdentity {
  const manifest = join(appDir, "package.json");
  const packaged: { name?: unknown; version?: unknown } = existsSync(manifest)
    ? JSON.parse(readFileSync(manifest, "utf8"))
    : {};
  const text = (value: unknown, fallback: string): string =>
    typeof value === "string" && value.trim().length > 0 ? value : fallback;
  return Object.freeze({
    name: text(packaged.name, basename(appDir)),
    version: text(packaged.version, "0.0.0"),
  });
}

export interface FilesConfigContext {
  readonly appDir: string;
  readonly dbDir: string;
  readonly hostname: string;
  readonly port: number;
}

/** Validate and resolve the same raw FileStore object accepted in app configuration. */
export function resolveFilesConfig(
  value: unknown,
  context: FilesConfigContext,
): FilesConfig {
  const { appDir, dbDir, hostname, port } = context;
  const candidate = value === undefined ? {} : value;
  const discriminator = exactObject(
    candidate,
    [
      "backend",
      "path",
      "endpoint",
      "region",
      "bucket",
      "forcePathStyle",
      "checksum",
      "encryption",
      "publicUrl",
      "maxBytes",
    ],
    "files",
  );
  const common = {
    publicUrl: filePublicUrl(discriminator.publicUrl, hostname, port),
    maxBytes: fileMaxBytes(discriminator.maxBytes),
  };
  if (discriminator.backend !== "s3") {
    const raw = exactObject(candidate, ["backend", "path", "publicUrl", "maxBytes"], "files");
    if (raw.backend !== undefined && raw.backend !== "filesystem") {
      throw new Error("files.backend must be exactly filesystem or s3");
    }
    const path = raw.path ?? join(dbDir, "files");
    if (typeof path !== "string" || path.trim().length === 0) {
      throw new Error("files.path must be a non-empty path");
    }
    const root = isAbsolute(path) ? path : resolve(appDir, path);
    const databaseFromRoot = relative(root, dbDir);
    if (
      databaseFromRoot === "" ||
      (
        databaseFromRoot !== ".." &&
        !databaseFromRoot.startsWith(`..${sep}`) &&
        !isAbsolute(databaseFromRoot)
      )
    ) {
      throw new Error("files.path must not equal or contain the database directory");
    }
    return {
      ...common,
      backend: "filesystem",
      root,
    };
  }

  const raw = exactObject(candidate, [
    "backend",
    "endpoint",
    "region",
    "bucket",
    "forcePathStyle",
    "checksum",
    "encryption",
    "publicUrl",
    "maxBytes",
  ], "files");
  if (typeof raw.region !== "string" || raw.region.trim().length === 0) {
    throw new Error("files.region must be a non-empty string");
  }
  if (typeof raw.bucket !== "string" || raw.bucket.trim().length === 0) {
    throw new Error("files.bucket must be a non-empty string");
  }
  if (raw.endpoint !== undefined) {
    if (typeof raw.endpoint !== "string") throw new Error("files.endpoint must be an HTTP URL");
    let endpoint: URL;
    try {
      endpoint = new URL(raw.endpoint);
    } catch {
      throw new Error("files.endpoint must be an HTTP URL");
    }
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      throw new Error("files.endpoint must be an HTTP URL");
    }
  }
  if (raw.forcePathStyle !== undefined && typeof raw.forcePathStyle !== "boolean") {
    throw new Error("files.forcePathStyle must be a boolean");
  }
  const checksum = raw.checksum ?? "sha256";
  if (checksum !== "sha256" && checksum !== "disabled") {
    throw new Error("files.checksum must be exactly sha256 or disabled");
  }
  const encryption = exactObject(
    raw.encryption ?? { type: "AES256" },
    ["type", "keyId", "bucketKeyEnabled"],
    "files.encryption",
  );
  if (encryption.type !== "disabled" && encryption.type !== "AES256" && encryption.type !== "aws:kms") {
    throw new Error("files.encryption.type must be disabled, AES256, or aws:kms");
  }
  return {
    ...common,
    backend: "s3",
    ...(raw.endpoint === undefined ? {} : { endpoint: raw.endpoint as string }),
    region: raw.region,
    bucket: raw.bucket,
    forcePathStyle: raw.forcePathStyle as boolean | undefined ?? false,
    checksum,
    encryption: encryption as S3FileStoreEncryption,
  };
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
  const dbDir = abs(raw.db ?? "./.ackerdb");
  const hostname = listenerHostname(raw.hostname);
  const port = listenerPort(raw.port);
  const credentialVerifier = optionalModulePath(raw.credentialVerifier, "credentialVerifier");
  const authentication: AuthenticationConfig | undefined = raw.oidc !== undefined
    ? { kind: "oidc", options: raw.oidc }
    : credentialVerifier === undefined
      ? undefined
      : { kind: "credential-verifier-module", path: abs(credentialVerifier) };
  const scopeResolver = optionalModulePath(raw.scopeResolver, "scopeResolver");
  return {
    appDir: dir,
    entrypoint: abs(raw.entrypoint ?? "./app.ts"),
    definitions: definitionEntries(raw.definitions).map(abs),
    migrationsDir: abs(raw.migrations ?? "./migrations"),
    generatedDir: abs(raw.generated ?? "./_generated"),
    dbDir,
    hostname,
    port,
    durability: exactProfile(env, "ACKERDB_DURABILITY", ["production", "balanced"], "production"),
    ...(authentication === undefined ? {} : { authentication }),
    ...(scopeResolver === undefined ? {} : { scopeResolver: abs(scopeResolver) }),
    ...(raw.statusScope === undefined ? {} : { statusScope: raw.statusScope }),
    files: resolveFilesConfig(raw.files, {
      appDir: dir,
      dbDir,
      hostname,
      port,
    }),
    application: resolveApplicationIdentity(dir),
  };
}
