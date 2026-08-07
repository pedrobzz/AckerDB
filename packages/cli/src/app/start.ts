/**
 * Loading a ackerdb app: the application manifest, the function modules, and the
 * assembled server (engine + reconcile + runtime + transport).
 */
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AckerDBServer,
  type App,
  type AppSystemCtx,
  Engine,
  LocalFileStore,
  PluginRuntime,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  type FileStore,
  type RuntimeOptions,
  assertCredentialVerifier,
  assemblePlugins,
  createOidcVerifier,
  desiredPluginMounts,
  type CredentialVerifier,
  type EngineCloseDisposition,
  type ScopeResolver,
  type RealtimeRuntimeModule,
  type SystemRunner,
  MigrationError,
  PluginStorageRequirementsError,
  reconcilePluginStorage,
  reconcile,
  declareServices,
  declareJobs,
  ServiceError,
  ServiceRuntime,
  UnsafeSchemaChange,
  validateHistoryPrefix,
} from "@ackerdb/server";
import { resolveFileStoreBinding } from "@ackerdb/server/files/binding";
import type { AppConfig } from "./config.ts";
import {
  importApp,
  importFunctionModules,
  importJobModules,
  importServiceModules,
} from "./manifest.ts";
import { loadMigrationChain } from "../migrations/load.ts";
import { readStoredState } from "../migrations/stored.ts";
import { pluginStorageRecourse } from "../plugins/storage.ts";
import { fileStoreIdentity } from "../files/identity.ts";

export interface RunningApp<A extends App = App> {
  server: AckerDBServer;
  runtime: Runtime;
  engine: Engine;
  system: SystemRunner<AppSystemCtx<A>>;
  /** Declared application service names, in start order. */
  services: readonly string[];
  /**
   * Resolves when a service reports an unrecoverable failure after setup, and
   * otherwise never settles. Programmatic hosts own what happens next: ADR-0015
   * keeps signal and exit ownership at the CLI adapter.
   */
  serviceFailure: Promise<ServiceError>;
  /** Idempotently drain; success marks storage clean, while failure releases it unclean. */
  drain(): Promise<void>;
}

export type StartupPreparation = (
  config: AppConfig,
  signal: AbortSignal,
) => Promise<unknown>;

export interface StartAppOptions<A extends App = App> {
  /** Exact manifest binding for typed in-process application capabilities. */
  app?: A;
  /** Caller-owned startup cancellation. Active applications are stopped with RunningApp.drain(). */
  signal?: AbortSignal;
  /** Work that must finish before application modules are loaded, normally codegen. */
  prepare?: StartupPreparation;
  /** Programmatic auth authority. Cannot be combined with a configured verifier or OIDC. */
  credentialVerifier?: CredentialVerifier;
  /** Programmatic scope resolution. Cannot be combined with a configured scopeResolver module. */
  resolveScopes?: ScopeResolver;
  /**
   * Exit instead of applying pending migrations — the interactive dev
   * supervisor's gate, which asks for consent and restarts without the hold.
   * Production starts and non-TTY dev never set this: they apply at startup.
   */
  holdPendingMigrations?: boolean;
  /** Overrides the app-local @ackerdb/realtime runtime, primarily for embedding and tests. */
  realtime?: RealtimeRuntimeModule;
  /** Optional local-journal bounds for application logs and analytics. */
  telemetryJournal?: RuntimeOptions["telemetryJournal"];
  /** Provider adapters consuming the local telemetry journal independently. */
  telemetryExporters?: RuntimeOptions["telemetryExporters"];
}

type CredentialVerifierLoader = () => Promise<CredentialVerifier | undefined>;

async function importRealtimeRuntime(appDir: string): Promise<RealtimeRuntimeModule> {
  const require = createRequire(join(appDir, "package.json"));
  let entry: string;
  try {
    entry = require.resolve("@ackerdb/realtime");
  } catch (error) {
    throw new Error(
      "this app declares realtime routes but @ackerdb/realtime is not installed",
      { cause: error },
    );
  }
  const module = await import(pathToFileURL(entry).href) as {
    createRealtimeRuntime?: unknown;
  };
  if (typeof module.createRealtimeRuntime !== "function") {
    throw new TypeError(
      `@ackerdb/realtime at ${entry} does not export createRealtimeRuntime`,
    );
  }
  return (module.createRealtimeRuntime as () => RealtimeRuntimeModule)();
}

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

