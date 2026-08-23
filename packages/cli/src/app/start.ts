/**
 * `acker start`, programmatically: the configuration becomes boot parts — the
 * listener, storage and File values, and the two loaders that import the
 * application's manifest, migrations, modules and auth authorities from its
 * directory — and `boot()` from `@ackerdb/server` owns the sequence. What boot
 * reports is printed here, and nowhere else.
 */
import { relative } from "node:path";
import {
  type App,
  PRODUCTION_LIMITS,
  assertCredentialVerifier,
  boot,
  createOidcVerifier,
  type BootOptions,
  type CredentialVerifier,
  type RunningApp,
  type ScopeResolver,
  MigrationError,
  UnsafeSchemaChange,
} from "@ackerdb/server";
import { databasePath, type AppConfig } from "./config.ts";
import {
  importEntrypoint,
  importConfiguredDefault,
  importDefinitionModules,
} from "./manifest.ts";
import { loadMigrationChain } from "../migrations/load.ts";
import { createFileStore } from "../files/store.ts";

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
}

async function importCredentialVerifier(path: string): Promise<CredentialVerifier> {
  const exported = await importConfiguredDefault(path, "credential verifier");
  assertCredentialVerifier(
    exported,
    PRODUCTION_LIMITS.auth.revocationDeadlineMs,
    `credential verifier default export from ${path}`,
  );
  return exported;
}

async function importScopeResolver(path: string): Promise<ScopeResolver> {
  const exported = await importConfiguredDefault(path, "scope resolver");
  if (typeof exported !== "function") {
    throw new TypeError(`scope resolver default export from ${path} must be a function`);
  }
  return exported as ScopeResolver;
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
): () => Promise<CredentialVerifier | undefined> {
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

export async function startApp<const A extends App = App>(
  config: AppConfig,
  options: StartAppOptions<A> = {},
): Promise<RunningApp<A>> {
  const loadCredentialVerifier = credentialVerifierLoader(config, options.credentialVerifier);
  const loadScopeResolver = scopeResolverLoader(config, options.resolveScopes);
  const prepare = options.prepare;
  const parts: BootOptions<A> = {
    listener: {
      hostname: config.hostname,
      port: config.port,
      statusScope: config.statusScope,
    },
    storage: { path: databasePath(config), durability: config.durability },
    files: {
      store: await createFileStore(config.files),
      publicUrl: config.files.publicUrl,
      maxBytes: config.files.maxBytes,
    },
    limits: PRODUCTION_LIMITS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(prepare === undefined ? {} : { prepare: (signal: AbortSignal) => prepare(config, signal) }),
    pendingMigrations: options.holdPendingMigrations === true ? "hold" : "apply",
    load: {
      app: async () => {
        const [app, migrations] = await Promise.all([
          options.app === undefined
            ? importEntrypoint(config) as Promise<A>
            : Promise.resolve(options.app),
          loadMigrationChain(config),
        ]);
        return { app, migrations };
      },
      runtime: async () => {
        const [verifier, resolveScopes, modules] = await Promise.all([
          loadCredentialVerifier(),
          loadScopeResolver(),
          importDefinitionModules(config),
        ]);
        return {
          modules,
          ...(verifier === undefined ? {} : { verifier }),
          ...(resolveScopes === undefined ? {} : { resolveScopes }),
        };
      },
    },
    reporter: {
      reconciled: (lines) => {
        for (const line of lines) console.log(`[ackerdb] ${line}`);
      },
    },
  };

  let running: RunningApp<A>;
  try {
    running = await boot(parts);
  } catch (error) {
    if (error instanceof UnsafeSchemaChange || error instanceof MigrationError) {
      throw new Error(withGenerationRecourse(error.message), { cause: error });
    }
    throw error;
  }

  const { server } = running;
  console.log(`@@ackerdb-startup ${JSON.stringify({ durability: config.durability })}`);
  const displayHostname = server.hostname.includes(":") ? `[${server.hostname}]` : server.hostname;
  console.log(
    `[ackerdb] ready on http://${displayHostname}:${server.port} — ${running.runtime.registry.functions.size} function(s), ${Object.keys(running.app.schema.tables).length} table(s), db at ${relative(process.cwd(), config.dbDir) || "."}`,
  );
  return running;
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
