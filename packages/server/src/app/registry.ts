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
  httpPathForAddress,
  RESERVED_MARKER,
} from "@ackerdb/core";
import {
  httpExposure,
  type AnyRegistered,
} from "./functions.ts";
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
  claimsReservedName,
  exposedHttpKind,
  isAckerDBHttpRoute,
  type ExposedHttpKind,
} from "../transport/http-surface.ts";
import {
  compileExposedHttpCodec,
  type ExposedHttpCodec,
} from "../transport/http-codec.ts";
import { validateRoutePath } from "../transport/routing/path.ts";

interface ModuleExport {
  /** Module path joined to export name, without the fixed `api.` root. */
  readonly name: string;
  readonly value: unknown;
}

/** One HTTP-exposed function: the path it owns and whether OpenAPI documents it. */
export interface ExposedFunction {
  readonly address: string;
  readonly path: string;
  readonly openapi: boolean;
  /** Narrowed once, here: the served surface and the document both read it. */
  readonly kind: ExposedHttpKind;
  readonly fn: AnyRegistered;
  /** The standard-JSON boundary the served surface and the document share. */
  readonly codec: ExposedHttpCodec;
}

/** Modules keyed by dot path (functions/messages.ts -> "messages"), each its exports by name. */
export type LoadedModules = Record<string, Record<string, unknown>>;

export class Registry {
  readonly functions = new Map<string, AnyRegistered>();
  /** HTTP-exposed functions keyed by address; their path is derived from it. */
  readonly exposed = new Map<string, ExposedFunction>();
  readonly channels = new Map<string, AnyRegisteredChannel>();
  private readonly addressByObject = new Map<object, string>();

  /**
   * `modules` is keyed by dot path: functions/messages.ts -> "messages".
   * A listener supplies `registerHttp`; metadata-only consumers omit it.
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
          this.refuseAckerDBPath(http.path, where);
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

    for (const [address, fn] of this.functions) {
      const exposure = httpExposure(fn.http, `function "${address}" http`);
      if (exposure === null) continue;
      // The kind is narrowed once, at load: an exposure no method serves is a
      // registration error like every other malformed one, never a 404 at call
      // time and a silent omission from the document.
      const kind = exposedHttpKind(fn.kind);
      if (kind === undefined) {
        throw new Error(
          `HTTP-exposed function "${address}" is a ${fn.kind}, which the HTTP surface does not serve`,
        );
      }
      // A derived path is a path like any other: an export named through a
      // string literal can project one the route grammar does not admit. An
      // explicit path was already checked by the factory that built it.
      const where = `HTTP-exposed function "${address}"`;
      const path = validateRoutePath(httpPathForAddress(address), where);
      this.refuseAckerDBPath(path, where);
      // The codec is compiled here, once: a contract that cannot cross the
      // surface's standard-JSON boundary fails the load, never a caller.
      this.exposed.set(address, Object.freeze({
        address,
        path,
        openapi: exposure.openapi,
        kind,
        fn,
        codec: compileExposedHttpCodec(address, fn),
      }));
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

  /**
   * The application's HTTP namespace policy, derived paths and explicit ones
   * alike: an application may not claim a path AckerDB owns.
   */
  private refuseAckerDBPath(path: string, where: string): void {
    if (isAckerDBHttpRoute(path) || claimsReservedName(path)) {
      throw new Error(
        `${where} claims AckerDB-owned path "${path}": AckerDB owns its built-in ` +
          `paths and every name marked "${RESERVED_MARKER}"`,
      );
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
