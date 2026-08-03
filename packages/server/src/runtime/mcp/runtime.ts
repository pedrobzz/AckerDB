import type { Database } from "bun:sqlite";
import { isResult, type Result } from "@ackerdb/core";
import {
  type ExternalAccount,
  type McpPrincipal,
  type Principal,
} from "../../auth/credentials.ts";
import { invokeFunction } from "../../app/invocation.ts";
import type { ProcedureCtx } from "../../app/functions.ts";
import type { Registry } from "../../app/registry.ts";
import { runInInvocationRoot } from "../invocation-state.ts";
import type { ReadRecorder, WriteCollector } from "../../database/access.ts";
import type { Engine } from "../../database/engine.ts";
import {
  finalizeMcpToolResult,
  type AnyMcpAuthProvider,
  type AnyRegisteredMcpTool,
} from "../../mcp/index.ts";
import {
  bindMcpAiContext,
  mcpLocalGrant,
  withMcpLocalAuthority,
  type McpAiContext,
  type McpAiRuntimeCapability,
} from "../../mcp/ai.ts";
import type { McpCallToolResult } from "../../mcp/content.ts";
import { parseMcpToken, type ParsedMcpToken } from "../../mcp/credential.ts";
import { isMcpToolAuthorized } from "../../mcp/scopes.ts";
import { withMcpTokenContext } from "../../mcp/token-context.ts";
import {
  McpTokenInvalidationBoundary,
  takeMcpTokenInvalidations,
} from "../../mcp/token-invalidation.ts";
import { mcpTokenVaultOwner } from "../../mcp/token-vault.ts";
import { AckerDBError, throwIfAborted } from "../../shared/errors.ts";
import { claimHttpTrace } from "../../telemetry/external-trace.ts";
import {
  callerFairnessKey,
  transportSource,
} from "../caller.ts";
import type {
  McpCredentialLease,
  RuntimeMcpToolRequest,
} from "../contracts/requests.ts";
import type { ServiceLimits } from "../limits.ts";
import { claimHttpRequestProvenance } from "../request-provenance.ts";
import {
  canceledHandlerOutcome,
  invokeSideEffectingHandler,
} from "../side-effecting-handler.ts";
import type { RuntimeReadExecutor } from "../execution/read.ts";
import {
  restoreMutationResult,
  type RuntimeFunctionExecutor,
} from "../execution/functions.ts";
import type { RuntimeOperationRunner } from "../execution/operation-runner.ts";
import type {
  RuntimeReactiveContext,
  RuntimeSession,
} from "../sessions/store.ts";
import {
  authorizedMcpTool,
  mcpToolAuthorization,
  mcpToolAuthorizationFailure,
  type RuntimeMcpToolAuthorization,
} from "./authorization.ts";

const DIRECT_RUNTIME_SOURCE = transportSource({ family: "runtime", address: "local" });

export interface RuntimeMcpOptions {
  readonly engine: Engine;
  readonly registry: Registry;
  readonly limits: ServiceLimits;
  readonly reads: RuntimeReadExecutor;
  readonly functions: RuntimeFunctionExecutor<RuntimeReactiveContext>;
  readonly operations: RuntimeOperationRunner<RuntimeSession>;
  readonly now: () => number;
  readonly assertReady: () => void;
  readonly operationSignal: (signal?: AbortSignal) => AbortSignal;
  readonly admittedRequestBytes: (request: unknown, receivedBytes?: number) => number;
  readonly publishAccountInvalidation: (account: ExternalAccount) => void;
}

/**
 * Owns MCP identity, token leases, authorization, delegation capabilities,
 * and dispatch into ordinary AckerDB function execution.
 */
export class RuntimeMcp {
  private readonly tokenInvalidation = new McpTokenInvalidationBoundary();

  constructor(private readonly options: RuntimeMcpOptions) {}

  async authenticateToken(
    mcp: string,
    rawToken: string,
    fairnessKey: string,
    signal?: AbortSignal,
  ): Promise<McpPrincipal> {
    const parsed = parseMcpToken(rawToken);
    if (parsed === null) {
      throw new AckerDBError("unauthenticated", "invalid MCP credential");
    }
    return this.verifyToken(
      mcp,
      parsed,
      fairnessKey,
      this.options.operationSignal(signal),
    );
  }

