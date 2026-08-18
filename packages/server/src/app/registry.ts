/**
 * The function registry: maps dot-joined addresses ("api.messages.list") to
 * registered functions. An address is
 * `api.<...module segments>.<export name>`, exactly mirroring the generated
 * `api` binding.
 *
 * **One contributor.** Every registered function is the application's: the
 * framework declares none on its behalf, so there is no second module record to
 * flatten in and no ownership to record. What the framework offers an
 * application is capabilities on the invocation context, not functions in its
 * address space.
 */
import {
  APPLICATION_ADDRESS_ROOT,
  EVENTS_NAMESPACE,
} from "@ackerdb/core";
import type { AnyRegistered } from "./functions.ts";
import {
  validateRegisteredHttp,
  type RuntimeHttp,
} from "../transport/routing/route.ts";
import type { AnyRegisteredChannel } from "../channels/definition.ts";
import {
  definitionFromModuleExport,
} from "../definitions.ts";
import { checkRequirementAgainstVocabulary } from "../auth/scopes.ts";
import {
  validateApplicationHttpPath,
} from "../transport/http-surface.ts";

interface ModuleExport {
  /** Module path joined to export name, without the fixed `api.` root. */
  readonly name: string;
  readonly value: unknown;
}

/** Modules keyed by dot path (functions/messages.ts -> "messages"), each its exports by name. */
export type LoadedModules = Record<string, Record<string, unknown>>;

export class Registry {
  readonly functions = new Map<string, AnyRegistered>();
  readonly channels = new Map<string, AnyRegisteredChannel>();
  private readonly addressByObject = new Map<object, string>();

  /**
   * `modules` is keyed by dot path: functions/messages.ts -> "messages".
   * A listener supplies `registerHttp` so raw routes enter its live HTTP registry.
   */
  constructor(
    modules: LoadedModules,
    registerHttp?: (http: RuntimeHttp) => void,
  ) {
    const moduleExports = this.contribute(modules);

    for (const { name, value } of moduleExports) {
      const definition = definitionFromModuleExport(
        value,
        `function module export "${name}"`,
      );
      if (definition === undefined) continue;
      switch (definition.kind) {
        case "query":
        case "mutation":
        case "procedure":
        case "sse": {
          const address = `${APPLICATION_ADDRESS_ROOT}.${name}`;
          this.registerAddress(address, definition);
          this.functions.set(address, definition);
          break;
        }
        case "http": {
          const where = `http route "${name}"`;
          const http = validateRegisteredHttp(definition, where);
          validateApplicationHttpPath(http.path, where);
          registerHttp?.(http);
          break;
        }
        case "channel": {
          const address = `${APPLICATION_ADDRESS_ROOT}.${name}`;
          this.registerAddress(address, definition);
          this.channels.set(address, definition);
          break;
        }
        case "job":
          throw new TypeError(`function module export "${name}" is a job definition`);
      }
    }
  }

  /** Flatten the application's modules into one export list, in a fixed order. */
  private contribute(modules: LoadedModules): ModuleExport[] {
    const contributed: ModuleExport[] = [];
    for (const [modulePath, exports] of Object.entries(modules).sort(([a], [b]) =>
      a.localeCompare(b))) {
      if (
        modulePath === EVENTS_NAMESPACE ||
        modulePath.startsWith(`${EVENTS_NAMESPACE}.`)
      ) {
        throw new Error(
          `function module "${modulePath}": the "${EVENTS_NAMESPACE}" namespace is reserved for event-table references`,
        );
      }
      for (const [exportName, value] of Object.entries(exports).sort(([a], [b]) =>
        a.localeCompare(b))) {
        contributed.push({ name: `${modulePath}.${exportName}`, value });
      }
    }
    return contributed;
  }

  /**
   * Load-time cross-check where the App manifest meets the Registry: every
   * scope a function requires must exist in the known vocabulary. Registered
   * functions are module-level constants that exist before `defineApp` is
   * evaluated, so the check lives here rather than at registration — and it
   * covers untyped callers, which the generated builders' scope union cannot.
   */
  checkScopeRequirements(applicationScopes: readonly string[] | undefined): void {
    const vocabulary = applicationScopes ?? [];
    for (const [address, fn] of this.functions) {
      if (fn.scopes === undefined) continue;
      // Registration already normalized and froze it. Re-normalizing here
      // would mean validating a value dispatch may not be enforcing.
      checkRequirementAgainstVocabulary(fn.scopes, vocabulary, `function "${address}"`);
    }
  }

  /** The one fixed-root application address space, checked once. */
  private registerAddress(
    address: string,
    value: AnyRegistered | AnyRegisteredChannel,
  ): void {
    if (this.functions.has(address) || this.channels.has(address)) {
      throw new Error(`duplicate server export address "${address}"`);
    }
    const existingAddress = this.addressByObject.get(value);
    if (existingAddress !== undefined) {
      const kind = value.kind === "channel" ? "registered channel" : "registered function";
      throw new Error(`${kind} is exported at both "${existingAddress}" and "${address}"`);
    }
    this.addressByObject.set(value, address);
  }

  /** Every registered function is addressable; `access` alone decides admission. */
  get(address: string): AnyRegistered | undefined {
    return this.functions.get(address);
  }

  getChannel(address: string): AnyRegisteredChannel | undefined {
    return this.channels.get(address);
  }

  kindOf(address: string): string | undefined {
    return this.functions.get(address)?.kind ??
      this.channels.get(address)?.kind;
  }

  addressOf(value: object): string | undefined {
    return this.addressByObject.get(value);
  }
}
