/**
 * The MCP auth provider: the scope vocabulary, and the tokens that carry it.
 *
 * Scopes live here rather than on an endpoint because an endpoint imports its
 * tools and a tool must name a scope. That is a cycle, and it is the reason a
 * mis-typed scope name could only ever be a runtime error. A leaf module both
 * sides import breaks it, and breaking it is what makes an undeclared scope a
 * compile error.
 *
 * A token is bound to the provider, not to one endpoint: two endpoints sharing
 * a provider accept the same credentials, and scopes are the only thing
 * separating them. An endpoint with materially different authority takes its
 * own provider.
 */
import type { RegisteredServerOnly } from "@ackerdb/core";
import { brand, hasBrand } from "../shared/identity.ts";
import { mcpName } from "./naming.ts";
import {
  createMcpScopeDescriptor,
  type McpScopeDescriptor,
  type McpScopeValues,
} from "./scopes.ts";
import {
  createMcpTokenOperations,
  createSystemMcpTokenOperations,
  type McpTokenOperations,
  type SystemMcpTokenOperations,
} from "./token-context.ts";
import type { Schema } from "../schema/definition.ts";

const MCP_AUTH_IDENTITY = Symbol.for("@ackerdb/server/McpAuth/v1");

export interface McpAuthConfig<Name extends string> {
  readonly name: Name;
  readonly scopes?: undefined;
}

export interface ScopedMcpAuthConfig<Name extends string, Scopes extends McpScopeValues> {
  readonly name: Name;
  readonly scopes: Scopes;
}

/**
 * The declared provider. `scopes` is the descriptor every runtime check reads;
 * it is absent when the provider declares none, which is what makes a scoped
 * `access` on a tool entry unrepresentable against an unscoped provider.
 */
export type McpAuthProvider<
  Name extends string = string,
  S extends Schema = Schema,
  Scope extends string = never,
> = RegisteredServerOnly & {
  readonly serverKind: "mcp-auth";
  readonly name: Name;
  readonly tokens: McpTokenOperations<S, Scope>;
  readonly systemTokens: SystemMcpTokenOperations<S, Scope>;
} & ([Scope] extends [never] ? object : { readonly scopes: McpScopeDescriptor<Scope> });

/** Runtime-facing provider shape with schema and exact scope union deliberately erased. */
export type AnyMcpAuthProvider = RegisteredServerOnly & {
  readonly serverKind: "mcp-auth";
  readonly name: string;
  readonly scopes?: McpScopeDescriptor<string>;
};

/** The scope union a provider declares, or `never` when it declares none. */
export type McpAuthScope<Provider> = Provider extends { readonly scopes: McpScopeDescriptor<infer Scope> }
  ? Scope
  : never;

export interface McpAuthBuilder<S extends Schema> {
  <const Name extends string>(config: McpAuthConfig<Name>): McpAuthProvider<Name, S, never>;
  <const Name extends string, const Scopes extends McpScopeValues>(
    config: ScopedMcpAuthConfig<Name, Scopes>,
  ): McpAuthProvider<Name, S, Scopes[number]>;
}

export function mcpAuth<const Name extends string>(
  config: McpAuthConfig<Name>,
): McpAuthProvider<Name, Schema, never>;
export function mcpAuth<const Name extends string, const Scopes extends McpScopeValues>(
  config: ScopedMcpAuthConfig<Name, Scopes>,
): McpAuthProvider<Name, Schema, Scopes[number]>;
export function mcpAuth(
  config: McpAuthConfig<string> | ScopedMcpAuthConfig<string, McpScopeValues>,
): AnyMcpAuthProvider {
  if (config === null || typeof config !== "object") {
    throw new TypeError("mcpAuth config is required");
  }
  for (const key of Object.keys(config).sort()) {
    if (key !== "name" && key !== "scopes") {
      throw new TypeError(`unknown MCP auth config field "${key}"`);
    }
  }
  const name = mcpName(config.name, "MCP auth name");
  const scopes = createMcpScopeDescriptor(name, config.scopes);
  const value = {
    isAckerDBServerOnly: true as const,
    serverKind: "mcp-auth" as const,
    name,
    ...(scopes === undefined ? {} : { scopes }),
    tokens: createMcpTokenOperations(name, scopes),
    systemTokens: createSystemMcpTokenOperations(name, scopes),
  };
  brand(value, MCP_AUTH_IDENTITY);
  return Object.freeze(value) as unknown as AnyMcpAuthProvider;
}

export function isMcpAuthProvider(value: unknown): value is AnyMcpAuthProvider {
  return hasBrand(value, MCP_AUTH_IDENTITY);
}
