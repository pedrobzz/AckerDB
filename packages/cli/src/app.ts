/**
 * Loading a dbzz app: the schema module, the function modules, and the
 * assembled server (engine + reconcile + runtime + transport).
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DbzzServer,
  Engine,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  assertCredentialVerifier,
  createOidcVerifier,
  isSchema,
  type CredentialVerifier,
  type EngineCloseDisposition,
  MigrationError,
  reconcile,
  type Schema,
  UnsafeSchemaChange,
} from "@dbzz/server";
import type { AppConfig } from "./config.ts";
import { loadMigrationChain } from "./migrations/load.ts";

const IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export interface FunctionModuleFile {
  /** Dot-joined module key: functions/admin/users.ts -> "admin.users". */
  key: string;
  segments: string[];
  file: string;
}

/** Deterministically list function module files (sorted by key). */
export function listFunctionModules(config: AppConfig): FunctionModuleFile[] {
  if (!existsSync(config.functionsDir)) return [];
  const out: FunctionModuleFile[] = [];
  const entries = readdirSync(config.functionsDir, { recursive: true }) as string[];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
    const segments = entry.slice(0, -".ts".length).split(sep);
    if (segments.some((s) => s.startsWith("_") || s.startsWith(".") || !IDENTIFIER.test(s))) {
      throw new Error(
        `function module "${entry}": path segments become API namespaces and must be identifiers (got "${segments.join("/")}")`,
      );
    }
    out.push({ key: segments.join("."), segments, file: join(config.functionsDir, entry) });
  }
  return out;
}

export async function importSchema(config: AppConfig): Promise<Schema> {
  if (!existsSync(config.schemaPath)) {
    throw new Error(`schema not found at ${config.schemaPath}`);
  }
  const module = (await import(pathToFileURL(config.schemaPath).href)) as { default?: unknown };
  if (!isSchema(module.default)) {
    throw new Error(`${config.schemaPath} must default-export defineSchema(...)`);
  }
  return module.default;
}

export async function importFunctionModules(
  config: AppConfig,
): Promise<Record<string, Record<string, unknown>>> {
  const modules: Record<string, Record<string, unknown>> = {};
  for (const { key, file } of listFunctionModules(config)) {
    modules[key] = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  }
  return modules;
}

export interface RunningApp {
  server: DbzzServer;
  runtime: Runtime;
  engine: Engine;
  /** Idempotently drain; success marks storage clean, while failure releases it unclean. */
  drain(): Promise<void>;
}

export type StartupPreparation = (config: AppConfig) => Promise<unknown>;

export interface StartAppOptions {
  /** Work that must finish before application modules are loaded, normally codegen. */
  prepare?: StartupPreparation;
  /** Programmatic auth authority. Cannot be combined with a configured verifier or OIDC. */
  credentialVerifier?: CredentialVerifier;
}

type CredentialVerifierLoader = () => Promise<CredentialVerifier | undefined>;

async function importCredentialVerifier(path: string): Promise<CredentialVerifier> {
  if (!existsSync(path)) throw new Error(`credential verifier not found at ${path}`);
  let module: { default?: unknown };
  try {
    module = (await import(pathToFileURL(path).href)) as { default?: unknown };
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`failed to import credential verifier at ${path}${detail}`, { cause: error });
  }
  assertCredentialVerifier(
    module.default,
    PRODUCTION_LIMITS.auth.revocationDeadlineMs,
    `credential verifier default export from ${path}`,
  );
  return module.default;
}

function credentialVerifierLoader(
  config: AppConfig,
  injected: CredentialVerifier | undefined,
): CredentialVerifierLoader {
  if (injected !== undefined && config.authentication !== undefined) {
    throw new Error(
      "startApp credentialVerifier cannot be combined with configured oidc or credentialVerifier",
    );
  }
  if (injected !== undefined) {
    assertCredentialVerifier(
      injected,
      PRODUCTION_LIMITS.auth.revocationDeadlineMs,
      "startApp credentialVerifier",
    );
    return async () => injected;
  }
  const authentication = config.authentication;
  switch (authentication?.kind) {
    case "oidc":
      return async () => createOidcVerifier(authentication.options);
    case "credential-verifier-module":
      return async () => importCredentialVerifier(authentication.path);
    case undefined:
      return async () => undefined;
  }
}

export class StartupInterruptedError extends Error {
  override readonly name = "StartupInterruptedError";

  constructor() {
    super("startup interrupted by shutdown");
  }
}

