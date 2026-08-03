import type { CredentialVerifier } from "../../auth/credentials.ts";
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
import type { ServiceLimits } from "../limits.ts";
import type { RuntimeHooks } from "./lifecycle.ts";

export interface RuntimeOptions {
  readonly engine: Engine;
  readonly registry: Registry;
  /** A started Plugin graph bound to this Engine's reconciled private scopes. */
  readonly pluginRuntime?: PluginRuntime;
  readonly verifier?: CredentialVerifier;
  readonly limits?: ServiceLimits;
  readonly telemetry?: Telemetry | TelemetryOptions | false;
  readonly telemetryJournal?: TelemetryJournal | Omit<TelemetryJournalOptions, "path">;
  readonly telemetryExporters?: Omit<TelemetryJournalExportersOptions, "journal">;
  readonly hooks?: RuntimeHooks;
  readonly now?: () => number;
  readonly realtime?: RealtimeRuntimeModule;
}
