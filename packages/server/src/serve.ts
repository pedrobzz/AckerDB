/** Production Protocol-2 HTTP, SSE, and WebSocket ownership for one Runtime. */
import { createHash } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  parseCallRequest,
  type CallRequest,
  type ErrorMessage,
} from "@dbzz/core";
import {
  credentialFromAuthorization,
  type ClientPrincipal,
  type CredentialVerifier,
} from "./auth.ts";
import {
  acquireAuthLease,
  validateCredentialVerifierRevocation,
  type AuthLease,
} from "./auth-lease.ts";
import { OutboundBudget, WebSocketSessionSink } from "./delivery.ts";
import { DbzzError } from "./errors.ts";
import {
  beginHttpTrace,
  beginSessionAuthTrace,
  carryHttpTrace,
  finishHttpTrace,
  identifyHttpTrace,
  observeHttpAuth,
  recordHttpTraceFailure,
} from "./external-trace.ts";
import { outcomeFromError, outcomeHttpStatus } from "./outcome.ts";
import type { Runtime, RuntimeStatus } from "./runtime.ts";
import { Session, withSessionAuthObserver } from "./session.ts";

export type DbzzServerState = "starting" | "ready" | "draining" | "stopped" | "failed";

export interface ServeOptions {
  readonly runtime: Runtime;
  readonly port: number;
  readonly hostname?: string;
  readonly verifier?: CredentialVerifier;
  /** Exact workload scope required by GET /status. */
  readonly statusScope?: string;
}

export interface DbzzServerStatus {
  readonly state: DbzzServerState;
  readonly connections: number;
  readonly preHelloConnections: number;
  readonly connectionRejections: number;
  readonly httpIngress: number;
  readonly httpFairnessKeys: number;
  readonly httpGlobalRejections: number;
  readonly httpFairShareRejections: number;
  readonly outboundBytes: number;
  readonly runtime: RuntimeStatus;
}

interface WsData {
  socket: ServerWebSocket<WsData> | null;
  sink: WebSocketSessionSink | null;
  session: Session | null;
}

const DEFAULT_STATUS_SCOPE = "dbzz:status";
const STATUS_SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

const CORS = Object.freeze({
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
});

const SSE_HEADERS = Object.freeze({
  ...CORS,
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  "x-vercel-ai-ui-message-stream": "v1",
  "x-accel-buffering": "no",
});

const DRAIN_RETRY_AFTER_MS = 1_000;

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

function unavailableWhile(state: DbzzServerState): DbzzError {
  if (state === "draining") {
    return new DbzzError("draining", "server is draining", {
      retryable: true,
      retryAfterMs: DRAIN_RETRY_AFTER_MS,
      resource: "connection",
    });
  }
  return new DbzzError("unavailable", "server is not ready", {
    retryable: true,
    resource: "connection",
  });
}

