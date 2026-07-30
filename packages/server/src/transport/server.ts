/** Production Protocol-2 HTTP, SSE, and WebSocket ownership for one Runtime. */
import type { Server, ServerWebSocket } from "bun";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  isRealtimeSessionId,
  parseCallRequest,
  parseSseAckRequest,
  stableEncode,
  type ErrorMessage,
  type SseAckRequest,
} from "@ackerdb/core";
import {
  ANONYMOUS_PRINCIPAL,
  credentialFromAuthorization,
  type ClientPrincipal,
  type Principal,
} from "../auth/credentials.ts";
import {
  acquireAuthLease,
  type AuthLease,
} from "../auth/lease.ts";
import {
  callerFairnessKey,
  transportSource,
  type TransportSource,
} from "../runtime/caller.ts";
import { OutboundBudget, WebSocketSessionSink } from "../subscriptions/delivery.ts";
import { AckerDBError } from "../shared/errors.ts";
import {
  beginHttpTrace,
  beginSessionAuthTrace,
  finishHttpTrace,
  identifyHttpTrace,
  observeHttpAuth,
  recordHttpTraceFailure,
} from "../telemetry/external-trace.ts";
import { defineServiceLimits, type ServiceLimits } from "../runtime/limits.ts";
import { ACKERDB_HTTP_ROUTES } from "./http-routes.ts";
import type { McpEndpointDeclaration } from "../mcp/index.ts";
import { mcpCredentialFromAuthorization } from "../mcp/credential.ts";
import {
  McpHttpBoundary,
  type McpHttpOptions,
} from "../mcp/http-boundary.ts";
import {
  mcpBoundaryRejected,
  mcpErrorResponse,
  mcpMethodNotAllowed,
  parseMcpJson,
  withMcpCors,
} from "../mcp/wire.ts";
import { outcomeFromError, outcomeHttpStatus } from "../runtime/outcome.ts";
import { carryHttpRequestProvenance } from "../runtime/request-provenance.ts";
import {
  CAPTURE_DELIVERY_OBSERVER,
  type McpCredentialLease,
  type Runtime,
  type RuntimeStatus,
} from "../runtime/runtime.ts";
import { Session, withSessionAuthObserver } from "../subscriptions/session.ts";
import { RealtimeHttpTransport } from "../realtime/http-transport.ts";

export type AckerDBServerState = "starting" | "ready" | "draining" | "stopped" | "failed";
export type AckerDBStartupPhase =
  | "listening"
  | "codegen"
  | "loading"
  | "opening-storage"
  | "migrating"
  | "reconciling"
  | "loading-runtime";

export interface AckerDBServerOptions {
  readonly limits: ServiceLimits;
  readonly port: number;
  readonly hostname?: string;
  readonly mcpHttp?: McpHttpOptions;
  /** Exact workload scope required by GET /status. */
  readonly statusScope?: string;
}

export interface ServeOptions {
  readonly runtime: Runtime;
  readonly port: number;
  readonly hostname?: string;
  readonly mcpHttp?: McpHttpOptions;
  /** Exact workload scope required by GET /status. */
  readonly statusScope?: string;
}

export type { McpHttpOptions } from "../mcp/http-boundary.ts";

export interface AckerDBServerStatus {
  readonly state: AckerDBServerState;
  readonly startupPhase: AckerDBStartupPhase | null;
  readonly connections: number;
  readonly preHelloConnections: number;
  readonly connectionRejections: number;
  readonly httpIngress: number;
  readonly httpFairnessKeys: number;
  readonly httpGlobalRejections: number;
  readonly httpFairShareRejections: number;
  readonly sseAckIngress: number;
  readonly sseAckNoops: number;
  readonly outboundBytes: number;
  readonly runtime: RuntimeStatus | null;
}

interface WsData {
  readonly source: TransportSource;
  socket: ServerWebSocket<WsData> | null;
  sink: WebSocketSessionSink | null;
  session: Session | null;
}

const DEFAULT_STATUS_SCOPE = "ackerdb:status";
const STATUS_SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

const CORS = Object.freeze({
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version",
  "access-control-expose-headers": "x-ackerdb-sse-stream, x-ackerdb-sse-max-stall-ms",
});

const SSE_HEADERS = Object.freeze({
  ...CORS,
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
});

const DRAIN_RETRY_AFTER_MS = 1_000;
const STARTUP_PHASE_ORDER: Readonly<Record<AckerDBStartupPhase, number>> = Object.freeze({
  listening: 0,
  codegen: 1,
  loading: 2,
  "opening-storage": 3,
  migrating: 4,
  reconciling: 5,
  "loading-runtime": 6,
});

function json(value: unknown, status = 200): Response {
  return new Response(encode(value), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
  });
}