export async function startApp(
  config: AppConfig,
  options: StartAppOptions = {},
): Promise<RunningApp> {
  const loadCredentialVerifier = credentialVerifierLoader(config, options.credentialVerifier);
  const server = new DbzzServer({
    limits: PRODUCTION_LIMITS,
    port: config.port,
    statusScope: config.statusScope,
  });

  let shutdownRequested = false;
  let activated = false;
  let engineClosed = false;
  let runtime: Runtime | undefined;
  let ownedEngine: Engine | undefined;
  let drainPromise: Promise<void> | null = null;
  let interruptStartup!: () => void;
  const startupInterrupted = new Promise<never>((_resolve, reject) => {
    interruptStartup = () => reject(new StartupInterruptedError());
  });
  // JavaScript cannot cancel an arbitrary import/preparation Promise. Racing it
  // releases DBZZ ownership; the CLI treats the typed interruption as a process
  // boundary so abandoned user work cannot retain handles or write afterward.
  const awaitStartup = <T>(work: Promise<T>): Promise<T> =>
    Promise.race([work, startupInterrupted]);

  const removeSignalHandlers = () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
  const closeEngine = (shutdown: EngineCloseDisposition) => {
    if (engineClosed || ownedEngine === undefined) return;
    engineClosed = true;
    ownedEngine.close(shutdown);
  };
  const drain = (): Promise<void> => {
    if (drainPromise !== null) return drainPromise;
    removeSignalHandlers();
    drainPromise = (async () => {
      let shutdown: EngineCloseDisposition = "unclean";
      try {
        if (activated || runtime === undefined) await server.drain();
        else await Promise.all([server.drain(), runtime.drain()]);
        shutdown = "clean";
      } finally {
        closeEngine(shutdown);
      }
    })();
    return drainPromise;
  };
  const onSignal = () => {
    const duringStartup = server.state === "starting";
    shutdownRequested = true;
    const draining = drain();
    interruptStartup();
    if (!duringStartup) {
      void draining.catch((error) => {
        console.error(`[dbz] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      });
    }
  };
  const requireStartupOwnership = () => {
    if (shutdownRequested || server.state !== "starting") {
      throw new StartupInterruptedError();
    }
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    if (options.prepare !== undefined) {
      server.advanceStartup("codegen");
      await awaitStartup(options.prepare(config));
      requireStartupOwnership();
    }

    server.advanceStartup("loading");
    const [verifier, schema, modules, steps] = await awaitStartup(Promise.all([
      loadCredentialVerifier(),
      importSchema(config),
      importFunctionModules(config),
      loadMigrationChain(config),
    ]));
    requireStartupOwnership();

    server.advanceStartup("opening-storage");
    mkdirSync(config.dbDir, { recursive: true });
    ownedEngine = new Engine(schema, join(config.dbDir, "data.db"), {
      durability: config.durability,
    });

    // A present chain reports `migrating` distinctly; an empty one reconciles
    // exactly as before. The chain form owns history, the per-step apply, and
    // the trailing safe reconcile in one call.
    server.advanceStartup(steps.length > 0 ? "migrating" : "reconciling");
    const { applied } = await reconcile(ownedEngine, steps);
    for (const line of applied) console.log(`[dbz] ${line}`);
    const registry = new Registry(modules);
    runtime = new Runtime({
      engine: ownedEngine,
      registry,
      ...(verifier === undefined ? {} : { verifier }),
      telemetry: config.telemetry === "disabled" ? false : undefined,
    });
    server.activate(runtime);
    activated = true;

    console.log(`@@dbzz-startup ${JSON.stringify({
      telemetry: config.telemetry,
      durability: config.durability,
    })}`);
    console.log(
      `[dbz] ready on http://127.0.0.1:${server.port} — ${registry.functions.size} function(s), ${Object.keys(schema.tables).length} table(s), db at ${relative(process.cwd(), config.dbDir) || "."}`,
    );
    return { server, runtime, engine: ownedEngine, drain };
  } catch (error) {
    // A cleanup/deadline failure is the owning shutdown outcome; never turn it
    // into a successful typed interruption at the CLI boundary.
    await drain();
    if (shutdownRequested && !(error instanceof StartupInterruptedError)) {
      throw new StartupInterruptedError();
    }
    if (error instanceof UnsafeSchemaChange || error instanceof MigrationError) {
      throw new Error(withGenerationRecourse(error.message), { cause: error });
    }
    throw error;
  }
}

/**
 * Startup is the non-interactive path: a refused schema change or an incomplete
 * migration is surfaced with the exact command that authors the answer, never a
 * prompt. The message ends with the command itself so it is the last thing the
 * operator reads.
 */
function withGenerationRecourse(message: string): string {
  return `${message}\n\ngenerate a migration for the change above, then restart:\n\n    dbz generate`;
}