function requestTooLarge(): DbzzError {
  return new DbzzError("overloaded", "request exceeds maxRequestBytes", {
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
  private active = 0;
  private globalRejections = 0;
  private fairShareRejections = 0;

  constructor(
    private readonly maxOperations: number,
    private readonly maxOperationsPerCaller: number,
  ) {}

  admit(fairnessKey: string): HttpAdmissionLease {
    if ((this.callers.get(fairnessKey) ?? 0) >= this.maxOperationsPerCaller) {
      this.fairShareRejections = Math.min(Number.MAX_SAFE_INTEGER, this.fairShareRejections + 1);
      throw new DbzzError("overloaded", "HTTP source capacity is full", {
        retryable: true,
        retryAfterMs: 0,
        resource: "connection",
      });
    }
    if (this.active >= this.maxOperations) {
      this.globalRejections = Math.min(Number.MAX_SAFE_INTEGER, this.globalRejections + 1);
      throw new DbzzError("overloaded", "HTTP ingress capacity is full", {
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
          throw new DbzzError("overloaded", "per-caller HTTP capacity is full", {
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
      },
    });
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

/** Read no more than maxBytes of the raw HTTP body before any UTF-8 or wire decode. */
async function readBoundedBody(request: Request, maxBytes: number, maxAgeMs: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      throw new DbzzError("malformed", "invalid Content-Length header");
    }
    if (Number(declared) > maxBytes) throw requestTooLarge();
  }
  if (request.body === null) throw new DbzzError("malformed", "request body is required");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new DbzzError("deadline_exceeded", "request body read deadline exceeded", {
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
    return strictUtf8.decode(body);
  } catch (cause) {
    throw new DbzzError("malformed", "request body is not valid UTF-8", { cause });
  }
}

async function parseHttpCall(request: Request, maxBytes: number, maxAgeMs: number): Promise<CallRequest> {
  const text = await readBoundedBody(request, maxBytes, maxAgeMs);
  let decoded: unknown;
  try {
    decoded = decode(text);
  } catch (cause) {
    throw new DbzzError("malformed", "malformed request body", { cause });
  }
  return parseCallRequest(decoded);
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
  return protocolError(new DbzzError("internal", "internal server error", { cause }));
}

function requireStatusScope(principal: ClientPrincipal, required: string): void {
  if (principal.kind !== "workload") {
    throw new DbzzError("unauthorized", "status requires a workload identity");
  }
  const claim = principal.claims.scope;
  if (typeof claim !== "string" || !claim.split(" ").includes(required)) {
    throw new DbzzError("unauthorized", "status scope is required");
  }
}

/** Owns listener admission, every WebSocket Session, and graceful Runtime drain. */
export class DbzzServer {
  readonly runtime: Runtime;
  readonly hostname: string;
  readonly statusScope: string;

  private readonly verifier: CredentialVerifier | undefined;
  private readonly connections = new Set<WsData>();
  private readonly outbound: OutboundBudget;
  private readonly httpAdmission: HttpAdmission;
  private listener: Server<WsData> | null = null;
  private lifecycle: DbzzServerState = "starting";
  private connectionRejections = 0;
  private transportSampleTimer: ReturnType<typeof setInterval> | null = null;
  private drainPromise: Promise<void> | null = null;

  constructor(options: ServeOptions) {
    this.runtime = options.runtime;
    this.hostname = options.hostname ?? "127.0.0.1";
    this.verifier = options.verifier;
    validateCredentialVerifierRevocation(
      this.verifier,
      this.runtime.limits.auth.revocationDeadlineMs,
    );
    this.statusScope = configuredStatusScope(options.statusScope);
    this.outbound = new OutboundBudget(
      this.runtime.limits.webSocket.maxBytes,
      this.runtime.limits.maxFrameBytes,
    );
    this.httpAdmission = new HttpAdmission(
      this.runtime.limits.maxOperations,
      this.runtime.limits.maxOperationsPerCaller,
    );

    try {
      this.listener = Bun.serve<WsData, never>({
        port: options.port,
        hostname: this.hostname,
        maxRequestBodySize: oneByteTransportLimit(
          this.runtime.limits.maxRequestBytes,
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
            this.runtime.limits.maxFrameBytes,
            "maxFrameBytes",
          ),
          backpressureLimit: this.runtime.limits.webSocket.maxBytesPerConnection,
          closeOnBackpressureLimit: true,
          idleTimeout: 120,
        },
      });
      this.lifecycle = "ready";
      this.startTransportSampler();
    } catch (error) {
      this.lifecycle = "failed";
      throw error;
    }
  }

  get state(): DbzzServerState {
    return this.lifecycle;
  }

  get port(): number {
    const port = this.listener?.port;
    if (typeof port !== "number") throw new Error("server has no TCP port");
    return port;
  }

  status(): DbzzServerStatus {
    const http = this.httpAdmission.snapshot();
    return Object.freeze({
      state: this.lifecycle,
      connections: this.connections.size,
      preHelloConnections: this.preHelloConnections(),
      connectionRejections: this.connectionRejections,
      httpIngress: http.active,
      httpFairnessKeys: http.fairnessKeys,
      httpGlobalRejections: http.globalRejections,
      httpFairShareRejections: http.fairShareRejections,
      outboundBytes: this.outbound.snapshot().bytes,
      runtime: this.runtime.status(),
    });
  }

  drain(): Promise<void> {
    if (this.drainPromise !== null) return this.drainPromise;
    if (this.lifecycle === "stopped") return Promise.resolve();
    if (this.lifecycle === "failed") {
      return Promise.reject(new DbzzError("unavailable", "server has failed", { resource: "connection" }));
    }

    // Readiness and every admission path observe this before the first await.
    this.lifecycle = "draining";
    this.stopTransportSampler();
    this.drainPromise = this.performDrain();
    return this.drainPromise;
  }

  private async fetch(request: Request, listener: Server<WsData>): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/live" && request.method === "GET") {
      const live = this.lifecycle !== "failed" && this.lifecycle !== "stopped";
      return json({ version: 1, live }, live ? 200 : 503);
    }
    if (url.pathname === "/ready" && request.method === "GET") {
      const ready = this.lifecycle === "ready" && this.runtime.status().state === "ready";
      return json({ version: 1, ready }, ready ? 200 : 503);
    }
    if (url.pathname === "/status" && request.method === "GET") {
      let admission: HttpAdmissionLease | undefined;
      let lease: AuthLease | undefined;
      try {
        const sourceKey = this.httpSourceKey(request, listener);
        admission = this.httpAdmission.admit(sourceKey);
        lease = await this.authenticate(request);
        admission.transfer(this.httpCallerKey(sourceKey, lease.principal));
        requireStatusScope(lease.principal, this.statusScope);
        return json({ version: 1, ...this.status() });
      } catch (error) {
        return protocolError(error);
      } finally {
        lease?.release();
        admission?.release();
      }
    }
    if (url.pathname === "/ws") {
      return this.upgradeWebSocket(request, listener);
    }
    if (url.pathname === "/api/call" && request.method === "POST") {
      return this.call(request, false, this.httpSourceKey(request, listener));
    }
    if (url.pathname === "/api/sse" && request.method === "POST") {
      return this.call(request, true, this.httpSourceKey(request, listener));
    }
    if (
      url.pathname === "/live" ||
      url.pathname === "/ready" ||
      url.pathname === "/status" ||
      url.pathname === "/api/call" ||
      url.pathname === "/api/sse"
    ) {
      return new Response("method not allowed", {
        status: 405,
        headers: { ...CORS, allow: url.pathname.startsWith("/api/") ? "POST" : "GET" },
      });
    }
    return new Response("not found", { status: 404, headers: CORS });
  }

  private async authenticate(request: Request): Promise<AuthLease> {
    const credential = credentialFromAuthorization(request.headers.get("authorization"));
    return acquireAuthLease({
      credential,
      verifier: this.verifier,
      signal: request.signal,
      revocationDeadlineMs: this.runtime.limits.auth.revocationDeadlineMs,
    });
  }

  private httpSourceKey(request: Request, listener: Server<WsData>): string {
    const source = listener.requestIP(request);
    const identity = source === null ? "unknown" : `${source.family}\0${source.address}`;
    return createHash("sha256").update(`http-source\0${identity}`).digest("base64url");
  }

  private httpCallerKey(sourceKey: string, principal: ClientPrincipal): string {
    if (principal.kind === "anonymous") return sourceKey;
    return createHash("sha256")
      .update(JSON.stringify(["http-principal", principal.kind, principal.issuer, principal.subject]))
      .digest("base64url");
  }

  private async call(request: Request, sse: boolean, sourceKey: string): Promise<Response> {
    const externalTrace = beginHttpTrace(this.runtime.telemetry, sse ? "sse" : "procedure");
    let id: number | null = null;
    let admission: HttpAdmissionLease | undefined;
    let lease: AuthLease | undefined;
    try {
      if (this.lifecycle !== "ready") throw unavailableWhile(this.lifecycle);
      admission = this.httpAdmission.admit(sourceKey);
      const call = await parseHttpCall(
        request,
        this.runtime.limits.maxRequestBytes,
        this.runtime.limits.readQueue.maxAgeMs,
      );
      id = call.id;
      identifyHttpTrace(externalTrace, call.ref, String(call.id));
      lease = externalTrace === undefined
        ? await this.authenticate(request)
        : await observeHttpAuth(externalTrace, () => this.authenticate(request));
      const fairnessKey = this.httpCallerKey(sourceKey, lease.principal);
      admission.transfer(fairnessKey);
      const input = carryHttpTrace({
        id: call.id,
        address: call.ref,
        args: call.args,
        principal: lease.principal,
        signal: lease.signal,
        fairnessKey,
      }, externalTrace);
      if (sse) {
        const stream = await this.runtime.runSse(input);
        const streamLease = lease;
        const streamAdmission = admission;
        const body = ownedStream(stream, () => {
          streamLease.release();
          streamAdmission.release();
        });
        try {
          const response = new Response(body, { headers: SSE_HEADERS });
          lease = undefined;
          admission = undefined;
          return response;
        } catch (error) {
          cancel(body, error);
          throw error;
        }
      }
      return await this.runtime.runProcedure({
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

  private upgradeWebSocket(request: Request, listener: Server<WsData>): Response | undefined {
    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405, headers: { ...CORS, allow: "GET" } });
    }
    if (this.lifecycle !== "ready") return protocolError(unavailableWhile(this.lifecycle));
    if (this.connections.size >= this.runtime.limits.maxConnections) {
      this.connectionRejections = Math.min(Number.MAX_SAFE_INTEGER, this.connectionRejections + 1);
      return protocolError(new DbzzError("overloaded", "connection capacity is full", {
        retryable: true,
        retryAfterMs: 0,
        resource: "connection",
      }));
    }

    const data: WsData = { socket: null, sink: null, session: null };
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
      data.sink = new WebSocketSessionSink({
        socket,
        budget: this.outbound,
        limits: this.runtime.limits,
        ...(this.runtime.telemetry.enabled
          ? {
              captureObserver: (lane) => this.runtime.captureDeliveryObserver(
                lane,
                data.session?.snapshot().clientSessionId ?? undefined,
              ),
            }
          : {}),
      });
      data.session = new Session(withSessionAuthObserver({
        runtime: this.runtime,
        sink: data.sink,
        verifier: this.verifier,
        revocationDeadlineMs: this.runtime.limits.auth.revocationDeadlineMs,
        limits: this.runtime.limits,
      }, this.runtime.telemetry.enabled
        ? (input) => beginSessionAuthTrace(this.runtime.telemetry, input)
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
    const bytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
    if (bytes > this.runtime.limits.maxFrameBytes) {
      void session.close(new DbzzError("overloaded", "client frame exceeds maxFrameBytes", {
        retryable: true,
        retryAfterMs: 0,
        resource: "connection",
      }));
      return;
    }

    let frame: unknown;
    try {
      const text = typeof raw === "string" ? raw : strictUtf8.decode(raw);
      frame = decode(text);
    } catch (cause) {
      void session.close(new DbzzError("malformed", "malformed WebSocket frame", { cause }));
      return;
    }
    void session.handle(frame).catch(() => {});
  }

  private closeWebSocket(socket: ServerWebSocket<WsData>): void {
    const { data } = socket;
    this.connections.delete(data);
    void data.session?.close(new DbzzError("unavailable", "WebSocket disconnected", {
      resource: "connection",
    }));
  }

  private preHelloConnections(): number {
    return Math.max(0, this.connections.size - this.runtime.connectionCount);
  }

  private startTransportSampler(): void {
    if (!this.runtime.telemetry.enabled) return;
    this.sampleTransport();
    this.transportSampleTimer = setInterval(
      () => this.sampleTransport(),
      this.runtime.telemetry.sampleIntervalMs,
    );
    this.transportSampleTimer.unref?.();
  }

  private stopTransportSampler(): void {
    if (this.transportSampleTimer === null) return;
    clearInterval(this.transportSampleTimer);
    this.transportSampleTimer = null;
  }

  private sampleTransport(): void {
    if (!this.runtime.telemetry.enabled || this.lifecycle !== "ready") return;
    if (this.runtime.state !== "ready") {
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
    ] as const;
    for (const [name, value, unit] of metrics) {
      this.runtime.telemetry.recordMetric({ name, value, unit });
    }
  }

  private async performDrain(): Promise<void> {
    const listener = this.listener!;
    const deadlineAtMs = Date.now() + this.runtime.limits.gracefulShutdownMs;
    const listenerStopped = listener.stop(false);
    // Bun may retain idle upgraded/keep-alive sockets after the listener stops.
    // They are not graceful application work, so do not let them consume the
    // Runtime deadline. A final stop(true) below releases them after all owned
    // Sessions and operations have drained.
    void listenerStopped.catch(() => {});
    const reason = new DbzzError("draining", "server is draining", {
      retryable: true,
      retryAfterMs: DRAIN_RETRY_AFTER_MS,
      resource: "connection",
    });
    const sessions = [...this.connections].map((connection) => {
      if (connection.session !== null) return connection.session.close(reason);
      connection.socket?.close(1013, "draining");
      return Promise.resolve();
    });
    const runtimeDrain = this.runtime.drain(deadlineAtMs);
    const graceful = Promise.all([runtimeDrain, ...sessions])
      .then(() => listener.stop(true));

    const deadlineError = new DbzzError("deadline_exceeded", "graceful shutdown deadline exceeded", {
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
      for (const connection of this.connections) connection.socket?.terminate();
      // Initiate the force close but do not await Bun's listener promise: Bun
      // keeps that promise pending for a handler that ignores cancellation,
      // which would defeat the finite shutdown deadline this boundary owns.
      void listener.stop(true).catch(() => {});
      throw error;
    }
  }
}

export function serve(options: ServeOptions): DbzzServer {
  return new DbzzServer(options);
}
