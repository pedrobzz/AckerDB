import type { CredentialVerifier, ScopeResolver } from "../../auth/credentials.ts";
import type { Registry } from "../../app/registry.ts";
import type { Engine } from "../../database/engine.ts";
import type { PluginRuntime } from "../../plugins/runtime.ts";
import type { RealtimeRuntimeModule } from "../../realtime/host.ts";
import type {
  TelemetryJournalExportersOptions,
} from "../../telemetry/application-signals/exporters.ts";
import type {
  TelemetryJournal,
} from "../../telemetry/application-signals/journal.ts";
import type { Telemetry, TelemetryOptions } from "../../telemetry/telemetry.ts";
import type { ServiceLimits } from "../limits.ts";
import type { AdminOptions } from "./admin.ts";
import type { RuntimeHooks } from "./lifecycle.ts";
import type { DeclaredJob } from "../../jobs/definition.ts";
import type { RuntimeFilesOptions } from "../../files/namespace.ts";

export interface RuntimeOptions {
  readonly engine: Engine;
  readonly registry: Registry;
  /** A started Plugin graph bound to this Engine's reconciled private scopes. */
  readonly pluginRuntime?: PluginRuntime;
  readonly verifier?: CredentialVerifier;
  /**
   * Resolves the grant patterns an Identity holds, re-read on every credential
   * verification and auth-epoch transition. Publish an account invalidation
   * when a grant changes, so live sessions re-authorize immediately.
   */
  readonly resolveScopes?: ScopeResolver;
  /** The application scope vocabulary (`defineApp({ scopes })`); absent when none. */
  readonly scopes?: readonly string[];
  readonly limits?: ServiceLimits;
  /**
   * Everything an operator configures about the framework's own surfaces —
   * today telemetry storage, retention and the one enabled switch. The three
   * fields below are composition, not configuration: they supply an object
   * instead of describing one.
   */
  readonly admin?: AdminOptions;
  /**
   * An in-memory recorder to use instead of the one this Runtime would build.
   * An injected instance brings its own enabled-ness; `admin.telemetry.enabled`
   * governs the instance the Runtime constructs.
   */
  readonly telemetry?: Telemetry | TelemetryOptions;
  /**
   * A journal to use instead of the one this Runtime would open. Its store
   * becomes this Runtime's telemetry store — the journal already knows which
   * sidecar it lives in, and a second field naming that sidecar would be one
   * fact wearing two names.
   */
  readonly telemetryJournal?: TelemetryJournal;
  readonly telemetryExporters?: Omit<TelemetryJournalExportersOptions, "journal">;
  readonly hooks?: RuntimeHooks;
  /** Declared jobs, named and ordered by declareJobs(...). */
  readonly jobs?: readonly DeclaredJob[];
  /** Built-in immutable File storage and delivery configuration. */
  readonly files?: RuntimeFilesOptions;
  readonly now?: () => number;
  readonly realtime?: RealtimeRuntimeModule;
}