function protocolError(error: unknown, id: number | null = null): Response {
  const outcome = outcomeFromError(error);
  const frame: ErrorMessage = { v: PROTOCOL_VERSION, t: "err", id, outcome };
  return json(frame, outcomeHttpStatus(outcome));
}

function unavailableWhile(state: AckerDBServerState): AckerDBError {
  if (state === "draining") {
    return new AckerDBError("draining", "server is draining", {
      retryable: true,
      retryAfterMs: DRAIN_RETRY_AFTER_MS,
      resource: "connection",
    });
  }
  return new AckerDBError("unavailable", "server is not ready", {
    retryable: true,
    resource: "connection",
  });
}

function requestTooLarge(): AckerDBError {
  return new AckerDBError("overloaded", "request exceeds maxRequestBytes", {
    resource: "operation",
  });
}

function cancel(reader: { cancel(reason?: unknown): Promise<void> }, reason: unknown): void {
  void reader.cancel(reason).catch(() => {
    // The owning failure is already represented by the transport outcome.
  });
}

interface LeaseStreamReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

/** Keep response-owned resources alive for exactly the lifetime of its body. */
function ownedStream(
  source: ReadableStream<Uint8Array>,
  release: () => void,
): ReadableStream<Uint8Array> {
  let reader: LeaseStreamReader;
  try {
    reader = source.getReader();
  } catch (error) {
    release();
    throw error;
  }
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    release();
    try {
      reader.releaseLock();
    } catch {
      // Cancellation/read settlement owns the pending source operation.
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(result.value!);
        }
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    cancel(reason) {
      try {
        return reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });
}

interface HttpAdmissionSnapshot {
  readonly active: number;
  readonly fairnessKeys: number;
  readonly globalRejections: number;
  readonly fairShareRejections: number;
}

interface HttpAdmissionLease {
  transfer(fairnessKey: string): void;
  release(): void;
}

/** One bounded HTTP slot whose fair-share owner changes after authentication. */
class HttpAdmission {
  private readonly callers = new Map<string, number>();
  private readonly drainWaiters = new Set<() => void>();
  private accepting = true;
  private active = 0;
  private globalRejections = 0;
  private fairShareRejections = 0;

  constructor(
    private readonly maxOperations: number,
    private readonly maxOperationsPerCaller: number,
  ) {}

  admit(fairnessKey: string): HttpAdmissionLease {
    if (!this.accepting) {
      throw new AckerDBError("draining", "HTTP ingress is draining", {
        retryable: true,
        retryAfterMs: DRAIN_RETRY_AFTER_MS,
        resource: "connection",
      });
    }
    if ((this.callers.get(fairnessKey) ?? 0) >= this.maxOperationsPerCaller) {
      this.fairShareRejections = Math.min(Number.MAX_SAFE_INTEGER, this.fairShareRejections + 1);
      throw new AckerDBError("overloaded", "HTTP source capacity is full", {
        retryable: true,
        retryAfterMs: 0,
        resource: "connection",
      });
    }
    if (this.active >= this.maxOperations) {
      this.globalRejections = Math.min(Number.MAX_SAFE_INTEGER, this.globalRejections + 1);
      throw new AckerDBError("overloaded", "HTTP ingress capacity is full", {
        retryable: true,
        retryAfterMs: 0,
        resource: "connection",
      });
    }

    this.active++;
    this.increment(fairnessKey);
    let currentKey = fairnessKey;
    let owned = true;
    return Object.freeze({
      transfer: (nextKey: string): void => {
        if (!owned || nextKey === currentKey) return;
        if ((this.callers.get(nextKey) ?? 0) >= this.maxOperationsPerCaller) {
          this.fairShareRejections = Math.min(Number.MAX_SAFE_INTEGER, this.fairShareRejections + 1);
          throw new AckerDBError("overloaded", "per-caller HTTP capacity is full", {
            retryable: true,
            retryAfterMs: 0,
            resource: "operation",
          });
        }
        this.decrement(currentKey);
        this.increment(nextKey);
        currentKey = nextKey;
      },
      release: (): void => {
        if (!owned) return;
        owned = false;
        this.active--;
        this.decrement(currentKey);
        if (this.active === 0) {
          for (const resolve of this.drainWaiters) resolve();
          this.drainWaiters.clear();
        }
      },
    });
  }

