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
  TelemetryJournalOptions,
} from "../../telemetry/application-signals/journal.ts";
import type { Telemetry, TelemetryOptions } from "../../telemetry/telemetry.ts";
import type { TelemetryStore, TelemetryStoreOptions } from "../../telemetry/storage/store.ts";
import type { ServiceLimits } from "../limits.ts";
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
   * Resolves the scope grant an Identity holds, re-read on every credential
   * verification and auth-epoch transition. Publish an account invalidation
   * (through the verifier's invalidation channel) when a grant changes so
   * live sessions re-authorize immediately.
   */
  readonly resolveScopes?: ScopeResolver;
  /** The application scope vocabulary (defineApp({ scopes })); undefined when none. */
  readonly scopes?: readonly string[];
  readonly limits?: ServiceLimits;
  readonly telemetry?: Telemetry | TelemetryOptions | false;
  /** The `<db>.telemetry` sidecar home and its per-class retention clocks. */
  readonly telemetryStore?: TelemetryStore | Omit<TelemetryStoreOptions, "path" | "now">;
  readonly telemetryJournal?: TelemetryJournal | Omit<TelemetryJournalOptions, "store">;
  readonly telemetryExporters?: Omit<TelemetryJournalExportersOptions, "journal">;
  readonly hooks?: RuntimeHooks;
  /** Declared jobs, named and ordered by declareJobs(...). */
  readonly jobs?: readonly DeclaredJob[];
  /** Built-in immutable File storage and delivery configuration. */
  readonly files?: RuntimeFilesOptions;
  readonly now?: () => number;
  readonly realtime?: RealtimeRuntimeModule;
}