async function importScopeResolver(path: string): Promise<ScopeResolver> {
  if (!existsSync(path)) throw new Error(`scope resolver not found at ${path}`);
  let module: { default?: unknown };
  try {
    module = (await import(pathToFileURL(path).href)) as { default?: unknown };
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`failed to import scope resolver at ${path}${detail}`, { cause: error });
  }
  if (typeof module.default !== "function") {
    throw new TypeError(`scope resolver default export from ${path} must be a function`);
  }
  return module.default as ScopeResolver;
}

function scopeResolverLoader(
  config: AppConfig,
  injected: ScopeResolver | undefined,
): () => Promise<ScopeResolver | undefined> {
  if (injected !== undefined && config.scopeResolver !== undefined) {
    throw new Error("startApp resolveScopes cannot be combined with a configured scopeResolver");
  }
  if (injected !== undefined) {
    if (typeof injected !== "function") {
      throw new TypeError("startApp resolveScopes must be a function");
    }
    return async () => injected;
  }
  const path = config.scopeResolver;
  return path === undefined
    ? async () => undefined
    : async () => importScopeResolver(path);
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

/**
 * The abort reason every service observes at shutdown. Services see it before
 * their cleanup runs, so a blocking consumer can begin cooperative
 * cancellation immediately rather than waiting to be torn down.
 */
const SERVICES_STOPPING = new Error("application is shutting down");

export async function createFileStore(config: AppConfig): Promise<FileStore> {
  const files = config.files;
  if (files.backend === "filesystem") {
    return new LocalFileStore({ root: files.root });
  }
  const { S3FileStore } = await import("@ackerdb/server/files/s3");
  return new S3FileStore({
    ...(files.endpoint === undefined ? {} : { endpoint: files.endpoint }),
    region: files.region,
    bucket: files.bucket,
    forcePathStyle: files.forcePathStyle,
    checksum: files.checksum,
    encryption: files.encryption,
  });
}

export class StartupInterruptedError extends Error {
  override readonly name = "StartupInterruptedError";

  constructor() {
    super("startup interrupted by shutdown");
  }
}

export async function startApp<const A extends App = App>(
  config: AppConfig,
  options: StartAppOptions<A> = {},
): Promise<RunningApp<A>> {
  const loadCredentialVerifier = credentialVerifierLoader(config, options.credentialVerifier);
  const loadScopeResolver = scopeResolverLoader(config, options.resolveScopes);
  const startupSignal = options.signal ?? AbortSignal.any([]);
  const server = new AckerDBServer({
    limits: PRODUCTION_LIMITS,
    fileMaxBytes: config.files.maxBytes,
    hostname: config.hostname,
    port: config.port,
    statusScope: config.statusScope,
  });

  let shutdownRequested = options.signal?.aborted ?? false;
  let activated = false;
  let engineClosed = false;
  let runtime: Runtime | undefined;
  let pluginRuntime: PluginRuntime | undefined;
  let serviceRuntime: ServiceRuntime | undefined;
  let ownedEngine: Engine | undefined;
  let drainPromise: Promise<void> | null = null;
  let reportServiceFailure!: (error: ServiceError) => void;
  const serviceFailure = new Promise<ServiceError>((resolve) => {
    reportServiceFailure = resolve;
  });
  let interruptStartup!: () => void;
  const startupInterrupted = new Promise<never>((_resolve, reject) => {
    interruptStartup = () => reject(new StartupInterruptedError());
  });
  // JavaScript cannot cancel an arbitrary import/preparation Promise. Racing it
  // releases AckerDB ownership; caller-owned preparation receives the same
  // signal and owns cooperative cleanup of any resources it creates.
  const awaitStartup = <T>(work: Promise<T>): Promise<T> =>
    Promise.race([work, startupInterrupted]);

  const onStartupAbort = () => {
    shutdownRequested = true;
    interruptStartup();
  };
  const releaseStartupSignal = () => options.signal?.removeEventListener("abort", onStartupAbort);
  const closeEngine = (shutdown: EngineCloseDisposition) => {
    if (engineClosed || ownedEngine === undefined) return;
    engineClosed = true;
    ownedEngine.close(shutdown);
  };
  const drain = (): Promise<void> => {
    if (drainPromise !== null) return drainPromise;
    releaseStartupSignal();
    drainPromise = (async () => {
      // One budget for the whole sequence. Service cleanup does not get a
      // second window on top of the graceful shutdown the operator configured.
      const deadlineAtMs = Date.now() + PRODUCTION_LIMITS.gracefulShutdownMs;
      let shutdown: EngineCloseDisposition = "unclean";
      const errors: unknown[] = [];
      const collect = async (work: () => Promise<void>) => {
        try {
          await work();
        } catch (error) {
          errors.push(error);
        }
      };
      try {
        // Leave readiness before releasing services, so a service cleanup still
        // holds system authority (drain is what closes it) while no new
        // transport work is admitted against a half-released application.
        server.beginShutdown();
        if (serviceRuntime !== undefined) {
          await collect(() => serviceRuntime!.stop(SERVICES_STOPPING, deadlineAtMs));
        }
        // The server must drain even when a service refused to release, or the
        // listener and runtime would outlive the engine we are about to close.
        await collect(async () => {
          if (activated) {
            await server.drain(deadlineAtMs);
          } else if (runtime !== undefined) {
            await Promise.all([server.drain(deadlineAtMs), runtime.drain(deadlineAtMs)]);
          } else if (pluginRuntime !== undefined) {
            await Promise.all([server.drain(deadlineAtMs), pluginRuntime.stop()]);
          } else {
            await server.drain(deadlineAtMs);
          }
        });
        if (errors.length === 0) shutdown = "clean";
      } finally {
        closeEngine(shutdown);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Application shutdown failed");
    })();
    return drainPromise;
  };
  const requireStartupOwnership = () => {
    if (shutdownRequested || server.state !== "starting") {
      throw new StartupInterruptedError();
    }
  };
  options.signal?.addEventListener("abort", onStartupAbort, { once: true });

  try {
    requireStartupOwnership();
    if (options.prepare !== undefined) {
      server.advanceStartup("codegen");
      await awaitStartup(options.prepare(config, startupSignal));
      requireStartupOwnership();
    }

    server.advanceStartup("loading");
    const [app, steps] = await awaitStartup(Promise.all([
      options.app === undefined ? importApp(config) : Promise.resolve(options.app),
      loadMigrationChain(config),
    ]));
    requireStartupOwnership();

    // The hold gate: migrations rewrite rows, so the interactive dev flow
    // applies them only on an explicit yes. A held start exits before the
    // engine opens; the supervisor prompts and restarts without the hold.
    // A fresh database is never held (the chain stamps vacuously — no rows),
    // and a divergent history falls through to the engine's own report.
    if (options.holdPendingMigrations === true && steps.length > 0) {
      const stored = readStoredState(config);
      if (stored !== null) {
        let pendingCount = 0;
        try {
          pendingCount = validateHistoryPrefix(stored.applied, steps).pending.length;
        } catch {
          // Divergence is the engine's message to deliver, not the gate's.
        }
        if (pendingCount > 0) {
          throw new Error(
            `${pendingCount} pending migration(s) held for confirmation — the dev supervisor asks before applying`,
          );
        }
      }
    }

    server.advanceStartup("opening-storage");
    mkdirSync(config.dbDir, { recursive: true });
    ownedEngine = new Engine(app.schema, join(config.dbDir, "data.db"), {
      durability: config.durability,
    });
    const files = await createFileStore(config);
    const configuredFileStoreIdentity = await fileStoreIdentity(config.files);
    await awaitStartup(files.probe({ signal: startupSignal }));
    resolveFileStoreBinding(ownedEngine, configuredFileStoreIdentity);
    requireStartupOwnership();

    // A present chain reports `migrating` distinctly; an empty one reconciles
    // exactly as before. The chain form owns history, the per-step apply, and
    // the trailing safe reconcile in one call.
    server.advanceStartup(steps.length > 0 ? "migrating" : "reconciling");
    const { applied } = await reconcile(ownedEngine, steps);
    for (const line of applied) console.log(`[ackerdb] ${line}`);

    // Credential verifiers and function modules belong to the request runtime,
    // not schema migration. Load them only after durable schema work commits so
    // unrelated runtime configuration cannot block a pending migration.
    server.advanceStartup("loading-runtime");
    const [verifier, resolveScopes, modules, serviceModules, jobModules] = await awaitStartup(Promise.all([
      loadCredentialVerifier(),
      loadScopeResolver(),
      importFunctionModules(config),
      importServiceModules(config),
      importJobModules(config),
    ]));
    requireStartupOwnership();
    const declaredServices = declareServices(serviceModules);
    const declaredJobs = declareJobs(jobModules);

    const assembly = assemblePlugins(app.plugins);
    const pluginStorage = reconcilePluginStorage(ownedEngine, desiredPluginMounts(app));
    for (const line of pluginStorage.applied) console.log(`[ackerdb] Plugin ${line}`);
    pluginRuntime = new PluginRuntime({
      engine: ownedEngine,
      assembly,
      scopes: pluginStorage.scopes,
    });
    await awaitStartup(pluginRuntime.start());
    requireStartupOwnership();
    const registry = new Registry(modules, app.apiPaths);
    // The App manifest and the Registry meet here: every declared scope
    // requirement must draw from the known vocabulary.
    registry.checkScopeRequirements(app.scopes);
    const realtime = registry.realtime.size === 0
      ? undefined
      : options.realtime ?? await awaitStartup(importRealtimeRuntime(config.appDir));
    runtime = new Runtime({
      engine: ownedEngine,
      registry,
      pluginRuntime,
      jobs: declaredJobs,
      files: {
        store: files,
        publicUrl: config.files.publicUrl,
        maxBytes: config.files.maxBytes,
      },
      ...(verifier === undefined ? {} : { verifier }),
      ...(resolveScopes === undefined ? {} : { resolveScopes }),
      ...(app.scopes === undefined ? {} : { scopes: app.scopes }),
      ...(realtime === undefined ? {} : { realtime }),
      telemetry: config.telemetry === "disabled" ? false : undefined,
      ...(options.telemetryJournal === undefined
        ? {}
        : { telemetryJournal: options.telemetryJournal }),
      ...(options.telemetryExporters === undefined
        ? {}
        : { telemetryExporters: options.telemetryExporters }),
    });

    // Services own trusted background work, so they start only once the Runtime
    // can serve `system.run`, and finish before the server admits its first
    // request: readiness must never describe a half-started application.
    if (declaredServices.length > 0) {
      server.advanceStartup("starting-services");
      serviceRuntime = new ServiceRuntime({
        services: declaredServices,
        system: runtime.system,
        onStarting: (name) => server.reportStartingService(name),
        onFatal: reportServiceFailure,
      });
      await awaitStartup(serviceRuntime.start());
      requireStartupOwnership();
    }

    server.activate(runtime);
    activated = true;

    console.log(`@@ackerdb-startup ${JSON.stringify({
      telemetry: config.telemetry,
      durability: config.durability,
    })}`);
    const displayHostname = server.hostname.includes(":")
      ? `[${server.hostname}]`
      : server.hostname;
    const serviceSummary = declaredServices.length === 0
      ? ""
      : `, ${declaredServices.length} service(s)`;
    console.log(
      `[ackerdb] ready on http://${displayHostname}:${server.port} — ${registry.functions.size} function(s), ${Object.keys(app.schema.tables).length} table(s)${serviceSummary}, db at ${relative(process.cwd(), config.dbDir) || "."}`,
    );
    releaseStartupSignal();
    return {
      server,
      runtime,
      engine: ownedEngine,
      system: runtime.system as SystemRunner<AppSystemCtx<A>>,
      services: declaredServices.map((declared) => declared.name),
      serviceFailure,
      drain,
    };
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
    if (error instanceof PluginStorageRequirementsError) {
      throw new Error(pluginStorageRecourse(error, config.appDir), { cause: error });
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
  return `${message}\n\ngenerate a migration for the change above, then restart:\n\n    acker generate`;
}