  async acquireTokenLease(
    mcp: string,
    parsed: ParsedMcpToken,
    fairnessKey: string,
    signal?: AbortSignal,
  ): Promise<McpCredentialLease> {
    this.options.assertReady();
    const controller = new AbortController();
    const unsubscribe = this.tokenInvalidation.subscribe(mcp, parsed.id, () => {
      if (!controller.signal.aborted) {
        controller.abort(new AckerDBError("unauthenticated", "credential revoked"));
      }
    });
    const leaseSignal = signal === undefined
      ? controller.signal
      : AbortSignal.any([signal, controller.signal]);
    const verificationSignal = this.options.operationSignal(leaseSignal);
    try {
      const principal = await this.verifyToken(
        mcp,
        parsed,
        fairnessKey,
        verificationSignal,
      );
      throwIfAborted(verificationSignal);
      let active = true;
      return Object.freeze({
        principal,
        signal: leaseSignal,
        release: () => {
          if (!active) return;
          active = false;
          unsubscribe();
        },
      });
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  authorizeTool(
    mcp: string,
    name: string,
    principal: Principal,
  ): RuntimeMcpToolAuthorization {
    const endpoint = this.options.registry.mcps.get(mcp);
    // A token belongs to its auth provider. Every endpoint sharing that exact
    // provider accepts the same credential; endpoint scopes decide the tool.
    const providerMatches = principal.kind !== "mcp" ||
      (endpoint !== undefined && principal.mcp === endpoint.auth.name);
    const tool = providerMatches
      ? this.options.registry.mcpTool(mcp, name)
      : undefined;
    const grant = tool === undefined
      ? undefined
      : mcpLocalGrant(principal, tool.mcp);
    const local = grant !== undefined && grant.length > 0;
    if (
      tool !== undefined &&
      !(tool.private && !local) &&
      isMcpToolAuthorized(tool.accessPolicy, principal, grant)
    ) {
      return mcpToolAuthorization(tool);
    }
    if (principal.kind === "anonymous") {
      return mcpToolAuthorizationFailure(
        new AckerDBError("unauthenticated", "authentication required"),
      );
    }
    if (tool !== undefined && tool.private && !local) {
      return mcpToolAuthorizationFailure(
        new AckerDBError("not_found", "MCP tool not found"),
      );
    }
    if (!providerMatches || tool !== undefined) {
      return mcpToolAuthorizationFailure(
        new AckerDBError("unauthorized", "access denied"),
      );
    }
    return mcpToolAuthorizationFailure(
      new AckerDBError("not_found", "MCP tool not found"),
    );
  }

  runTool(request: RuntimeMcpToolRequest): Promise<McpCallToolResult> {
    const provenance = claimHttpRequestProvenance(request);
    const tool = authorizedMcpTool(request.authorization);
    const requestBytes = this.options.admittedRequestBytes({
      jsonrpc: "2.0",
      id: request.id,
      method: "tools/call",
      params: { name: tool.name, arguments: request.args },
    }, provenance?.bytes);
    const functionName = `${tool.mcp.name}:${tool.name}`;
    const claimedTrace = claimHttpTrace(
      provenance?.trace,
      "procedure",
      functionName,
      String(request.id),
    );
    const fairnessKey = request.fairnessKey ?? callerFairnessKey(
      request.principal,
      DIRECT_RUNTIME_SOURCE,
    );
    return this.options.operations.run(
      null,
      "procedure",
      functionName,
      requestBytes,
      () => {
        const signal = this.options.operationSignal(request.signal);
        return this.dispatchTool(
          tool,
          request.args,
          this.options.functions.createMcpTransactionContext(
            request.principal,
            fairnessKey,
            signal,
            requestBytes,
            this.options.now(),
          ),
          fairnessKey,
          requestBytes,
        );
      },
      {
        identifiers: { requestId: String(request.id) },
        claimedTrace,
        fairnessKey,
      },
    );
  }

  bindTokenContext<T extends object, R>(
    context: T,
    principal: Principal,
    connection: Database,
    reads: ReadRecorder | null,
    writes: WriteCollector | null,
    work: (ctx: T) => R | Promise<R>,
  ): Promise<Awaited<R>> {
    return withMcpTokenContext(context, {
      engine: this.options.engine,
      connection,
      principal,
      reads,
      writes,
      limits: this.options.limits.mcp,
      now: this.options.now,
    }, work);
  }

  bindAiContext(
    context: McpAiContext & Pick<ProcedureCtx, "timestamp">,
    fairnessKey: string,
    requestBytes: number,
  ): () => void {
    return bindMcpAiContext(
      context,
      this.aiCapability(context, fairnessKey, requestBytes),
    );
  }

  publishCommittedInvalidations(writes: WriteCollector): void {
    for (const invalidation of takeMcpTokenInvalidations(writes)) {
      this.tokenInvalidation.publish(invalidation);
    }
  }

  private async verifyToken(
    mcp: string,
    parsed: ParsedMcpToken,
    fairnessKey: string,
    signal: AbortSignal,
  ): Promise<McpPrincipal> {
    this.options.assertReady();
    const provider = this.provider(mcp);
    const credential = await this.options.reads.submit(
      (connection) => this.options.engine[mcpTokenVaultOwner].authenticate(
        connection,
        mcp,
        parsed,
        provider.scopes,
      ),
      {
        operation: "procedure",
        bytes: parsed.bytes,
        fairnessKey,
        signal,
      },
      false,
    );
    throwIfAborted(signal);
    return Object.freeze({
      kind: "mcp",
      identity: credential.identity,
      mcp,
      tokenId: credential.tokenId,
      scopes: credential.scopes,
    });
  }

  private provider(name: string): AnyMcpAuthProvider {
    for (const endpoint of this.options.registry.mcps.values()) {
      if (endpoint.auth.name === name) return endpoint.auth;
    }
    throw new AckerDBError(
      "not_found",
      `unknown MCP auth provider "${name}"`,
    );
  }

  private aiCapability(
    context: McpAiContext & Pick<ProcedureCtx, "timestamp">,
    fairnessKey: string,
    requestBytes: number,
  ): McpAiRuntimeCapability {
    return Object.freeze({
      toolsFor: (mcp) => this.options.registry.mcps.get(mcp.name) === mcp
        ? this.options.registry.registeredToolsFor(mcp)
        : undefined,
      execute: (mcp, tool, args, scopes, signal) => withMcpLocalAuthority(
        context.auth,
        mcp,
        scopes,
        () => {
          const authorization = this.authorizeTool(
            mcp.name,
            tool.name,
            context.auth,
          );
          return this.dispatchTool(
            authorizedMcpTool(authorization),
            args,
            this.options.functions.createMcpTransactionContext(
              context.auth,
              fairnessKey,
              signal,
              requestBytes,
              context.timestamp,
            ),
            fairnessKey,
            requestBytes,
          );
        },
      ),
    } satisfies McpAiRuntimeCapability);
  }

  private async dispatchTool(
    tool: AnyRegisteredMcpTool,
    args: unknown,
    context: McpAiContext & Pick<ProcedureCtx, "timestamp">,
    fairnessKey: string,
    requestBytes: number,
  ): Promise<McpCallToolResult> {
    const toolContext = Object.freeze({
      auth: context.auth,
      abortSignal: context.abortSignal,
      timestamp: context.timestamp,
    });
    const release = this.bindAiContext(toolContext, fairnessKey, requestBytes);
    try {
      throwIfAborted(toolContext.abortSignal);
      const result = await runInInvocationRoot(
        toolContext.auth,
        () => this.executeTool(
          tool,
          tool.codec.decodeArgs(args),
          toolContext,
          fairnessKey,
          requestBytes,
        ),
      );
      const finalized = finalizeMcpToolResult(tool, result);
      if (toolContext.abortSignal.aborted) {
        throw canceledHandlerOutcome(
          toolContext.abortSignal,
          "MCP tool",
          toolContext.abortSignal.reason,
        );
      }
      return finalized;
    } finally {
      release();
    }
  }

  private async executeTool(
    tool: AnyRegisteredMcpTool,
    args: unknown,
    context: McpAiContext & Pick<ProcedureCtx, "timestamp">,
    fairnessKey: string,
    requestBytes: number,
  ): Promise<Result<unknown, unknown>> {
    const fn = tool.fn;
    const signal = this.options.operationSignal(context.abortSignal);
    throwIfAborted(signal);
    if (fn.kind === "query") {
      const value = await this.options.reads.execute(
        "query",
        fairnessKey,
        signal,
        requestBytes,
        null,
        (execution) => this.options.functions.invokeQuery(
          fn,
          args,
          context.auth,
          execution,
        ),
      );
      return this.expectResult(tool, value);
    }
    if (fn.kind === "mutation") {
      const committed = await this.options.functions.commitMutation({
        fairnessKey,
        requestBytes,
        admissionSignal: signal,
        fn,
        principal: context.auth,
        args,
      });
      return restoreMutationResult(committed.value);
    }
    const procedure = this.options.functions.createProcedureContext(
      context.auth,
      fairnessKey,
      signal,
      requestBytes,
      context.timestamp,
      this.options.publishAccountInvalidation,
    );
    try {
      const value = await invokeSideEffectingHandler(
        signal,
        "MCP tool",
        (onAuthorized) => invokeFunction(
          fn,
          procedure.value,
          args,
          { onAuthorized },
        ),
      );
      return this.expectResult(tool, value);
    } finally {
      procedure.release();
    }
  }

  private expectResult(
    tool: AnyRegisteredMcpTool,
    value: unknown,
  ): Result<unknown, unknown> {
    if (!isResult(value)) {
      throw new AckerDBError(
        "internal",
        `MCP tool "${tool.name}" boundary returned no Result`,
      );
    }
    return value;
  }
}
