/** Production Protocol-2 HTTP, SSE, and WebSocket ownership for one Runtime. */
import { isIP } from "node:net";
import type { Server, ServerWebSocket } from "bun";
import proxyaddr from "@fastify/proxy-addr";
import {
  decode,
  parseSseAckRequest,
  stableEncode,
  type SseAckRequest,
} from "@ackerdb/core";
import {
  ANONYMOUS_PRINCIPAL,
  credentialFromAuthorization,
  type ClientPrincipal,
} from "../auth/credentials.ts";
import {
  acquireAuthLease,
  type AuthLease,
} from "../auth/lease.ts";
import type { AuthInvalidationPublisher } from "../auth/invalidation.ts";
import {
  callerFairnessKey,
  transportSource,
  type TransportSource,
} from "../runtime/caller.ts";
import { OutboundBudget } from "../subscriptions/delivery/budget.ts";
import { WebSocketSessionSink } from "../subscriptions/delivery/websocket.ts";
import { AckerDBError, drainingError, notReadyError } from "../shared/errors.ts";
import { defineServiceLimits, type ServiceLimits } from "../runtime/limits.ts";
import {
  ACKERDB_HTTP_ROUTES,
  EXPOSED_HTTP_METHODS,
  IDEMPOTENCY_KEY_HEADER,
  SSE_STREAM_HEADERS,
} from "./http-surface.ts";
import type { ExposedHttpCodec } from "./http-codec.ts";
import {
  CORS,
  json,
  outcomeError,
  protocolError,
  valueResponder,
  VARY_AUTHORIZATION,
} from "./response.ts";
import { openApiBytes, openApiDocument, type OpenApiInfo } from "./openapi.ts";
import { HttpRegistry } from "./routing/registry.ts";
import { HTTP_METHODS, type HttpMethod, type HttpParams } from "./routing/path.ts";
import {
  frameworkHttp,
  type AnyHttp,
  type HttpHandlers,
  type HttpRoute,
  type HttpRouteCtx,
  type HttpRouteHandler,
  type HttpRouteResult,
} from "./routing/route.ts";
import type { ExposedFunction } from "../app/registry.ts";
import { outcomeFromError } from "../runtime/outcome.ts";
import { carryHttpRequestProvenance } from "../runtime/request-provenance.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { RuntimeStatus } from "../runtime/contracts/status.ts";
import { Session } from "../subscriptions/session/session.ts";
import { DEFAULT_FILE_MAX_BYTES, HARD_FILE_MAX_BYTES } from "../files/namespace.ts";
import { utf8ByteLength } from "../shared/bytes.ts";
import { finiteMillis } from "../shared/clock.ts";

export type AckerDBServerState = "starting" | "ready" | "draining" | "stopped" | "failed";
/** The boot's phases, in the order `boot()` advances them; `/ready` names the current one. */
export type AckerDBStartupPhase =
  | "listening"
  | "codegen"
  | "loading"
  | "opening-storage"
  | "migrating"
  | "reconciling"
  | "loading-runtime"
  | "starting-runtime";

export interface AckerDBServerOptions {
  readonly limits: ServiceLimits;
  readonly port: number;
  /** Listener ceiling for streaming File PUTs; every session may only narrow it. */
  readonly fileMaxBytes?: number;
  readonly hostname?: string;
  /** Socket peers permitted to supply a client address through X-Forwarded-For. */
  readonly trustedProxy?: string | readonly string[];
  /** Exact workload scope required by GET /status. */
  readonly statusScope?: string;
  /**
   * Serve the OpenAPI document at `GET /_openapi.json`, published under this
   * identity — the application's own name and version, which a listener that
   * never sees an app directory cannot derive. Absent (the default) leaves the
   * path a 404 like any other unclaimed route: the CLI export is the default way
   * to consume the schema, and this endpoint is opt-in.
   */
  readonly openapiEndpoint?: OpenApiInfo;
}

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
  readonly fileTransfers: number;
  readonly fileTransferFairnessKeys: number;
  readonly fileTransferGlobalRejections: number;
  readonly fileTransferFairShareRejections: number;
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
const SSE_HEADERS = Object.freeze({
  ...CORS,
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  vary: VARY_AUTHORIZATION,
  "x-accel-buffering": "no",
});