  closeAndDrain(): Promise<void> {
    this.accepting = false;
    if (this.active === 0) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.add(resolve));
  }

  snapshot(): HttpAdmissionSnapshot {
    return Object.freeze({
      active: this.active,
      fairnessKeys: this.callers.size,
      globalRejections: this.globalRejections,
      fairShareRejections: this.fairShareRejections,
    });
  }

  private increment(fairnessKey: string): void {
    this.callers.set(fairnessKey, (this.callers.get(fairnessKey) ?? 0) + 1);
  }

  private decrement(fairnessKey: string): void {
    const remaining = this.callers.get(fairnessKey)! - 1;
    if (remaining === 0) this.callers.delete(fairnessKey);
    else this.callers.set(fairnessKey, remaining);
  }
}

interface BoundedHttpBody {
  readonly text: string;
  readonly bytes: number;
}

interface ParsedHttpBody<T> {
  readonly value: T;
  readonly bytes: number;
}

/** Read no more than maxBytes of the raw HTTP body before any UTF-8 or wire decode. */
async function readBoundedBody(
  request: Request,
  maxBytes: number,
  maxAgeMs: number,
): Promise<BoundedHttpBody> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      throw new AckerDBError("malformed", "invalid Content-Length header");
    }
    if (Number(declared) > maxBytes) throw requestTooLarge();
  }
  if (request.body === null) throw new AckerDBError("malformed", "request body is required");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new AckerDBError("deadline_exceeded", "request body read deadline exceeded", {
        resource: "operation",
      }));
    }, maxAgeMs);
    timeout.unref?.();
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), expired]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw requestTooLarge();
      chunks.push(value);
    }
  } catch (error) {
    cancel(reader, error);
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }

  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { text: strictUtf8.decode(body), bytes };
  } catch (cause) {
    throw new AckerDBError("malformed", "request body is not valid UTF-8", { cause });
  }
}

async function parseHttpBody<T>(
  request: Request,
  maxBytes: number,
  maxAgeMs: number,
  parse: (value: unknown) => T,
): Promise<ParsedHttpBody<T>> {
  const body = await readBoundedBody(request, maxBytes, maxAgeMs);
  let decoded: unknown;
  try {
    decoded = decode(body.text);
  } catch (cause) {
    throw new AckerDBError("malformed", "malformed request body", { cause });
  }
  return { value: parse(decoded), bytes: body.bytes };
}

async function parseJsonHttpBody(
  request: Request,
  maxBytes: number,
  maxAgeMs: number,
): Promise<ParsedHttpBody<unknown>> {
  const body = await readBoundedBody(request, maxBytes, maxAgeMs);
  return { value: parseMcpJson(body.text), bytes: body.bytes };
}

function configuredStatusScope(value: string | undefined): string {
  const scope = value ?? DEFAULT_STATUS_SCOPE;
  if (typeof scope !== "string" || !STATUS_SCOPE_TOKEN.test(scope)) {
    throw new TypeError("statusScope must be one OAuth scope token of at most 128 characters");
  }
  return scope;
}

function oneByteTransportLimit(value: number, name: string): number {
  const limit = value + 1;
  if (!Number.isSafeInteger(limit)) {
    throw new RangeError(`${name} + 1 must be a safe integer for Bun transport limits`);
  }
  return limit;
}

function internalErrorResponse(cause: unknown): Response {
  return protocolError(new AckerDBError("internal", "internal server error", { cause }));
}

function requireStatusScope(principal: ClientPrincipal, required: string): void {
  if (principal.kind !== "workload") {
    throw new AckerDBError("unauthorized", "status requires a workload identity");
  }
  const claim = principal.claims.scope;
  if (typeof claim !== "string" || !claim.split(" ").includes(required)) {
    throw new AckerDBError("unauthorized", "status scope is required");
  }
}

function realtimeSessionId(path: string): string | null {
  const prefix = `${ACKERDB_HTTP_ROUTES.realtime}/`;
  if (!path.startsWith(prefix)) return null;
  const id = path.slice(prefix.length);
  return isRealtimeSessionId(id) ? id : null;
}

/** Owns listener admission, every WebSocket Session, and graceful Runtime drain. */
export class AckerDBServer {
  readonly limits: ServiceLimits;
  readonly hostname: string;
  readonly statusScope: string;

  private readonly connections = new Set<WsData>();
  private readonly outbound: OutboundBudget;
  private readonly httpAdmission: HttpAdmission;
  private readonly mcpHttp: McpHttpBoundary;
  private readonly realtimeHttp: RealtimeHttpTransport;
  private listener: Server<WsData> | null = null;
  private activeRuntime: Runtime | null = null;
  private lifecycle: AckerDBServerState = "starting";
  private startup: AckerDBStartupPhase | null = "listening";
  private connectionRejections = 0;
  private sseAckIngress = 0;
  private sseAckNoops = 0;
  private transportSampleTimer: ReturnType<typeof setInterval> | null = null;
  private drainPromise: Promise<void> | null = null;

