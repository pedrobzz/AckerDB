/**
 * The boot: the one startup sequence from a bound listener to an activated
 * application. `acker start` and any programmatic host are a `main` around it —
 * they read configuration, build loaders and values, call `boot`, and print
 * what the reporter says. Every ordering guarantee lives here, next to the
 * things it orders:
 *
 *   listening → codegen (if `prepare`) → loading → hold check → opening-storage
 *   → migrating | reconciling → loading-runtime → starting-runtime →
 *   activation.
 *
 * The listener is built first so `/live` and `/ready` answer through a slow
 * migration. Runtime modules load only after durable schema work commits, so
 * unrelated runtime configuration cannot block a pending migration. Nothing
 * here mints a credential: an application with no credentials is a valid
 * application, and whether a root credential should exist is its decision to
 * make through its own functions. Activation is last and refuses a Runtime
 * that is not ready.
 *
 * Interruption is one AbortSignal, checked at every phase boundary and raced
 * only against work JavaScript cannot cancel — the caller's preparation, the
 * loaders, the FileStore probe. Reconcile and the Runtime's start are bounded
 * local transactions and are never abandoned. On interruption boot drains what
 * it built and rejects with the signal's reason.
 */
import type { DurabilityPolicy } from "@ackerdb/core";
import type { App } from "./app/definition.ts";
import type { CollectedDefinition } from "./definitions.ts";
import type { AppSystemCtx, SystemRunner } from "./app/system.ts";
import type { CredentialVerifier, ScopeResolver } from "./auth/credentials.ts";
import { Engine, type EngineCloseDisposition } from "./database/engine.ts";
import { resolveFileStoreBinding } from "./files/binding.ts";
import type { RuntimeFilesOptions } from "./files/namespace.ts";
import type { FileStore } from "./files/store/contract.ts";
import { settleOnAbort } from "./runtime/abort.ts";
import { PRODUCTION_LIMITS, type ServiceLimits } from "./runtime/limits.ts";
import { Runtime } from "./runtime/runtime.ts";
import { validateHistoryPrefix } from "./schema/migrations/chain.ts";
import { readStoredState } from "./schema/migrations/stored.ts";
import type { MigrationStep } from "./schema/migrations/types.ts";
import { reconcile } from "./schema/reconcile.ts";
import {
  AckerDBServer,
  type AckerDBServerOptions,
  type AckerDBStartupPhase,
} from "./transport/server.ts";

/** What durable schema work needs: the manifest and its migration chain. */
export interface LoadedApp<A extends App = App> {
  readonly app: A;
  readonly migrations: MigrationStep[];
}

/** What the request runtime needs; loaded only after durable schema work commits. */
export interface LoadedRuntime {
  readonly definitions: readonly CollectedDefinition[];
  readonly verifier?: CredentialVerifier;
  readonly resolveScopes?: ScopeResolver;
}

/**
 * Loaders rather than values, because *when* they run is the point: the
 * manifest before storage opens, application code only after the schema is
 * settled. Dynamic import of user code stays with the host; a test or an
 * embedder wraps already-built values in a loader.
 */
export interface BootLoaders<A extends App = App> {
  app(signal: AbortSignal): Promise<LoadedApp<A>>;
  runtime(signal: AbortSignal): Promise<LoadedRuntime>;
}

/** Told what happened, synchronously, at the moment it happens. Boot itself never writes to stdout. */
export interface BootReporter {
  phase?(phase: AckerDBStartupPhase): void;
  reconciled?(lines: readonly string[]): void;
}

export interface BootStorage {
  /** The database file; the Engine creates its directory if absent. */
  readonly path: string;
  readonly durability?: DurabilityPolicy;
}

export interface BootFiles extends RuntimeFilesOptions {
  readonly store: FileStore;
}

export interface BootOptions<A extends App = App> {
  readonly listener: Omit<AckerDBServerOptions, "limits" | "fileMaxBytes">;
  readonly storage: BootStorage;
  readonly files: BootFiles;
  readonly load: BootLoaders<A>;
  /** Defaults to PRODUCTION_LIMITS; shared by the listener and the Runtime. */
  readonly limits?: ServiceLimits;
  readonly now?: () => number;
  /** Caller-owned startup cancellation; a running application is stopped with `RunningApp.drain()`. */
  readonly signal?: AbortSignal;
  readonly reporter?: BootReporter;
  /**
   * `hold`: refuse to open storage while the chain has pending migrations —
   * the interactive dev supervisor's gate, which asks and restarts without the
   * hold. Production starts apply at startup.
   */
  readonly pendingMigrations?: "apply" | "hold";
  /** Work that must finish before anything is loaded — normally codegen. */
  readonly prepare?: (signal: AbortSignal) => Promise<unknown>;
}

export interface RunningApp<A extends App = App> {
  /** The manifest this application booted from. */
  readonly app: A;
  readonly server: AckerDBServer;
  readonly runtime: Runtime;
  readonly engine: Engine;
  readonly system: SystemRunner<AppSystemCtx<A>>;
  /** Idempotently drain; success marks storage clean, while failure releases it unclean. */
  drain(): Promise<void>;
}