/**
 * Framework CORS is the same preflight everywhere it applies, so it is one
 * handler value under several method keys rather than several handlers.
 */
const preflight = (): Response => new Response(null, { status: 204, headers: CORS });

/**
 * Every method a compiled route answers reaches the same closure: which of the
 * route's own handlers runs is the route value's business, and the Runtime
 * reads it from the request.
 */
function everyMethod(
  methods: readonly HttpMethod[],
  handler: HttpRouteHandler,
): HttpHandlers<HttpRouteCtx, HttpRouteResult> {
  const handlers: Record<string, HttpRouteHandler> = {};
  for (const method of methods) handlers[method] = handler;
  return handlers as HttpHandlers<HttpRouteCtx, HttpRouteResult>;
}

const MAX_FILE_TRANSFERS = 128;
const MAX_FILE_TRANSFERS_PER_CALLER = 16;
const STARTUP_PHASE_ORDER: Readonly<Record<AckerDBStartupPhase, number>> = Object.freeze({
  listening: 0,
  codegen: 1,
  loading: 2,
  "opening-storage": 3,
  migrating: 4,
  reconciling: 5,
  "loading-runtime": 6,
  "starting-runtime": 7,
});

function unavailableWhile(state: AckerDBServerState): AckerDBError {
  return state === "draining"
    ? drainingError("server is draining", "connection")
    : notReadyError("server is not ready", "connection");
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

interface HttpAdmissionLabels {
  readonly owner: string;
  readonly ingress: string;
}

const HTTP_ADMISSION_LABELS: HttpAdmissionLabels = Object.freeze({
  owner: "HTTP",
  ingress: "HTTP ingress",
});

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
    private readonly labels = HTTP_ADMISSION_LABELS,
  ) {}

  admit(fairnessKey: string): HttpAdmissionLease {
    if (!this.accepting) {
      throw drainingError(`${this.labels.ingress} is draining`, "connection");
    }
    if ((this.callers.get(fairnessKey) ?? 0) >= this.maxOperationsPerCaller) {
      this.fairShareRejections = Math.min(Number.MAX_SAFE_INTEGER, this.fairShareRejections + 1);
      throw new AckerDBError("overloaded", `${this.labels.owner} source capacity is full`, {
        retryable: true,
        retryAfterMs: 0,
        resource: "connection",
      });
    }
    if (this.active >= this.maxOperations) {
      this.globalRejections = Math.min(Number.MAX_SAFE_INTEGER, this.globalRejections + 1);
      throw new AckerDBError("overloaded", `${this.labels.ingress} capacity is full`, {
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
          throw new AckerDBError("overloaded", `per-caller ${this.labels.owner} capacity is full`, {
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

/** How a bounded body read consumes its chunks and settles its value. */
interface BoundedBodySink<T> {
  write(chunk: Uint8Array): void;
  finish(bytes: number): T;
}

/** Read no more than maxBytes of the raw HTTP body, streaming each chunk into `sink`. */
async function readBounded<T>(
  request: Request,
  maxBytes: number,
  maxAgeMs: number,
  sink: BoundedBodySink<T>,
): Promise<T> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      throw new AckerDBError("malformed", "invalid Content-Length header");
    }
    if (Number(declared) > maxBytes) throw requestTooLarge();
  }
  if (request.body === null) throw new AckerDBError("malformed", "request body is required");

  const reader = request.body.getReader();
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
      sink.write(value);
    }
    return sink.finish(bytes);
  } catch (error) {
    cancel(reader, error);
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function utf8Malformed(cause: unknown): AckerDBError {
  return new AckerDBError("malformed", "request body is not valid UTF-8", { cause });
}

/** The bounded body as UTF-8 text, decoded incrementally so the bytes are never held twice. */
async function readBoundedBody(
  request: Request,
  maxBytes: number,
  maxAgeMs: number,
): Promise<BoundedHttpBody> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  return readBounded(request, maxBytes, maxAgeMs, {
    write(chunk) {
      try {
        chunks.push(decoder.decode(chunk, { stream: true }));
      } catch (cause) {
        throw utf8Malformed(cause);
      }
    },
    finish(bytes) {
      try {
        chunks.push(decoder.decode());
      } catch (cause) {
        throw utf8Malformed(cause);
      }
      return { text: chunks.join(""), bytes };
    },
  });
}

/** The bounded body byte-exact and undecoded, for the raw handler surface. */
async function readBoundedBytes(
  request: Request,
  maxBytes: number,
  maxAgeMs: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  return readBounded(request, maxBytes, maxAgeMs, {
    write(chunk) {
      chunks.push(chunk);
    },
    finish(bytes) {
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return body;
    },
  });
}

/** The handler's Request: same URL, method, headers, and signal; the buffered bytes as body. */
function bufferedRawRequest(request: Request, body: Uint8Array<ArrayBuffer> | null): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    ...(body === null ? {} : { body }),
    signal: request.signal,
  });
}

