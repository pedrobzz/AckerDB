/**
 * The function registry: maps dot-joined addresses ("messages.list") to
 * registered functions. Addresses derive from module paths + export names,
 * exactly mirroring what codegen puts on the generated `api` object.
 */
import { getRef } from "@dbzz/core";
import type { Principal } from "./auth.ts";
import {
  isRegisteredFunction,
  type AnyRegistered,
} from "./functions.ts";
import {
  isMcpDeclaration,
  isRegisteredMcpTool,
  type AnyMcpDeclaration,
  type AnyRegisteredMcpTool,
  type McpEndpointDeclaration,
} from "./mcp.ts";
import { isMcpToolAuthorized } from "./mcp-scopes.ts";
import { isDbzzHttpRoute } from "./http-routes.ts";
import type { Schema, ScheduledHandler } from "./schema.ts";

type ServerOnlyExport = AnyMcpDeclaration | AnyRegisteredMcpTool;

interface ModuleExport {
  readonly address: string;
  readonly value: unknown;
}

export class Registry {
  readonly functions = new Map<string, AnyRegistered>();
  readonly serverOnly = new Map<string, ServerOnlyExport>();
  readonly mcps = new Map<string, AnyMcpDeclaration>();
  readonly mcpTools = new Map<string, AnyRegisteredMcpTool>();
  private readonly mcpByPath = new Map<string, AnyMcpDeclaration>();
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
      if (!isMcpDeclaration(value)) continue;
      this.registerAddress(address, value);
      const existing = this.mcps.get(value.name);
      if (existing !== undefined) {
        throw new Error(`duplicate MCP name "${value.name}"`);
      }
      if (isDbzzHttpRoute(value.path)) {
        throw new Error(`MCP "${value.name}" path "${value.path}" collides with a DBZZ route`);
      }
      const pathOwner = this.mcpByPath.get(value.path);
      if (pathOwner !== undefined) {
        throw new Error(
          `MCP "${value.name}" and "${pathOwner.name}" both use path "${value.path}"`,
        );
      }
      this.mcps.set(value.name, value);
      this.mcpByPath.set(value.path, value);
      this.serverOnly.set(address, value);
    }

    for (const { address, value } of moduleExports) {
      if (!isRegisteredMcpTool(value)) continue;
      this.registerAddress(address, value);
      if (this.mcps.get(value.mcp.name) !== value.mcp) {
        throw new Error(
          `MCP tool "${value.name}" references MCP "${value.mcp.name}" which is not exported`,
        );
      }
      const key = this.mcpToolKey(value.mcp.name, value.name);
      if (this.mcpTools.has(key)) {
        throw new Error(`duplicate MCP tool name "${value.name}" in MCP "${value.mcp.name}"`);
      }
      this.mcpTools.set(key, value);
      this.serverOnly.set(address, value);
    }

    for (const { address, value } of moduleExports) {
      if (
        (typeof value === "object" || typeof value === "function") &&
        value !== null &&
        (value as { readonly isDbzzServerOnly?: unknown }).isDbzzServerOnly === true &&
        !this.serverOnly.has(address)
      ) {
        throw new Error(`unknown server-only export at "${address}"`);
      }
    }
  }

  private registerAddress(address: string, value: object): void {
    if (this.functions.has(address) || this.serverOnly.has(address)) {
      throw new Error(`duplicate server export address "${address}"`);
    }
    const existingAddress = this.addressByObject.get(value);
    if (existingAddress !== undefined) {
      const kind = isRegisteredFunction(value) ? "registered function" : "server-only value";
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

  toolsFor(
    mcp: McpEndpointDeclaration,
    principal: Principal,
  ): readonly AnyRegisteredMcpTool[] {
    return this.registeredToolsFor(mcp).filter((tool) =>
      isMcpToolAuthorized(tool.accessPolicy, principal)
    );
  }

  registeredToolsFor(mcp: McpEndpointDeclaration): readonly AnyRegisteredMcpTool[] {
    return [...this.mcpTools.values()].filter((tool) => tool.mcp === mcp);
  }

  mcpTool(mcp: string, tool: string): AnyRegisteredMcpTool | undefined {
    return this.mcpTools.get(this.mcpToolKey(mcp, tool));
  }

  get(address: string): AnyRegistered | undefined {
    return this.functions.get(address);
  }

  kindOf(address: string): string | undefined {
    return this.functions.get(address)?.kind;
  }

  addressOf(value: object): string | undefined {
    return this.addressByObject.get(value);
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
