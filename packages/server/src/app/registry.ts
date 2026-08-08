/**
 * The function registry: maps dot-joined addresses ("api.messages.list") to
 * registered functions. An address is `<apiPath>.<...module segments>.<export
 * name>`, exactly mirroring what codegen puts on the generated group bindings.
 *
 * **The group is part of the address, so one flat key is enough.** Two groups
 * may each hold a `messages.list`; one group may not hold it twice. That falls
 * out of the key rather than being a rule applied on top of it, which is why
 * there is no per-group map here and no group argument on any lookup.
 */
import {
  DEFAULT_API_PATH,
  EVENTS_NAMESPACE,
  getRef,
  httpPathForAddress,
  RESERVED_MARKER,
} from "@ackerdb/core";
import type { Principal } from "../auth/credentials.ts";
import {
  apiPath,
  httpExposure,
  isRegisteredFunction,
  refuseApiPathDeclaration,
  type AnyRegistered,
} from "./functions.ts";
import {
  isHttpHandlerShaped,
  validateRegisteredHttpHandler,
  type AnyRegisteredHttpHandler,
} from "./http-handler.ts";
import {
  isRegisteredChannel,
  type AnyRegisteredChannel,
} from "../channels/definition.ts";
import {
  isRegisteredRealtime,
  type AnyRegisteredRealtime,
} from "../realtime/definition.ts";
import {
  isMcpDeclaration,
  isRegisteredMcpTool,
  type AnyMcpDeclaration,
  type AnyRegisteredMcpTool,
  type McpEndpointDeclaration,
} from "../mcp/index.ts";
import { isMcpToolAuthorized } from "../mcp/tool-access.ts";
import {
  checkRequirementAgainstVocabulary,
  knownScopeVocabulary,
} from "../auth/scopes.ts";
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

type ServerOnlyExport = AnyMcpDeclaration;

interface ModuleExport {
  /**
   * Module path joined to export name — the address without its group, which
   * only the export's own declaration knows. Error messages before the group
   * is resolved name this, because it is the file and export a developer can
   * go and edit.
   */
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

/** One raw handler: the path it owns and the registered handler that serves it. */
export interface HttpHandlerRoute {
  readonly address: string;
  readonly path: string;
  readonly fn: AnyRegisteredHttpHandler;
}

export class Registry {
  readonly functions = new Map<string, AnyRegistered>();
  /** HTTP-exposed functions keyed by the path they own. */
  readonly exposed = new Map<string, ExposedFunction>();
  /** The same functions keyed by address: the served call knows its path, the runtime its address. */
  private readonly exposedByAddress = new Map<string, ExposedFunction>();
  /** Raw handler routes keyed by the path they own. */
  readonly httpRoutes = new Map<string, HttpHandlerRoute>();
  private readonly httpHandlersByAddress = new Map<string, AnyRegisteredHttpHandler>();
  readonly channels = new Map<string, AnyRegisteredChannel>();
  readonly realtime = new Map<string, AnyRegisteredRealtime>();
  readonly serverOnly = new Map<string, ServerOnlyExport>();
  readonly mcps = new Map<string, AnyMcpDeclaration>();
  readonly mcpTools = new Map<string, AnyRegisteredMcpTool>();
  private readonly mcpByPath = new Map<string, AnyMcpDeclaration>();
  private readonly toolsByMcp = new Map<AnyMcpDeclaration, readonly AnyRegisteredMcpTool[]>();
  private readonly addressByObject = new Map<object, string>();
  /** Every group this registry may publish: the manifest's, plus the default. */
  private readonly declaredApiPaths: ReadonlySet<string>;

  /**
   * `modules` is keyed by dot path: functions/messages.ts -> "messages".
   *
   * `declaredApiPaths` is the manifest's `apiPaths`. A function published in a
   * group not named there is a startup refusal: code generation reads the
   * manifest alone, so an undeclared group is a live address no binding can
   * name, and a misspelled one is invisible in exactly the same way. Omitting
   * the argument declares no group beyond the default rather than waiving the
   * rule — the check has no off switch.
   */
  constructor(
    modules: Record<string, Record<string, unknown>>,
    declaredApiPaths: readonly string[] = [],
  ) {
    this.declaredApiPaths = new Set([DEFAULT_API_PATH, ...declaredApiPaths]);
    const moduleExports: ModuleExport[] = [];
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
        moduleExports.push({ name: `${modulePath}.${exportName}`, value });
      }
    }