/** Text into a value; any parser failure is the one malformed outcome, with its cause. */
function parsedOrMalformed<T>(text: string, parse: (text: string) => T, message: string): T {
  try {
    return parse(text);
  } catch (cause) {
    throw new AckerDBError("malformed", message, { cause });
  }
}

async function parseHttpBody<T>(
  request: Request,
  maxBytes: number,
  maxAgeMs: number,
  parse: (value: unknown) => T,
): Promise<ParsedHttpBody<T>> {
  const body = await readBoundedBody(request, maxBytes, maxAgeMs);
  return {
    value: parse(parsedOrMalformed(body.text, decode, "malformed request body")),
    bytes: body.bytes,
  };
}

/**
 * An exposed function's args: plain JSON, decoded through the function's own
 * standard-JSON codec so a caller obeying the published document is understood.
 * Absent or empty args mean `{}`.
 */
function decodeArgs(text: string | null, codec: ExposedHttpCodec): unknown {
  if (text === null || text === "") return codec.decodeArgs({});
  return codec.decodeArgs(parsedOrMalformed(text, JSON.parse, "args are not valid JSON"));
}

async function parseArgsHttpBody(
  request: Request,
  codec: ExposedHttpCodec,
  maxBytes: number,
  maxAgeMs: number,
): Promise<ParsedHttpBody<unknown>> {
  if (request.body === null) return { value: decodeArgs(null, codec), bytes: 0 };
  const body = await readBoundedBody(request, maxBytes, maxAgeMs);
  return { value: decodeArgs(body.text, codec), bytes: body.bytes };
}

/**
 * A GET query carries its entire args object in one url-encoded `args`
 * parameter. Per-field parameters (`?limit=10`) are deliberately unsupported:
 * coercing strings into the declared shape would be a second validation system.
 */
