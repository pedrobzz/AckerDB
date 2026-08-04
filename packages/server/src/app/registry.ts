/**
 * The function registry: maps dot-joined addresses ("messages.list") to
 * registered functions. Addresses derive from module paths + export names,
 * exactly mirroring what codegen puts on the generated `api` object.
 */
import { getRef } from "@ackerdb/core";
import type { Principal } from "../auth/credentials.ts";
import {
  httpExposure,
  isRegisteredFunction,
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
  isMcpAuthProvider,
  isMcpDeclaration,
  isRegisteredMcpTool,
  type AnyMcpAuthProvider,
  type AnyMcpDeclaration,
  type AnyRegisteredMcpTool,
  type McpEndpointDeclaration,
} from "../mcp/index.ts";
import { isMcpToolAuthorized } from "../mcp/scopes.ts";
import {
  ACKERDB_RESERVED_API_PREFIX,
  exposedHttpKind,
  isAckerDBHttpRoute,
  type ExposedHttpKind,
} from "../transport/http-surface.ts";
import {
  compileExposedHttpCodec,
  type ExposedHttpCodec,
} from "../transport/http-codec.ts";
import type { Schema, ScheduledHandler } from "../schema/definition.ts";

type ServerOnlyExport = AnyMcpDeclaration | AnyMcpAuthProvider;

interface ModuleExport {
  readonly address: string;
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

/** Address segments become path segments: "messages.list" -> "/api/messages/list". */
function httpPathForAddress(address: string): string {
  return `/api/${address.replaceAll(".", "/")}`;
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

  /** `modules` is keyed by dot path: functions/messages.ts -> "messages". */
  constructor(modules: Record<string, Record<string, unknown>>) {
    const moduleExports: ModuleExport[] = [];
    for (const [modulePath, exports] of Object.entries(modules).sort(([a], [b]) =>
      a.localeCompare(b))) {
      if (modulePath === "events" || modulePath.startsWith("events.")) {
        throw new Error(
          `function module "${modulePath}": the "events" namespace is reserved for event-table references`,
        );
      }
      for (const [exportName, value] of Object.entries(exports).sort(([a], [b]) =>
        a.localeCompare(b))) {
        moduleExports.push({ address: `${modulePath}.${exportName}`, value });
      }
    }

    for (const { address, value } of moduleExports) {
      if (!isRegisteredFunction(value)) continue;
      this.registerAddress(address, value);
      this.functions.set(address, value);
    }

    for (const { address, value } of moduleExports) {
      if (!isHttpHandlerShaped(value)) continue;
      // The registry serves the validated snapshot, never the exported object:
      // an accessor cannot answer one way at registration and another at
      // dispatch. Addresses still key off the exported identity.
      const registered = validateRegisteredHttpHandler(value, `http handler "${address}"`);
      this.registerAddress(address, value);
      this.httpHandlersByAddress.set(address, registered);
    }

    for (const { address, value } of moduleExports) {
      if (!isRegisteredChannel(value)) continue;
      this.registerAddress(address, value);
      this.channels.set(address, value);
    }

    for (const { address, value } of moduleExports) {
      if (!isRegisteredRealtime(value)) continue;
      this.registerAddress(address, value);
      this.realtime.set(address, value);
    }

    for (const { address, value } of moduleExports) {
      if (!isMcpDeclaration(value)) continue;
      this.registerAddress(address, value);
      const existing = this.mcps.get(value.name);
      if (existing !== undefined) {
        throw new Error(`duplicate MCP name "${value.name}"`);
      }
      // A private endpoint claims no path: it is reachable only through
      // `aiTools`, so it neither collides with an application module nor
      // leaves a route advertising a tool list no caller may read.
      if (value.path !== null) {
        if (isAckerDBHttpRoute(value.path)) {
          throw new Error(`MCP "${value.name}" path "${value.path}" collides with a AckerDB route`);
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
    // the reserved prefix and MCP collisions. A raw path can never collide
    // with an exposed one — both derive from addresses, and addresses are
    // unique by construction.
    for (const [address, fn] of this.httpHandlersByAddress) {
      const path = this.claimApplicationHttpPath(address, "http handler");
      this.httpRoutes.set(path, Object.freeze({ address, path, fn }));
    }

    for (const { address, value } of moduleExports) {
      if (!isMcpAuthProvider(value)) continue;
      this.serverOnly.set(address, value);
    }

    for (const { address, value } of moduleExports) {
      if (
        (typeof value === "object" || typeof value === "function") &&
        value !== null &&
        (value as { readonly isAckerDBServerOnly?: unknown }).isAckerDBServerOnly === true &&
        !this.serverOnly.has(address) &&
        !this.httpHandlersByAddress.has(address)
      ) {
        throw new Error(`unknown server-only export at "${address}"`);
      }
    }
  }

  /** One owner for the application-path invariants: the `_` reserve and MCP collisions. */
  private claimApplicationHttpPath(address: string, label: string): string {
    const path = httpPathForAddress(address);
    if (isAckerDBHttpRoute(path)) {
      throw new Error(
        `${label} "${address}" claims AckerDB-owned path "${path}"; "${ACKERDB_RESERVED_API_PREFIX}" is reserved`,
      );
    }
    const mcp = this.mcpByPath.get(path);
    if (mcp !== undefined) {
      throw new Error(`${label} "${address}" and MCP "${mcp.name}" both use path "${path}"`);
    }
    return path;
  }

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

  /*
   * The methods below retain the function registry's existing scheduling
   * contract; MCP tools are deliberately absent from it.
   */

  /** Resolve a .scheduled(...) handler (string | ref | registered fn) to an address. */
  resolveHandler(handler: ScheduledHandler, where: string): string {
    let address: string;
    if (typeof handler === "string") {
      address = handler;
    } else if (isRegisteredFunction(handler)) {
      const found = this.addressOf(handler);
      if (found === undefined) {
        throw new Error(`${where}: scheduled handler is not exported from any function module`);
      }
      address = found;
    } else {
      address = getRef(handler as never);
    }
    const kind = this.kindOf(address);
    if (kind === undefined) {
      throw new Error(`${where}: scheduled handler "${address}" does not exist`);
    }
    if (kind !== "mutation") {
      throw new Error(`${where}: scheduled handler "${address}" must be a mutation, got ${kind}`);
    }
    return address;
  }

  /** Validate every scheduled table's handler up front; returns table -> address. */
  resolveScheduled(schema: Schema): Map<string, string> {
    const resolved = new Map<string, string>();
    for (const [table, def] of Object.entries(schema.tables)) {
      if (def.scheduledHandler !== null) {
        resolved.set(table, this.resolveHandler(def.scheduledHandler, `table ${table}`));
      }
    }
    return resolved;
  }
}
