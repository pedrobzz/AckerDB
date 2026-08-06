import { isResult, type Result } from "@ackerdb/core";
import type { ExternalAccount, Principal } from "../../auth/credentials.ts";
import { invokeFunction } from "../../app/invocation.ts";
import type { ProcedureCtx } from "../../app/functions.ts";
import type { Registry } from "../../app/registry.ts";
import { runInInvocationRoot } from "../invocation-state.ts";
import {
  finalizeMcpToolResult,
  type AnyRegisteredMcpTool,
} from "../../mcp/index.ts";
import {
  bindMcpAiContext,
  type McpAiContext,
  type McpAiRuntimeCapability,
} from "../../mcp/ai.ts";
import type { McpCallToolResult } from "../../mcp/content.ts";
import { isMcpToolAuthorized } from "../../mcp/tool-access.ts";
import { AckerDBError, throwIfAborted } from "../../shared/errors.ts";
import { claimHttpTrace } from "../../telemetry/external-trace.ts";
import {
  callerFairnessKey,
  transportSource,
} from "../caller.ts";
import type { RuntimeMcpToolRequest } from "../contracts/requests.ts";
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
  readonly registry: Registry;
  /** The application scope vocabulary; undefined when the app declares none. */
  readonly vocabulary?: readonly string[];
  readonly reads: RuntimeReadExecutor;
  readonly functions: RuntimeFunctionExecutor<RuntimeReactiveContext>;
  readonly operations: RuntimeOperationRunner<RuntimeSession>;
  readonly now: () => number;
  readonly operationSignal: (signal?: AbortSignal) => AbortSignal;
  readonly admittedRequestBytes: (request: unknown, receivedBytes?: number) => number;
  readonly publishAccountInvalidation: (account: ExternalAccount) => void;
}

/**
 * Owns MCP tool authorization, delegation capabilities, and dispatch into
 * ordinary AckerDB function execution. Endpoint authentication is not here:
 * MCP callers hold ordinary identity credentials, verified by the Runtime's
 * one credential authority.
 */
export class RuntimeMcp {
  constructor(private readonly options: RuntimeMcpOptions) {}

  /**
   * Resolve one callable tool without trusting discovery or revealing
   * inaccessible names. `localGrant` is an explicit same-process delegation
   * from `aiTools`; remote callers authorize on their own Identity grant.
   */
  authorizeTool(
    mcp: string,
    name: string,
    principal: Principal,
    localGrant?: readonly string[],
  ): RuntimeMcpToolAuthorization {
    const tool = this.options.registry.mcpTool(mcp, name);
    const local = localGrant !== undefined && localGrant.length > 0;
    if (
      tool !== undefined &&
      !(tool.private && !local) &&
      isMcpToolAuthorized(tool.accessPolicy, principal, localGrant)
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
    if (tool !== undefined) {
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

  private aiCapability(
    context: McpAiContext & Pick<ProcedureCtx, "timestamp">,
    fairnessKey: string,
    requestBytes: number,
  ): McpAiRuntimeCapability {
    return Object.freeze({
      vocabulary: this.options.vocabulary,
      toolsFor: (mcp) => this.options.registry.mcps.get(mcp.name) === mcp
        ? this.options.registry.registeredToolsFor(mcp)
        : undefined,
      execute: (mcp, tool, args, scopes, signal) => {
        const authorization = this.authorizeTool(
          mcp.name,
          tool.name,
          context.auth,
          scopes,
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