function parseArgsSearchParameter(
  url: URL,
  codec: ExposedHttpCodec,
  maxBytes: number,
): ParsedHttpBody<unknown> {
  const raw = url.searchParams.get("args");
  if (raw === null) return { value: decodeArgs(null, codec), bytes: 0 };
  const bytes = utf8ByteLength(raw);
  if (bytes > maxBytes) throw requestTooLarge();
  return { value: decodeArgs(raw, codec), bytes };
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

/** Owns listener admission, every WebSocket Session, and graceful Runtime drain. */
export class AckerDBServer {
  readonly limits: ServiceLimits;
  readonly hostname: string;
  readonly statusScope: string;

  private readonly connections = new Set<WsData>();
  private readonly outbound: OutboundBudget;
  private readonly httpAdmission: HttpAdmission;
  private readonly fileAdmission: HttpAdmission;
  private readonly openapiInfo: OpenApiInfo | undefined;
  /** The listener's one route table; `fetch` asks it and nothing else. */
  private readonly routes: HttpRegistry;
  /** The OpenAPI document assembled at activation, or null while it is not served. */
  private openapi: Uint8Array<ArrayBuffer> | null = null;
  private readonly trustedProxy: ReturnType<typeof proxyaddr.compile> | null;
  private listener: Server<WsData> | null = null;
  private activeRuntime: Runtime | null = null;
  private lifecycle: AckerDBServerState = "starting";
  private startup: AckerDBStartupPhase | null = "listening";
  private connectionRejections = 0;
  /** Server-owned request ids for path-addressed calls. */
  private httpRequests = 0;
  private sseAckIngress = 0;
  private sseAckNoops = 0;
  private drainPromise: Promise<void> | null = null;

  constructor(options: AckerDBServerOptions) {
    this.limits = defineServiceLimits(options.limits);
    const fileMaxBytes = options.fileMaxBytes ?? DEFAULT_FILE_MAX_BYTES;
    if (
      !Number.isSafeInteger(fileMaxBytes) ||
      fileMaxBytes <= 0 ||
      fileMaxBytes > HARD_FILE_MAX_BYTES
    ) {
      throw new RangeError(`fileMaxBytes must be from 1 through ${HARD_FILE_MAX_BYTES}`);
    }
    this.hostname = options.hostname ?? "127.0.0.1";
    this.statusScope = configuredStatusScope(options.statusScope);
    this.trustedProxy = options.trustedProxy === undefined
      ? null
      : proxyaddr.compile(
        typeof options.trustedProxy === "string"
          ? options.trustedProxy
          : [...options.trustedProxy],
      );
    this.openapiInfo = options.openapiEndpoint;
    this.outbound = new OutboundBudget(
      this.limits.webSocket.maxBytes,
      this.limits.maxFrameBytes,
    );
    this.httpAdmission = new HttpAdmission(
      this.limits.maxOperations,
      this.limits.maxOperationsPerCaller,
    );
    this.fileAdmission = new HttpAdmission(
      MAX_FILE_TRANSFERS,
      MAX_FILE_TRANSFERS_PER_CALLER,
      { owner: "File transfer", ingress: "File transfer" },
    );
    // The live route table exists before the port does, so a probe that
    // arrives on the first tick of Boot meets a registered route rather than a
    // lifecycle branch. Application routes join it at activation.
    this.routes = new HttpRegistry(() => this.unmatched());
    this.routes.add(this.frameworkRoutes().map((route) => ({ route, owner: "AckerDB" })));
    try {
      this.listener = Bun.serve<WsData, never>({
        port: options.port,
        hostname: this.hostname,
        // Built-in File PUTs stream under their own per-session bound. Every
        // other route still enforces maxRequestBytes while consuming its body.
        maxRequestBodySize: oneByteTransportLimit(
          Math.max(
            this.limits.maxRequestBytes,
            fileMaxBytes,
          ),
          "maxRequestBytes or configured File limit",
        ),
        development: false,
        error: (error) => internalErrorResponse(error),
        // One permanent dispatch for the listener's whole life: lifecycle
        // transitions change what the table holds and what its handlers
        // answer, never which function Bun calls.
        fetch: (request) => this.routes.dispatch(new URL(request.url).pathname, request),
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
    const files = this.fileAdmission.snapshot();
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
      fileTransfers: files.active,
      fileTransferFairnessKeys: files.fairnessKeys,
      fileTransferGlobalRejections: files.globalRejections,
      fileTransferFairShareRejections: files.fairShareRejections,
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

  /** Atomically attach the started Runtime and admit application traffic. */
  activate(runtime: Runtime): void {
    if (this.lifecycle !== "starting" || this.activeRuntime !== null) {
      throw new Error("server can only be activated once while starting");
    }
    if (runtime.state !== "ready") throw new Error("Runtime must be ready before activation");
    if (stableEncode(runtime.limits) !== stableEncode(this.limits)) {
      throw new Error("Runtime limits must match listener limits");
    }
    try {
      // The registry is immutable after load, so the document is too: assemble
      // it once here and serve those bytes. A document that cannot be built
      // fails the activation rather than the first caller that asks for it.
      if (this.openapiInfo !== undefined) {
        this.openapi = openApiBytes(openApiDocument(runtime.registry, this.openapiInfo));
      }
      // The whole application is compiled and validated before the first
      // insertion, and readiness flips only after the last one — with no await
      // anywhere between, so no request can observe half an application.
      this.routes.add([
        // An exposed function answers the methods its kind declares — the very
        // table OpenAPI documents from, so served and published cannot drift —
        // plus framework CORS. Its closure is the whole of `call`.
        ...[...runtime.registry.exposed.values()].map((exposed) => ({
          route: frameworkHttp(exposed.path, {
            ...everyMethod(EXPOSED_HTTP_METHODS[exposed.kind], (_ctx, request) =>
              this.call(request, new URL(request.url), exposed, this.requestSource(request))),
            OPTIONS: preflight,
          }),
          owner: exposed.address,
        })),
        // A raw route answers exactly what it declared, preflight included or
        // not: its OPTIONS is its author's, or it has none.
        ...runtime.registry.httpRoutes.map(({ address, http }) => ({
          route: frameworkHttp(
            http.path,
            everyMethod(
              HTTP_METHODS.filter((method) => http.handlers[method] !== undefined),
              (ctx, request) => this.applicationRouteCall(request, http, ctx.params),
            ),
          ),
          owner: address,
        })),
      ]);
    } catch (error) {
      this.startup = null;
      this.lifecycle = "stopped";
      void this.listener?.stop(true).catch(() => {});
      throw error;
    }
    this.activeRuntime = runtime;
    this.startup = null;
    this.lifecycle = "ready";
  }

  /**
   * Leave readiness and close transport admission while the Runtime stays live.
   * Trusted in-process work keeps its authority across this window: `drain` is
   * what closes system-run admission (ADR-0015), so an owner that must release
   * application-owned resources through `system.run` calls this first, releases
   * them, and only then drains. Idempotent, and a no-op once shutdown began.
   */
  beginShutdown(): void {
    if (this.lifecycle !== "starting" && this.lifecycle !== "ready") return;
    // Readiness and every admission path observe this before the first await.
    this.lifecycle = "draining";
  }

  drain(deadlineAtMs = Date.now() + this.limits.gracefulShutdownMs): Promise<void> {
    if (this.drainPromise !== null) return this.drainPromise;
    if (this.lifecycle === "stopped") return Promise.resolve();
    if (this.lifecycle === "failed") {
      return Promise.reject(new AckerDBError("unavailable", "server has failed", { resource: "connection" }));
    }
    finiteMillis(deadlineAtMs, "server shutdown deadline");

    this.beginShutdown();
    this.drainPromise = this.performDrain(deadlineAtMs);
    return this.drainPromise;
  }

  /**
   * Whether application-owned work may run: the listener has been activated
   * and its Runtime is still serving. Every route that reaches application
   * code asks this, because a route existing and a route being reachable are
   * different questions and only the second one moves with the lifecycle.
   */
  private applicationReady(): boolean {
    return this.lifecycle === "ready" && this.activeRuntime?.state === "ready";
  }

  /**
   * The routes AckerDB always owns, registered through the same factory an
   * application uses. `/live` and `/ready` are in the table before the first
   * request, so probes answer throughout Boot; the rest answer the lifecycle
   * themselves, because when a route is reachable is its own policy.
   */
  private frameworkRoutes(): readonly HttpRoute[] {
    const grants = ACKERDB_HTTP_ROUTES.fileDownload;
    // GET and HEAD are the same route behaviour, so they are the same handler
    // value under two keys rather than two closures that must stay equal.
    const download = (
      ctx: HttpRouteCtx<typeof grants>,
      request: Request,
    ): Promise<Response> => this.fileCall(request, "grants", ctx.params.handle);
    return [
      frameworkHttp(ACKERDB_HTTP_ROUTES.live, {
        GET: () => {
          const live = this.lifecycle !== "failed" && this.lifecycle !== "stopped";
          return json({ version: 1, live }, live ? 200 : 503);
        },
        OPTIONS: preflight,
      }),
      frameworkHttp(ACKERDB_HTTP_ROUTES.ready, {
        GET: () => {
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
        },
        OPTIONS: preflight,
      }),
      frameworkHttp(ACKERDB_HTTP_ROUTES.status, {
        GET: (_ctx, request) => this.statusCall(request),
        OPTIONS: preflight,
      }),
      frameworkHttp(ACKERDB_HTTP_ROUTES.websocket, {
        GET: (_ctx, request) => {
          if (!this.applicationReady()) return protocolError(unavailableWhile(this.lifecycle));
          return this.upgradeWebSocket(request);
        },
      }),
      frameworkHttp(ACKERDB_HTTP_ROUTES.sseAck, {
        POST: (_ctx, request) => this.acknowledgeSse(
          request,
          callerFairnessKey(ANONYMOUS_PRINCIPAL, this.requestSource(request)),
        ),
        OPTIONS: preflight,
      }),
      frameworkHttp(ACKERDB_HTTP_ROUTES.fileUpload, {
        PUT: (ctx, request) => this.fileCall(request, "uploads", ctx.params.handle),
        OPTIONS: preflight,
      }),
      frameworkHttp(grants, { GET: download, HEAD: download, OPTIONS: preflight }),
      // A schema request is a copy of bytes the activation already assembled:
      // it takes no admission slot, no credential, and no runtime work. Left
      // unconfigured — the default — the route does not exist at all, and the
      // path answers the same 404 as any other unclaimed one.
      ...(this.openapiInfo === undefined ? [] : [frameworkHttp(ACKERDB_HTTP_ROUTES.openapi, {
        GET: () => this.openapi === null
          ? protocolError(unavailableWhile(this.lifecycle))
          : new Response(this.openapi, {
            headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
          }),
        OPTIONS: preflight,
      })]),
    ];
  }

  /**
   * What a request no route claims is answered with. Before readiness and
   * while draining the application is unreachable rather than absent, so the
   * lifecycle outcome comes first; afterwards an unclaimed path is an ordinary
   * 404 in the one shape every other failure here speaks — a caller decoding
   * this surface meets `not_found`, never a plain-text body its decoder
   * reports as malformed.
   */
  private unmatched(): Response {
    return this.applicationReady()
      ? outcomeError(new AckerDBError("not_found", "no route at this path"))
      : outcomeError(unavailableWhile(this.lifecycle));
  }

  private async statusCall(request: Request): Promise<Response> {
    let admission: HttpAdmissionLease | undefined;
    let lease: AuthLease | undefined;
    try {
      if (!this.applicationReady()) throw unavailableWhile(this.lifecycle);
      const source = this.requestSource(request);
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
      resolveScopes: runtime.resolveScopes,
      ...(signal === undefined ? {} : { signal }),
      revocationDeadlineMs: runtime.limits.auth.revocationDeadlineMs,
    });
  }

  private requestSource(request: Request): TransportSource {
    const source = transportSource(this.listener!.requestIP(request));
    if (this.trustedProxy === null) return source;
    const address = proxyaddr({
      headers: { "x-forwarded-for": request.headers.get("x-forwarded-for") ?? undefined },
      socket: { remoteAddress: source.address },
    } as unknown as Parameters<typeof proxyaddr>[0], this.trustedProxy);
    const family = isIP(address);
    if (family === 0) return source;
    return transportSource({ family: family === 6 ? "IPv6" : "IPv4", address });
  }

  private async call(
    request: Request,
    url: URL,
    exposed: ExposedFunction,
    source: TransportSource,
  ): Promise<Response> {
    const runtime = this.requireRuntime();
    let admission: HttpAdmissionLease | undefined;
    let lease: AuthLease | undefined;
    // The listener owns the response handoff, so it owns the release of any
    // self-invalidation this request commits: publishing one from inside the
    // commit would abort the lease the answer is still travelling on.
    let invalidations: AuthInvalidationPublisher | undefined;
    try {
      if (this.lifecycle !== "ready") throw unavailableWhile(this.lifecycle);
      admission = this.httpAdmission.admit(callerFairnessKey(ANONYMOUS_PRINCIPAL, source));
      // Correlation is the HTTP response itself, so the request id is the
      // listener's own sequence rather than a client input. The path already
      // names the function, so even a malformed body reports what it targeted.
      const id = ++this.httpRequests;
      const address = exposed.address;
      lease = await this.authenticate(request);
      const fairnessKey = callerFairnessKey(lease.principal, source);
      admission.transfer(fairnessKey);
      const { value: args, bytes } = request.method === "GET"
        ? parseArgsSearchParameter(url, exposed.codec, runtime.limits.maxRequestBytes)
        : await parseArgsHttpBody(
            request,
            exposed.codec,
            runtime.limits.maxRequestBytes,
            runtime.limits.readQueue.maxAgeMs,
          );
      invalidations = runtime.authInvalidation.publisher(
        lease.principal,
        lease.invalidationScope,
      );
      const input = carryHttpRequestProvenance({
        id,
        address,
        args,
        principal: lease.principal,
        signal: lease.signal,
        fairnessKey,
      }, bytes, invalidations);
      if (exposed.kind === "sse") {
        const { stream, streamId } = await runtime.runSse(input);
        const streamLease = lease;
        lease = undefined;
        const body = ownedStream(stream, () => streamLease.release());
        try {
          return new Response(body, {
            headers: {
              ...SSE_HEADERS,
              [SSE_STREAM_HEADERS.stream]: streamId,
              [SSE_STREAM_HEADERS.maxStallMs]: String(runtime.limits.sse.maxStallMs),
            },
          });
        } catch (error) {
          cancel(body, error);
          throw error;
        }
      }
      const httpRequest = { ...input, respond: valueResponder };
      if (exposed.kind === "mutation") {
        // Replay protection is opt-in per request: without the header the
        // mutation executes like any other REST POST.
        const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER);
        return await runtime.runMutation(idempotencyKey === null
          ? httpRequest
          : { ...httpRequest, idempotencyKey });
      }
      return await (exposed.kind === "query"
        ? runtime.runQuery(httpRequest)
        : runtime.runProcedure(httpRequest));
    } catch (error) {
      return outcomeError(error);
    } finally {
      invalidations?.finish();
      lease?.release();
      admission?.release();
    }
  }

  /**
   * One application-owned raw route call. The framework's part here is
   * survival, not semantics: reachability, admission, and the byte bound run
   * before the handler, and the buffered Request then crosses whole — body
   * bytes exact, every header including Authorization. The handler's Response
   * passes through unstamped; only failures answer framework-authored bare
   * Outcomes.
   */
  private async applicationRouteCall(
    request: Request,
    route: AnyHttp,
    params: HttpParams,
  ): Promise<Response> {
    let admission: HttpAdmissionLease | undefined;
    try {
      if (!this.applicationReady()) throw unavailableWhile(this.lifecycle);
      const runtime = this.requireRuntime();
      const fairnessKey = callerFairnessKey(
        ANONYMOUS_PRINCIPAL,
        this.requestSource(request),
      );
      admission = this.httpAdmission.admit(fairnessKey);
      const id = ++this.httpRequests;
      const body = request.body === null
        ? null
        : await readBoundedBytes(
            request,
            runtime.limits.maxRequestBytes,
            runtime.limits.readQueue.maxAgeMs,
          );
      const response = await runtime.runHttpRoute({
        route,
        params,
        request: bufferedRawRequest(request, body),
        id,
        // The runtime owns the floor for bodiless requests.
        ...(body === null ? {} : { requestBytes: body.byteLength }),
        signal: request.signal,
        fairnessKey,
      });
      // Every part of the handler's Response is read exactly once: a second
      // read of an accessor that answered differently — or threw — would
      // strand the admission slot this frame is transferring.
      const stream = response.body;
      if (stream === null) return response;
      // A streaming body keeps its admission slot until the stream settles:
      // without this, a public raw route could hold open more streams than
      // `maxOperations` ever admitted, and drain would not own them.
      const streamAdmission = admission;
      admission = undefined;
      try {
        return new Response(ownedStream(stream, () => streamAdmission.release()), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        // The wrapper never took ownership, so this frame still owes the slot.
        streamAdmission.release();
        throw error;
      }
    } catch (error) {
      return outcomeError(error);
    } finally {
      admission?.release();
    }
  }

  /** File bodies stay streaming while admission and any auth lease own the response. */
  private async fileCall(
    request: Request,
    route: "uploads" | "grants",
    handle: string,
  ): Promise<Response> {
    let admission: HttpAdmissionLease | undefined;
    let lease: AuthLease | undefined;
    try {
      if (!this.applicationReady()) throw unavailableWhile(this.lifecycle);
      const runtime = this.requireRuntime();
      const source = this.requestSource(request);
      const anonymousKey = callerFairnessKey(ANONYMOUS_PRINCIPAL, source);
      admission = this.fileAdmission.admit(anonymousKey);
      const response = await runtime.runFileRequest({
        request,
        route,
        handle,
        authenticate: async () => {
          lease ??= await this.authenticate(request);
          const fairnessKey = callerFairnessKey(lease.principal, source);
          admission?.transfer(fairnessKey);
          return { principal: lease.principal, signal: lease.signal, fairnessKey };
        },
      });
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(CORS)) {
        if (!headers.has(name)) headers.set(name, value);
      }
      const rewrapped = (streamed: ReadableStream<Uint8Array> | null): Response =>
        new Response(streamed, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      if (response.body === null) return rewrapped(null);
      const streamAdmission = admission;
      const streamLease = lease;
      admission = undefined;
      lease = undefined;
      const body = ownedStream(response.body, () => {
        streamLease?.release();
        streamAdmission.release();
      });
      try {
        return rewrapped(body);
      } catch (error) {
        cancel(body, error);
        throw error;
      }
    } catch (error) {
      return outcomeError(error);
    } finally {
      lease?.release();
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

  private upgradeWebSocket(request: Request): Response | undefined {
    if (this.connections.size >= this.limits.maxConnections) {
      this.connectionRejections = Math.min(Number.MAX_SAFE_INTEGER, this.connectionRejections + 1);
      return protocolError(new AckerDBError("overloaded", "connection capacity is full", {
        retryable: true,
        retryAfterMs: 0,
        resource: "connection",
      }));
    }

    const data: WsData = {
      source: this.requestSource(request),
      socket: null,
      sink: null,
      session: null,
    };
    // Reserve the transport slot before upgrade/open/hello can perform any work.
    this.connections.add(data);
    try {
      // Bun's own contract for an accepted upgrade: the socket has left HTTP,
      // so this route answers `undefined` rather than a Response.
      if (this.listener!.upgrade(request, { data })) return undefined;
    } catch (error) {
      this.connections.delete(data);
      return protocolError(error);
    }
    this.connections.delete(data);
    return protocolError(new AckerDBError("malformed", "websocket upgrade required"));
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
      });
      data.session = new Session({
        runtime,
        sink: data.sink,
        source: data.source,
        revocationDeadlineMs: runtime.limits.auth.revocationDeadlineMs,
        limits: runtime.limits,
      });
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

  private requireRuntime(): Runtime {
    const runtime = this.activeRuntime;
    if (runtime === null) throw unavailableWhile(this.lifecycle);
    return runtime;
  }

  private async performDrain(deadlineAtMs: number): Promise<void> {
    const listener = this.listener!;
    const runtime = this.activeRuntime;
    const reason = drainingError("server is draining", "connection");
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
      .then(() => Promise.all([
        this.httpAdmission.closeAndDrain(),
        this.fileAdmission.closeAndDrain(),
      ]))
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
      void this.fileAdmission.closeAndDrain();
      for (const connection of this.connections) connection.socket?.terminate();
      // Initiate the force close but do not await Bun's listener promise: Bun
      // keeps that promise pending for a handler that ignores cancellation,
      // which would defeat the finite shutdown deadline this boundary owns.
      void listener.stop(true).catch(() => {});
      throw error;
    }
  }
}