  constructor(options: AckerDBServerOptions) {
    this.limits = defineServiceLimits(options.limits);
    this.hostname = options.hostname ?? "127.0.0.1";
    this.statusScope = configuredStatusScope(options.statusScope);
    this.mcpHttp = new McpHttpBoundary(this.hostname, options.mcpHttp);
    this.outbound = new OutboundBudget(
      this.limits.webSocket.maxBytes,
      this.limits.maxFrameBytes,
    );
    this.httpAdmission = new HttpAdmission(
      this.limits.maxOperations,
      this.limits.maxOperationsPerCaller,
    );
    this.realtimeHttp = new RealtimeHttpTransport({
      runtime: () => this.requireRuntime(),
      admit: (fairnessKey) => this.httpAdmission.admit(fairnessKey),
      authenticate: (request, signal) => this.authenticate(request, signal),
      parseBody: parseHttpBody,
      json,
      error: (error) => protocolError(error),
      cors: CORS,
    });

    try {
      this.listener = Bun.serve<WsData, never>({
        port: options.port,
        hostname: this.hostname,
        maxRequestBodySize: oneByteTransportLimit(
          this.limits.maxRequestBytes,
          "maxRequestBytes",
        ),
        development: false,
        error: (error) => internalErrorResponse(error),
        fetch: (request, listener) => this.fetch(request, listener),
        websocket: {
          open: (socket) => this.openWebSocket(socket),
          message: (socket, raw) => this.handleWebSocketMessage(socket, raw),
          drain: (socket) => socket.data.sink?.onDrain(),
          close: (socket) => this.closeWebSocket(socket),
          maxPayloadLength: oneByteTransportLimit(
            this.limits.maxFrameBytes,
            "maxFrameBytes",
          ),
          backpressureLimit: this.limits.webSocket.maxBytesPerConnection,
          closeOnBackpressureLimit: true,
          idleTimeout: 120,
        },
      });
    } catch (error) {
      this.lifecycle = "failed";
      throw error;
    }
  }

  get state(): AckerDBServerState {
    return this.lifecycle;
  }

  get startupPhase(): AckerDBStartupPhase | null {
    return this.startup;
  }

  get runtime(): Runtime | null {
    return this.activeRuntime;
  }

  get port(): number {
    const port = this.listener?.port;
    if (typeof port !== "number") throw new Error("server has no TCP port");
    return port;
  }

  status(): AckerDBServerStatus {
    const http = this.httpAdmission.snapshot();
    return Object.freeze({
      state: this.lifecycle,
      startupPhase: this.startup,
      connections: this.connections.size,
      preHelloConnections: this.preHelloConnections(),
      connectionRejections: this.connectionRejections,
      httpIngress: http.active,
      httpFairnessKeys: http.fairnessKeys,
      httpGlobalRejections: http.globalRejections,
      httpFairShareRejections: http.fairShareRejections,
      sseAckIngress: this.sseAckIngress,
      sseAckNoops: this.sseAckNoops,
      outboundBytes: this.outbound.snapshot().bytes,
      runtime: this.activeRuntime?.status() ?? null,
    });
  }

  /** Publish one monotonic, non-sensitive startup phase while the listener owns its port. */
  advanceStartup(phase: Exclude<AckerDBStartupPhase, "listening">): void {
    if (this.lifecycle !== "starting" || this.startup === null) {
      throw new Error("server is not starting");
    }
    if (STARTUP_PHASE_ORDER[phase] <= STARTUP_PHASE_ORDER[this.startup]) {
      throw new Error("startup phases must advance monotonically");
    }
    this.startup = phase;
  }

  /** Atomically attach the fully constructed Runtime and admit application traffic. */
  activate(runtime: Runtime): void {
    if (this.lifecycle !== "starting" || this.activeRuntime !== null) {
      throw new Error("server can only be activated once while starting");
    }
    if (runtime.state !== "ready") throw new Error("Runtime must be ready before activation");
    if (stableEncode(runtime.limits) !== stableEncode(this.limits)) {
      throw new Error("Runtime limits must match listener limits");
    }
    try {
      this.mcpHttp.assertCanServe(runtime.registry.mcps.size > 0);
    } catch (error) {
      this.startup = null;
      this.lifecycle = "stopped";
      void this.listener?.stop(true).catch(() => {});
      throw error;
    }
    this.activeRuntime = runtime;
    this.startup = null;
    this.lifecycle = "ready";
    this.startTransportSampler();
  }

  drain(): Promise<void> {
    if (this.drainPromise !== null) return this.drainPromise;
    if (this.lifecycle === "stopped") return Promise.resolve();
    if (this.lifecycle === "failed") {
      return Promise.reject(new AckerDBError("unavailable", "server has failed", { resource: "connection" }));
    }

    // Readiness and every admission path observe this before the first await.
    this.lifecycle = "draining";
    this.stopTransportSampler();
    this.drainPromise = this.performDrain();
    return this.drainPromise;
  }