    for (const { name, value } of moduleExports) {
      if (!isRegisteredFunction(value)) continue;
      // The group is resolved before the address exists, because it is the
      // address's first segment. That also puts the manifest reconciliation on
      // every function, exposed or not: a group decides the generated binding
      // as well as the HTTP root, and a function with no binding is as broken
      // as one with no route.
      const address = `${this.groupOf(value.apiPath, name, "function")}.${name}`;
      this.registerAddress(address, value);
      this.functions.set(address, value);
    }

    for (const { name, value } of moduleExports) {
      if (!isHttpHandlerShaped(value)) continue;
      // The registry serves the validated snapshot, never the exported object:
      // an accessor cannot answer one way at registration and another at
      // dispatch. Addresses still key off the exported identity.
      const registered = validateRegisteredHttpHandler(value, `http handler "${name}"`);
      const address = `${this.groupOf(registered.apiPath, name, "http handler")}.${name}`;
      this.registerAddress(address, value);
      this.httpHandlersByAddress.set(address, registered);
    }

    // The socket kinds' refusal is re-applied here for the same reason every
    // other field is re-read: the builder is bypassable, and a hand-built
    // export carrying `apiPath` would otherwise have it silently ignored.
    // Refusing it is what makes the default group their address prefix.
    for (const { name, value } of moduleExports) {
      if (!isRegisteredChannel(value)) continue;
      refuseApiPathDeclaration(value, `channel "${name}"`);
      const address = `${DEFAULT_API_PATH}.${name}`;
      this.registerAddress(address, value);
      this.channels.set(address, value);
    }

    for (const { name, value } of moduleExports) {
      if (!isRegisteredRealtime(value)) continue;
      refuseApiPathDeclaration(value, `realtime declaration "${name}"`);
      const address = `${DEFAULT_API_PATH}.${name}`;
      this.registerAddress(address, value);
      this.realtime.set(address, value);
    }

    for (const { name, value } of moduleExports) {
      if (!isMcpDeclaration(value)) continue;
      // An MCP endpoint is server-only: it has no reference in any group, so
      // it takes the default group's prefix to occupy one name in the one
      // address space every module export shares.
      const address = `${DEFAULT_API_PATH}.${name}`;
      this.registerAddress(address, value);
      const existing = this.mcps.get(value.name);
      if (existing !== undefined) {
        throw new Error(`duplicate MCP name "${value.name}"`);
      }
      // A private endpoint claims no path: it is reachable only through
      // `aiTools`, so it neither collides with an application module nor
      // leaves a route advertising a tool list no caller may read.
      if (value.path !== null) {
        // Two refusals, not one message: a path that hits a built-in route and
        // a path that reaches into a marked name send the developer looking in
        // very different places.
        if (isAckerDBHttpRoute(value.path)) {
          throw new Error(
            `MCP "${value.name}" path "${value.path}" collides with AckerDB route "${value.path}"`,
          );
        }
        if (claimsReservedName(value.path)) {
          throw new Error(
            `MCP "${value.name}" path "${value.path}" claims a "${RESERVED_MARKER}"-marked name reserved to AckerDB`,
          );
        }
        const pathOwner = this.mcpByPath.get(value.path);
        if (pathOwner !== undefined) {
          throw new Error(
            `MCP "${value.name}" and "${pathOwner.name}" both use path "${value.path}"`,
          );
        }
        this.mcpByPath.set(value.path, value);
      }
      this.mcps.set(value.name, value);
      this.serverOnly.set(address, value);
      const endpointTools = Object.freeze(Object.values(value.tools));
      this.toolsByMcp.set(value, endpointTools);
      for (const tool of endpointTools) {
        const name = tool.name;
        const key = this.mcpToolKey(value.name, name);
        if (this.mcpTools.has(key)) {
          throw new Error(`duplicate MCP tool name "${name}" in MCP "${value.name}"`);
        }
        this.mcpTools.set(key, tool);
      }
    }