/** The hold gate's refusal: pending migrations exist and this boot may not apply them. */
export class MigrationsHeldError extends Error {
  override readonly name = "MigrationsHeldError";

  constructor(readonly pending: number) {
    super(`${pending} pending migration(s) held for confirmation`);
  }
}

export async function boot<const A extends App = App>(options: BootOptions<A>): Promise<RunningApp<A>> {
  const limits = options.limits ?? PRODUCTION_LIMITS;
  const signal = options.signal ?? AbortSignal.any([]);
  const reporter = options.reporter ?? {};
  // An aborted boot touches nothing: not even the port.
  if (signal.aborted) throw signal.reason;
  const server = new AckerDBServer({
    ...options.listener,
    limits,
    ...(options.files.maxBytes === undefined ? {} : { fileMaxBytes: options.files.maxBytes }),
  });
  reporter.phase?.("listening");

  let engine: Engine | undefined;
  let runtime: Runtime | undefined;
  let drainPromise: Promise<void> | null = null;

  const drain = (): Promise<void> => {
    if (drainPromise !== null) return drainPromise;
    drainPromise = (async () => {
      const deadlineAtMs = Date.now() + limits.gracefulShutdownMs;
      let shutdown: EngineCloseDisposition = "unclean";
      try {
        server.beginShutdown();
        // An activated listener drains its Runtime; before activation the two
        // are still separate owners and drain side by side.
        await (server.runtime !== null || runtime === undefined
          ? server.drain(deadlineAtMs)
          : Promise.all([server.drain(deadlineAtMs), runtime.drain(deadlineAtMs)]));
        shutdown = "clean";
      } finally {
        engine?.close(shutdown);
      }
    })();
    return drainPromise;
  };

  const checkpoint = () => {
    if (signal.aborted) throw signal.reason;
  };
  const advance = (phase: Exclude<AckerDBStartupPhase, "listening">) => {
    checkpoint();
    server.advanceStartup(phase);
    reporter.phase?.(phase);
  };
  // JavaScript cannot cancel an arbitrary import or preparation. Racing it
  // releases AckerDB ownership; the work receives the same signal and owns
  // cooperative cleanup of whatever it created.
  const raced = <T>(work: Promise<T>): Promise<T> => settleOnAbort(work, signal);

  try {
    if (options.prepare !== undefined) {
      advance("codegen");
      await raced(options.prepare(signal));
    }

    advance("loading");
    const { app, migrations } = await raced(options.load.app(signal));

    // The hold gate: migrations rewrite rows, so the interactive dev flow
    // applies them only on an explicit yes. A held start refuses before the
    // engine opens; the supervisor prompts and restarts without the hold. A
    // fresh database is never held (the chain stamps vacuously — no rows), and
    // a divergent history falls through to the engine's own report.
    if (options.pendingMigrations === "hold" && migrations.length > 0) {
      const stored = readStoredState(options.storage.path);
      if (stored !== null) {
        let pending = 0;
        try {
          pending = validateHistoryPrefix(stored.applied, migrations).pending.length;
        } catch {
          // Divergence is the engine's message to deliver, not the gate's.
        }
        if (pending > 0) throw new MigrationsHeldError(pending);
      }
    }

    advance("opening-storage");
    engine = new Engine(app.schema, options.storage.path, {
      ...(options.storage.durability === undefined ? {} : { durability: options.storage.durability }),
    });
    await raced(options.files.store.probe({ signal }));
    resolveFileStoreBinding(engine, await raced(options.files.store.identity({ signal })));

    // A present chain reports `migrating` distinctly; an empty one reconciles
    // exactly as before. The chain form owns history, the per-step apply, and
    // the trailing safe reconcile in one call.
    advance(migrations.length > 0 ? "migrating" : "reconciling");
    const { applied } = await reconcile(engine, migrations);
    reporter.reconciled?.(applied);

    // Credential verifiers and application modules belong to the request
    // runtime, not schema migration. Load them only after durable schema work
    // commits.
    advance("loading-runtime");
    const loaded = await raced(options.load.runtime(signal));
    const registry = server.registerDefinitions(loaded.definitions);
    // The App manifest and the Registry meet here: every declared scope
    // requirement must draw from the known vocabulary.
    registry.checkScopeRequirements(app.scopes);
    runtime = new Runtime({
      engine,
      registry,
      limits,
      files: options.files,
      ...(loaded.verifier === undefined ? {} : { verifier: loaded.verifier }),
      ...(loaded.resolveScopes === undefined ? {} : { resolveScopes: loaded.resolveScopes }),
      ...(app.scopes === undefined ? {} : { scopes: app.scopes }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    // Nothing arms before this: the manifest is checked before the first
    // repeat Job can be minted or run.
    advance("starting-runtime");
    await runtime.start();
    checkpoint();

    server.activate(runtime);
    return {
      app,
      server,
      runtime,
      engine,
      system: runtime.system as SystemRunner<AppSystemCtx<A>>,
      drain,
    };
  } catch (error) {
    // A cleanup/deadline failure is the owning shutdown outcome; it is what
    // the caller sees, never a successful-looking interruption.
    await drain();
    throw error;
  }
}