  private async fetch(request: Request, listener: Server<WsData>): Promise<Response | undefined> {
    const url = new URL(request.url);

    if (url.pathname === ACKERDB_HTTP_ROUTES.live && request.method === "GET") {
      const live = this.lifecycle !== "failed" && this.lifecycle !== "stopped";
      return json({ version: 1, live }, live ? 200 : 503);
    }
    if (url.pathname === ACKERDB_HTTP_ROUTES.ready && request.method === "GET") {
      const runtimeState = this.activeRuntime?.status().state;
      const ready = this.lifecycle === "ready" && runtimeState === "ready";
      const state = this.lifecycle === "ready" && runtimeState !== "ready"
        ? runtimeState ?? "starting"
        : this.lifecycle;
      return json({
        version: 1,
        ready,
        state,
        ...(this.startup === null ? {} : { phase: this.startup }),
      }, ready ? 200 : 503);
    }
    const mcp = this.activeRuntime?.registry.mcpAtPath(url.pathname);
    if (mcp !== undefined) {
      const boundary = this.mcpHttp.inspect(
        request,
        this.port,
        this.limits.mcp.maxHeaderBytes,
      );
      if (boundary.rejectionStatus !== undefined) {
        return mcpBoundaryRejected(boundary.rejectionStatus, boundary.cors);
      }
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: boundary.cors });
      }
      if (request.method !== "POST") return mcpMethodNotAllowed(boundary.cors);
      return this.mcp(
        request,
        mcp,
        this.requestSource(request, listener),
        boundary.cors,
      );
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === ACKERDB_HTTP_ROUTES.sseAck) {
      if (request.method !== "POST") {
        return new Response("method not allowed", {
          status: 405,
          headers: { ...CORS, allow: "POST" },
        });
      }
      const source = this.requestSource(request, listener);
      return this.acknowledgeSse(request, callerFairnessKey(ANONYMOUS_PRINCIPAL, source));
    }
    if (this.lifecycle !== "ready" || this.activeRuntime?.state !== "ready") {
      return protocolError(unavailableWhile(this.lifecycle));
    }
    if (url.pathname === ACKERDB_HTTP_ROUTES.status && request.method === "GET") {
      let admission: HttpAdmissionLease | undefined;
      let lease: AuthLease | undefined;
      try {
        const source = this.requestSource(request, listener);
        admission = this.httpAdmission.admit(callerFairnessKey(ANONYMOUS_PRINCIPAL, source));
        lease = await this.authenticate(request);
        admission.transfer(callerFairnessKey(lease.principal, source));
        requireStatusScope(lease.principal, this.statusScope);
        return json({ version: 1, ...this.status() });
      } catch (error) {
        return protocolError(error);
      } finally {
        lease?.release();
        admission?.release();
      }
    }
    if (url.pathname === ACKERDB_HTTP_ROUTES.websocket) {
      return this.upgradeWebSocket(request, listener);
    }
    if (url.pathname === ACKERDB_HTTP_ROUTES.call && request.method === "POST") {
      return this.call(request, false, this.requestSource(request, listener));
    }
    if (url.pathname === ACKERDB_HTTP_ROUTES.sse && request.method === "POST") {
      return this.call(request, true, this.requestSource(request, listener));
    }
    if (
      url.pathname === ACKERDB_HTTP_ROUTES.realtimeConfig &&
      request.method === "GET"
    ) {
      return this.realtimeHttp.configuration(
        request,
        this.requestSource(request, listener),
      );
    }
    if (
      url.pathname === ACKERDB_HTTP_ROUTES.realtime &&
      request.method === "POST"
    ) {
      return this.realtimeHttp.offer(
        request,
        this.requestSource(request, listener),
      );
    }
    const realtimeId = realtimeSessionId(url.pathname);
    if (
      realtimeId !== null &&
      (request.method === "PATCH" || request.method === "DELETE")
    ) {
      return this.realtimeHttp.session(
        request,
        realtimeId,
        this.requestSource(request, listener),
      );
    }
    if (
      url.pathname === ACKERDB_HTTP_ROUTES.live ||
      url.pathname === ACKERDB_HTTP_ROUTES.ready ||
      url.pathname === ACKERDB_HTTP_ROUTES.status ||
      url.pathname === ACKERDB_HTTP_ROUTES.call ||
      url.pathname === ACKERDB_HTTP_ROUTES.sse ||
      url.pathname === ACKERDB_HTTP_ROUTES.realtime ||
      url.pathname === ACKERDB_HTTP_ROUTES.realtimeConfig ||
      url.pathname.startsWith(`${ACKERDB_HTTP_ROUTES.realtime}/`)
    ) {
      const allow = url.pathname === ACKERDB_HTTP_ROUTES.realtimeConfig
        ? "GET"
        : realtimeId === null
        ? "POST"
        : "PATCH, DELETE";
      return new Response("method not allowed", {
        status: realtimeId === null &&
            url.pathname.startsWith(`${ACKERDB_HTTP_ROUTES.realtime}/`) &&
            url.pathname !== ACKERDB_HTTP_ROUTES.realtimeConfig
          ? 404
          : 405,
        headers: { ...CORS, allow },
      });
    }
    return new Response("not found", { status: 404, headers: CORS });
  }

  private async authenticate(
    request: Request,
    signal: AbortSignal | undefined = request.signal,
  ): Promise<AuthLease> {
    const credential = credentialFromAuthorization(request.headers.get("authorization"));
    const runtime = this.requireRuntime();
    return acquireAuthLease({
      credential,
      verifier: runtime.credentialVerifier,
      resolveIdentity: (account, signal) => runtime.resolveIdentity(account, signal),
      ...(signal === undefined ? {} : { signal }),
      revocationDeadlineMs: runtime.limits.auth.revocationDeadlineMs,
    });
  }

  private requestSource(request: Request, listener: Server<WsData>): TransportSource {
    return transportSource(listener.requestIP(request));
  }

  private async call(request: Request, sse: boolean, source: TransportSource): Promise<Response> {
    const runtime = this.requireRuntime();
    const externalTrace = beginHttpTrace(runtime.telemetry, sse ? "sse" : "procedure");
    let id: number | null = null;
    let admission: HttpAdmissionLease | undefined;
    let lease: AuthLease | undefined;
    try {
      if (this.lifecycle !== "ready") throw unavailableWhile(this.lifecycle);
      admission = this.httpAdmission.admit(callerFairnessKey(ANONYMOUS_PRINCIPAL, source));
      const { value: call, bytes } = await parseHttpBody(
        request,
        runtime.limits.maxRequestBytes,
        runtime.limits.readQueue.maxAgeMs,
        parseCallRequest,
      );
      id = call.id;
      identifyHttpTrace(externalTrace, call.ref, String(call.id));
      lease = externalTrace === undefined
        ? await this.authenticate(request)
        : await observeHttpAuth(externalTrace, () => this.authenticate(request));
      const fairnessKey = callerFairnessKey(lease.principal, source);
      admission.transfer(fairnessKey);
      const input = carryHttpRequestProvenance({
        id: call.id,
        address: call.ref,
        args: call.args,
        principal: lease.principal,
        signal: lease.signal,
        fairnessKey,
      }, bytes, externalTrace, lease.invalidationScope);
      if (sse) {
        const { stream, streamId } = await runtime.runSse(input);
        const streamLease = lease;
        lease = undefined;
        const body = ownedStream(stream, () => streamLease.release());
        try {
          return new Response(body, {
            headers: {
              ...SSE_HEADERS,
              "x-ackerdb-sse-stream": streamId,
              "x-ackerdb-sse-max-stall-ms": String(runtime.limits.sse.maxStallMs),
            },
          });
        } catch (error) {
          cancel(body, error);
          throw error;
        }
      }
      return await runtime.runProcedure({
        ...input,
        respond: ({ body, status }) => new Response(body, {
          status,
          headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
        }),
      });
    } catch (error) {
      recordHttpTraceFailure(externalTrace, error);
      return protocolError(error, id);
    } finally {
      finishHttpTrace(externalTrace);
      lease?.release();
      admission?.release();
    }
  }

  private async mcp(
    request: Request,
    mcp: McpEndpointDeclaration,
    source: TransportSource,
    cors: Readonly<Record<string, string>>,
  ): Promise<Response> {
    const runtime = this.requireRuntime();
    let admission: HttpAdmissionLease | undefined;
    let credentialLease: McpCredentialLease | undefined;
    let principal: Principal = ANONYMOUS_PRINCIPAL;
    try {
      if (this.lifecycle !== "ready" || runtime.state !== "ready") {
        throw unavailableWhile(this.lifecycle);
      }
      admission = this.httpAdmission.admit(callerFairnessKey(ANONYMOUS_PRINCIPAL, source));
      const { value, bytes } = await parseJsonHttpBody(
        request,
        runtime.limits.maxRequestBytes,
        runtime.limits.readQueue.maxAgeMs,
      );
      const credential = mcpCredentialFromAuthorization(request.headers.get("authorization"));
      if (credential !== null) {
        credentialLease = await runtime.acquireMcpTokenLease(
          mcp.name,
          credential,
          callerFairnessKey(ANONYMOUS_PRINCIPAL, source),
          request.signal,
        );
        principal = credentialLease.principal;
      }
      const fairnessKey = callerFairnessKey(principal, source);
      admission.transfer(fairnessKey);
      const { handleMcpPost } = await import("../mcp/http.ts");
      return withMcpCors(await handleMcpPost({
        request,
        body: value,
        bytes,
        mcp,
        runtime,
        principal,
        signal: credentialLease?.signal ?? request.signal,
        fairnessKey,
      }), cors);
    } catch (error) {
      return mcpErrorResponse(error, cors, {
        realm: mcp.name,
        credentialPresented: request.headers.has("authorization"),
      });
    } finally {
      credentialLease?.release();
      admission?.release();
    }
  }

  private async acknowledgeSse(request: Request, sourceKey: string): Promise<Response> {
    this.sseAckIngress = Math.min(Number.MAX_SAFE_INTEGER, this.sseAckIngress + 1);
    let admission: HttpAdmissionLease | undefined;
    try {
      admission = this.httpAdmission.admit(sourceKey);
      const { value: acknowledgment } = await parseHttpBody<SseAckRequest>(
        request,
        this.limits.maxRequestBytes,
        this.limits.readQueue.maxAgeMs,
        parseSseAckRequest,
      );
      if (!(this.activeRuntime?.ackSse(acknowledgment) ?? false)) {
        this.sseAckNoops = Math.min(Number.MAX_SAFE_INTEGER, this.sseAckNoops + 1);
      }
      return new Response(null, { status: 204, headers: CORS });
    } catch (error) {
      return protocolError(error);
    } finally {
      admission?.release();
    }
  }

  private upgradeWebSocket(request: Request, listener: Server<WsData>): Response | undefined {
    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405, headers: { ...CORS, allow: "GET" } });
    }
    if (this.lifecycle !== "ready") return protocolError(unavailableWhile(this.lifecycle));
    if (this.connections.size >= this.limits.maxConnections) {
      this.connectionRejections = Math.min(Number.MAX_SAFE_INTEGER, this.connectionRejections + 1);
      return protocolError(new AckerDBError("overloaded", "connection capacity is full", {
        retryable: true,
        retryAfterMs: 0,
        resource: "connection",
      }));
    }

    const data: WsData = {
      source: this.requestSource(request, listener),
      socket: null,
      sink: null,
      session: null,
    };
    // Reserve the transport slot before upgrade/open/hello can perform any work.
    this.connections.add(data);
    try {
      if (listener.upgrade(request, { data })) return undefined;
    } catch (error) {
      this.connections.delete(data);
      return protocolError(error);
    }
    this.connections.delete(data);
    return new Response("websocket upgrade required", { status: 400, headers: CORS });
  }

  private openWebSocket(socket: ServerWebSocket<WsData>): void {
    const data = socket.data;
    data.socket = socket;
    try {
      const runtime = this.requireRuntime();
      data.sink = new WebSocketSessionSink({
        socket,
        budget: this.outbound,
        limits: runtime.limits,
        ...(runtime.telemetry.enabled
          ? {
              captureObserver: (lane) => runtime[CAPTURE_DELIVERY_OBSERVER](
                lane,
                data.session?.currentClientSessionId ?? undefined,
              ),
            }
          : {}),
      });
      data.session = new Session(withSessionAuthObserver({
        runtime,
        sink: data.sink,
        source: data.source,
        revocationDeadlineMs: runtime.limits.auth.revocationDeadlineMs,
        limits: runtime.limits,
      }, runtime.telemetry.enabled
        ? (input) => beginSessionAuthTrace(runtime.telemetry, input)
        : undefined));
      if (this.lifecycle !== "ready") void data.session.close(unavailableWhile(this.lifecycle));
    } catch (error) {
      this.connections.delete(data);
      socket.close(1013, outcomeFromError(error).code);
    }
  }

  private handleWebSocketMessage(
    socket: ServerWebSocket<WsData>,
    raw: string | Buffer,
  ): void {
    const session = socket.data.session;
    if (session === null) {
      socket.terminate();
      return;
    }
    void session.handle(raw).catch(() => {});
  }

  private closeWebSocket(socket: ServerWebSocket<WsData>): void {
    const { data } = socket;
    this.connections.delete(data);
    void data.session?.close(new AckerDBError("unavailable", "WebSocket disconnected", {
      resource: "connection",
    }));
  }

  private preHelloConnections(): number {
    return Math.max(0, this.connections.size - (this.activeRuntime?.connectionCount ?? 0));
  }

  private startTransportSampler(): void {
    const runtime = this.requireRuntime();
    if (!runtime.telemetry.enabled) return;
    this.sampleTransport();
    this.transportSampleTimer = setInterval(
      () => this.sampleTransport(),
      runtime.telemetry.sampleIntervalMs,
    );
    this.transportSampleTimer.unref?.();
  }

  private stopTransportSampler(): void {
    if (this.transportSampleTimer === null) return;
    clearInterval(this.transportSampleTimer);
    this.transportSampleTimer = null;
  }

  private sampleTransport(): void {
    const runtime = this.activeRuntime;
    if (runtime === null || !runtime.telemetry.enabled || this.lifecycle !== "ready") return;
    if (runtime.state !== "ready") {
      this.stopTransportSampler();
      return;
    }
    const http = this.httpAdmission.snapshot();
    const metrics = [
      ["runtime.transport_websocket_connections", this.connections.size, "gauge"],
      ["runtime.transport_websocket_pre_hello", this.preHelloConnections(), "gauge"],
      ["runtime.transport_websocket_rejections", this.connectionRejections, "count"],
      ["runtime.transport_websocket_outbound_bytes", this.outbound.snapshot().bytes, "bytes"],
      ["runtime.transport_http_ingress", http.active, "gauge"],
      ["runtime.transport_http_fairness_keys", http.fairnessKeys, "gauge"],
      ["runtime.transport_http_global_rejections", http.globalRejections, "count"],
      ["runtime.transport_http_fair_share_rejections", http.fairShareRejections, "count"],
      ["runtime.transport_sse_ack_ingress", this.sseAckIngress, "count"],
      ["runtime.transport_sse_ack_noops", this.sseAckNoops, "count"],
    ] as const;
    for (const [name, value, unit] of metrics) {
      runtime.telemetry.recordMetric({ name, value, unit });
    }
  }

  private requireRuntime(): Runtime {
    const runtime = this.activeRuntime;
    if (runtime === null) throw unavailableWhile(this.lifecycle);
    return runtime;
  }

  private async performDrain(): Promise<void> {
    const listener = this.listener!;
    const runtime = this.activeRuntime;
    const deadlineAtMs = Date.now() + this.limits.gracefulShutdownMs;
    const reason = new AckerDBError("draining", "server is draining", {
      retryable: true,
      retryAfterMs: DRAIN_RETRY_AFTER_MS,
      resource: "connection",
    });
    const sessions = [...this.connections].map((connection) => {
      if (connection.session !== null) return connection.session.close(reason);
      connection.socket?.close(1013, "draining");
      return Promise.resolve();
    });
    const runtimeDrain = runtime?.drain(deadlineAtMs) ?? Promise.resolve();
    const graceful = Promise.all([runtimeDrain, ...sessions])
      // Receiver credit remains admissible while Runtime closes SSE. Once
      // application ownership settles, close ingress and own every accepted
      // response handoff before stopping the listener.
      .then(() => this.httpAdmission.closeAndDrain())
      .then(async () => {
        // Bun leaves the awaited force-stop pending on active keep-alive/SSE
        // transports unless listener admission is closed first. Both calls stay
        // after application drain so /live remains reachable throughout it.
        void listener.stop(false).catch(() => {});
        await listener.stop(true);
      });

    const deadlineError = new AckerDBError("deadline_exceeded", "graceful shutdown deadline exceeded", {
      resource: "connection",
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        void runtimeDrain.then(
          () => reject(deadlineError),
          reject,
        );
      }, Math.max(0, deadlineAtMs - Date.now()));
      timeout.unref?.();
    });

    try {
      await Promise.race([graceful, deadline]);
      if (timeout !== undefined) clearTimeout(timeout);
      this.lifecycle = "stopped";
    } catch (error) {
      if (timeout !== undefined) clearTimeout(timeout);
      this.lifecycle = "failed";
      void this.httpAdmission.closeAndDrain();
      for (const connection of this.connections) connection.socket?.terminate();
      // Initiate the force close but do not await Bun's listener promise: Bun
      // keeps that promise pending for a handler that ignores cancellation,
      // which would defeat the finite shutdown deadline this boundary owns.
      void listener.stop(true).catch(() => {});
      throw error;
    }
  }
}

export function serve(options: ServeOptions): AckerDBServer {
  if (options.runtime.state !== "ready") {
    throw new Error("Runtime must be ready before serving");
  }
  const server = new AckerDBServer({
    limits: options.runtime.limits,
    port: options.port,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    ...(options.mcpHttp === undefined ? {} : { mcpHttp: options.mcpHttp }),
    ...(options.statusScope === undefined ? {} : { statusScope: options.statusScope }),
  });
  server.activate(options.runtime);
  return server;
}