    // Exposed paths are claimed after every MCP path, so the single collision
    // check below covers both declaration orders.
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
      const path = this.claimApplicationHttpPath(address, "HTTP-exposed function");
      // The codec is compiled here, once: a contract that cannot cross the
      // surface's standard-JSON boundary fails the load, never a caller.
      const exposed = Object.freeze({
        address,
        path,
        openapi: exposure.openapi,
        kind,
        fn,
        codec: compileExposedHttpCodec(address, fn),
      });
      this.exposed.set(path, exposed);
      this.exposedByAddress.set(address, exposed);
    }

    // Raw handler paths are claimed with the same nets as exposed functions:
    // the reserved prefix, MCP collisions, and any path already claimed. They
    // are claimed second, so one check covers a raw path colliding with an
    // exposed one as well as with another raw one.
    for (const [address, fn] of this.httpHandlersByAddress) {
      const path = this.claimApplicationHttpPath(address, "http handler");
      this.httpRoutes.set(path, Object.freeze({ address, path, fn }));
    }

    // The two server-only kinds are the two the passes above recognize, so the
    // refusal reads the value's shape rather than where it landed: a marked
    // export the registry does not understand has no address to be named by.
    for (const { name, value } of moduleExports) {
      if (
        (typeof value === "object" || typeof value === "function") &&
        value !== null &&
        (value as { readonly isAckerDBServerOnly?: unknown }).isAckerDBServerOnly === true &&
        !isMcpDeclaration(value) &&
        !isHttpHandlerShaped(value)
      ) {
        throw new Error(`unknown server-only export at "${name}"`);
      }
    }
  }

  /**
   * Load-time cross-check where the App manifest meets the Registry: every
   * scope a function or a tool entry requires must exist in the known
   * vocabulary. Registered declarations are module-level constants that exist
   * before `defineApp` is evaluated, so the check lives here rather than at
   * registration — and it covers untyped callers, which the generated
   * builders' scope union cannot.
   */
  checkScopeRequirements(applicationScopes: readonly string[] | undefined): void {
    const vocabulary = knownScopeVocabulary(applicationScopes);
    for (const [address, fn] of this.functions) {
      if (fn.scopes === undefined) continue;
      // Registration already normalized and froze it. Re-normalizing here
      // would mean validating a value dispatch may not be enforcing.
      checkRequirementAgainstVocabulary(fn.scopes, vocabulary, `function "${address}"`);
    }
    for (const tool of this.mcpTools.values()) {
      const policy = tool.accessPolicy;
      if (policy.kind !== "anyOf" && policy.kind !== "allOf") continue;
      checkRequirementAgainstVocabulary(
        policy,
        vocabulary,
        `MCP "${tool.mcp.name}" tool "${tool.name}"`,
      );
    }
  }

  /**
   * The one interpreter of a registered value's group, and so of the first
   * segment of its address. It is re-read, never trusted: an untyped export
   * meets the same shape rule the builder applies, so a malformed group is a
   * registration error rather than an address at `undefined.messages.list` or
   * a route at `/_admin/...`.
   */
  private groupOf(value: unknown, name: string, label: string): string {
    const group = apiPath(value, `${label} "${name}" apiPath`);
    if (!this.declaredApiPaths.has(group)) {
      throw new Error(
        `${label} "${name}" declares apiPath "${group}", which the application manifest does not list in apiPaths`,
      );
    }
    return group;
  }

  /** One owner for the application-path invariants: the `_` reserve and every path collision. */
  private claimApplicationHttpPath(address: string, label: string): string {
    const path = httpPathForAddress(address);
    // `claimsReservedName` does the work here: a validated group can never
    // begin with `_`, so an address-derived path cannot reach a built-in route
    // — the first arm is belt and braces against a future route shape.
    if (isAckerDBHttpRoute(path) || claimsReservedName(path)) {
      throw new Error(
        `${label} "${address}" claims AckerDB-owned path "${path}"; "${RESERVED_MARKER}" is reserved to AckerDB`,
      );
    }
    const mcp = this.mcpByPath.get(path);
    if (mcp !== undefined) {
      throw new Error(`${label} "${address}" and MCP "${mcp.name}" both use path "${path}"`);
    }
    // Unique addresses do not imply unique paths: the projection joins on `/`
    // where the address joined on `.`, and an export named through a string
    // literal may contain either. `api.notes.a/b` and `api.notes.a.b` are two
    // functions with two access policies at one URL, and the second insertion
    // would otherwise replace the first in silence.
    const owner = this.exposed.get(path)?.address ?? this.httpRoutes.get(path)?.address;
    if (owner !== undefined) {
      throw new Error(`${label} "${address}" and "${owner}" both claim path "${path}"`);
    }
    return path;
  }

  /**
   * The one address space, checked once. Because the group is the address's
   * first segment, `api.messages.list` and `internal.messages.list` are two
   * keys and both may exist — the collision this refuses is one group holding
   * a name twice, which is the only one that ever meant anything.
   */
  private registerAddress(address: string, value: object): void {
    if (
      this.functions.has(address) ||
      this.httpHandlersByAddress.has(address) ||
      this.channels.has(address) ||
      this.realtime.has(address) ||
      this.serverOnly.has(address)
    ) {
      throw new Error(`duplicate server export address "${address}"`);
    }
    const existingAddress = this.addressByObject.get(value);
    if (existingAddress !== undefined) {
      const kind = isRegisteredFunction(value)
        ? "registered function"
        : isHttpHandlerShaped(value)
          ? "registered http handler"
        : isRegisteredChannel(value)
          ? "registered channel"
          : isRegisteredRealtime(value)
            ? "registered realtime"
          : "server-only value";
      throw new Error(`${kind} is exported at both "${existingAddress}" and "${address}"`);
    }
    this.addressByObject.set(value, address);
  }

  private mcpToolKey(mcp: string, tool: string): string {
    return `${mcp}\u0000${tool}`;
  }

  mcpAtPath(path: string): AnyMcpDeclaration | undefined {
    return this.mcpByPath.get(path);
  }

  /** The HTTP surface of one address, or undefined when the function is not exposed. */
  exposedFunction(address: string): ExposedFunction | undefined {
    return this.exposedByAddress.get(address);
  }

  /** The raw handler at one address, or undefined when none is registered. */
  httpHandler(address: string): AnyRegisteredHttpHandler | undefined {
    return this.httpHandlersByAddress.get(address);
  }

  toolsFor(
    mcp: McpEndpointDeclaration,
    principal: Principal,
  ): readonly AnyRegisteredMcpTool[] {
    return this.registeredToolsFor(mcp).filter((tool) =>
      isMcpToolAuthorized(tool.accessPolicy, principal)
    );
  }

  registeredToolsFor(mcp: McpEndpointDeclaration): readonly AnyRegisteredMcpTool[] {
    return this.toolsByMcp.get(mcp as AnyMcpDeclaration) ?? [];
  }

  mcpTool(mcp: string, tool: string): AnyRegisteredMcpTool | undefined {
    return this.mcpTools.get(this.mcpToolKey(mcp, tool));
  }

  /**
   * Every registered function is addressable, in-process and remotely alike:
   * its address begins with the group that decides where it answers, and
   * `access` alone decides who it answers.
   */
  get(address: string): AnyRegistered | undefined {
    return this.functions.get(address);
  }

  getChannel(address: string): AnyRegisteredChannel | undefined {
    return this.channels.get(address);
  }

  getRealtime(address: string): AnyRegisteredRealtime | undefined {
    return this.realtime.get(address);
  }

  kindOf(address: string): string | undefined {
    return this.functions.get(address)?.kind ??
      this.httpHandlersByAddress.get(address)?.kind ??
      this.channels.get(address)?.kind ??
      this.realtime.get(address)?.kind;
  }

  addressOf(value: object): string | undefined {
    return this.addressByObject.get(value);
  }

  /** Stable telemetry name for exported functions or endpoint-owned MCP tools. */
  invocationNameOf(value: object): string | undefined {
    return this.addressByObject.get(value) ?? (isRegisteredMcpTool(value)
      ? `${value.mcp.name}:${value.name}`
      : undefined);
  }

}
