/** Production Protocol-2 HTTP, SSE, and WebSocket ownership for one Runtime. */
import { isIP } from "node:net";
import type { Server, ServerWebSocket } from "bun";
import proxyaddr from "@fastify/proxy-addr";
import {
  ACKERDB_VERSION,
  decode,
  encode,
  parseSseAckRequest,
  stableEncode,
  type ErrorMessage,
  type Outcome,
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
import { AckerDBError, drainingError } from "../shared/errors.ts";
import { defineServiceLimits, type ServiceLimits } from "../runtime/limits.ts";
import {
  ACKERDB_HTTP_ROUTES,
  EXPOSED_HTTP_METHODS,
  IDEMPOTENCY_KEY_HEADER,
  RECEIPT_HEADERS,
  SSE_STREAM_HEADERS,
  isAckerDBHttpRoute,
} from "./http-surface.ts";
import type { ExposedHttpCodec } from "./http-codec.ts";
import { openApiBytes, openApiDocument, type OpenApiInfo } from "./openapi.ts";
import type { ExposedFunction, HttpHandlerRoute } from "../app/registry.ts";
import { standardJsonText } from "../validation/standard-json.ts";
import { outcomeFromError, outcomeHttpStatus } from "../runtime/outcome.ts";
import { carryHttpRequestProvenance } from "../runtime/request-provenance.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type {
  HttpMutationReceipt,
  RuntimeHttpResponder,
} from "../runtime/contracts/requests.ts";
import type { RuntimeStatus } from "../runtime/contracts/status.ts";
import { Session } from "../subscriptions/session/session.ts";
import { DEFAULT_FILE_MAX_BYTES, HARD_FILE_MAX_BYTES } from "../files/namespace.ts";
import { utf8ByteLength } from "../shared/bytes.ts";

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
const CORS = Object.freeze({
  "access-control-allow-origin": "*",
  // PATCH, PUT and DELETE are raw HTTP handler methods; the exposed function
  // surface serves only GET and POST.
  "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, content-disposition, authorization, idempotency-key, range, if-match, if-none-match, if-modified-since, if-unmodified-since, if-range",
  "access-control-expose-headers": [
    ...Object.values(SSE_STREAM_HEADERS),
    ...Object.values(RECEIPT_HEADERS),
    "accept-ranges",
    "content-disposition",
    "content-range",
    "digest",
    "etag",
    "last-modified",
  ].join(", "),
});

/**
 * One URL answers different bearer credentials with different rows, and the GET
 * query form is the cacheable one an operator is invited to put a CDN rule in
 * front of. Without this, such a rule serves one caller's rows to another.
 */
const VARY_AUTHORIZATION = "authorization";

const SSE_HEADERS = Object.freeze({
  ...CORS,
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  vary: VARY_AUTHORIZATION,
  "x-accel-buffering": "no",
});

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

function json(value: unknown, status = 200): Response {
  return new Response(encode(value), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Protocol-2 routes answer with a frame. Every remaining one is connection
 * level — health, status, the WebSocket upgrade, SSE receiver credit — so the
 * frame never names an operation.
 */
function protocolError(error: unknown): Response {
  const outcome = outcomeFromError(error);
  const frame: ErrorMessage = { v: ACKERDB_VERSION, t: "err", id: null, outcome };
  return json(frame, outcomeHttpStatus(outcome));
}

function outcomeResponse(
  outcome: Outcome,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(standardJsonText(outcome), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/**
 * The exposed surface answers failures with the plain outcome, never a frame —
 * and in the standard JSON its document publishes, never the wire encoder the
 * connection-level routes above use.
 */
function outcomeError(error: unknown): Response {
  const outcome = outcomeFromError(error);
  return outcomeResponse(outcome, outcomeHttpStatus(outcome));
}

/**
 * A wrong method answers the same outcome shape, at the status and with the
 * `Allow` header HTTP mandates. No outcome code names a wrong method — the
 * status carries that — so this one is built rather than mapped.
 */
function methodNotAllowed(allow: string): Response {
  return outcomeResponse(
    { code: "malformed", retryable: false, message: `method not allowed; allow: ${allow}` },
    405,
    { allow },
  );
}

/**
 * The mutation receipt rides response headers so the body stays the plain
 * return value. It is state at response time: a pending obligation's later
 * durability transition belongs to the WebSocket protocol, not to this caller.
 * The empty obligation list omits its header outright: RFC 9110 permits an
 * empty field value, so serializers may carry one, and a caller reading `""`
 * cannot tell it from a malformed list.
 */
function receiptHeaders(receipt: HttpMutationReceipt): Record<string, string> {
  return {
    [RECEIPT_HEADERS.commitVersion]: String(receipt.commitVersion),
    [RECEIPT_HEADERS.durability]: receipt.durability,
    [RECEIPT_HEADERS.replay]: String(receipt.replay === "replayed"),
    ...(receipt.obligations.length === 0
      ? {}
      : { [RECEIPT_HEADERS.obligations]: receipt.obligations.join(",") }),
  };
}

/**
 * Every path-addressed call hands its encoded value to the same response shape.
 * No `Cache-Control` is emitted: caching policy belongs to the operator.
 */
const valueResponder: RuntimeHttpResponder = ({ body, status, receipt }) => new Response(body, {
  status,
  headers: {
    ...CORS,
    "content-type": "application/json; charset=utf-8",
    vary: VARY_AUTHORIZATION,
    ...(receipt === undefined ? {} : receiptHeaders(receipt)),
  },
});

function unavailableWhile(state: AckerDBServerState): AckerDBError {
  if (state === "draining") {
    return drainingError("server is draining", "connection");
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
    if (!Number.isFinite(deadlineAtMs)) {
      throw new RangeError("server shutdown deadline must be finite");
    }

    this.beginShutdown();
    this.drainPromise = this.performDrain(deadlineAtMs);
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
    // The application owns every path AckerDB has not reserved — `apiPath`
    // makes `/api/` one group among however many the application names — and
    // it answers the bare unavailable outcome before the registry that would
    // resolve it exists, even for a preflight, because a raw route's OPTIONS
    // belongs to its handler and no handler exists yet.
    if (
      (this.lifecycle !== "ready" || this.activeRuntime?.state !== "ready") &&
      !isAckerDBHttpRoute(url.pathname)
    ) {
      return outcomeError(unavailableWhile(this.lifecycle));
    }
    // Raw routes resolve before the listener's own OPTIONS answer: preflight
    // on a raw path is the handler's business when declared, a 405 otherwise.
    const rawRoute = this.activeRuntime?.registry.httpRoutes.get(url.pathname);
    if (rawRoute !== undefined) {
      if (!(rawRoute.fn.methods as readonly string[]).includes(request.method)) {
        return methodNotAllowed(rawRoute.fn.methods.join(", "));
      }
      return this.rawHandlerCall(request, rawRoute, this.requestSource(request, listener));
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname.startsWith(`${ACKERDB_HTTP_ROUTES.files}/`)) {
      if (this.lifecycle !== "ready" || this.activeRuntime?.state !== "ready") {
        return outcomeError(unavailableWhile(this.lifecycle));
      }
      return this.fileCall(request, this.requestSource(request, listener));
    }
    if (url.pathname === ACKERDB_HTTP_ROUTES.sseAck) {
      if (request.method !== "POST") return methodNotAllowed("POST");
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
    // A schema request is a copy of bytes the activation already assembled: it
    // takes no admission slot, no credential, and no runtime work. Unclaimed —
    // the default — the path falls through to the same 404 as any other.
    if (url.pathname === ACKERDB_HTTP_ROUTES.openapi && this.openapi !== null) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return new Response(this.openapi, {
        headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
      });
    }
    if (url.pathname === ACKERDB_HTTP_ROUTES.websocket) {
      return this.upgradeWebSocket(request, listener);
    }
    // An unexposed function falls through to the same 404 as a nonexistent
    // path: exposure is never discoverable by probing.
    const exposed = this.requireRuntime().registry.exposed.get(url.pathname);
    if (exposed !== undefined) {
      const methods = EXPOSED_HTTP_METHODS[exposed.kind];
      if (!methods.includes(request.method)) return methodNotAllowed(methods.join(", "));
      return this.call(request, url, exposed, this.requestSource(request, listener));
    }
    if (
      url.pathname === ACKERDB_HTTP_ROUTES.live ||
      url.pathname === ACKERDB_HTTP_ROUTES.ready ||
      url.pathname === ACKERDB_HTTP_ROUTES.status
    ) {
      return methodNotAllowed("GET");
    }
    // An unclaimed path answers the one shape every other failure here answers:
    // a caller decoding this surface meets `not_found`, never a plain-text body
    // its decoder reports as malformed — the mistake this surface makes most
    // likely is calling a function that was never given `http`.
    return outcomeError(new AckerDBError("not_found", "no route at this path"));
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

  private requestSource(request: Request, listener: Server<WsData>): TransportSource {
    const source = transportSource(listener.requestIP(request));
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
   * One raw handler call. The framework's part here is survival, not
   * semantics: admission and the byte bound run before the handler, and the
   * buffered Request then crosses whole — body bytes exact, every header
   * including Authorization. The handler's Response passes through unstamped;
   * only failures answer framework-authored bare Outcomes.
   */
  private async rawHandlerCall(
    request: Request,
    route: HttpHandlerRoute,
    source: TransportSource,
  ): Promise<Response> {
    const runtime = this.requireRuntime();
    let admission: HttpAdmissionLease | undefined;
    try {
      const fairnessKey = callerFairnessKey(ANONYMOUS_PRINCIPAL, source);
      admission = this.httpAdmission.admit(fairnessKey);
      const id = ++this.httpRequests;
      const body = request.body === null
        ? null
        : await readBoundedBytes(
            request,
            runtime.limits.maxRequestBytes,
            runtime.limits.readQueue.maxAgeMs,
          );
      const response = await runtime.runHttpHandler({
        address: route.address,
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
  private async fileCall(request: Request, source: TransportSource): Promise<Response> {
    const runtime = this.requireRuntime();
    let admission: HttpAdmissionLease | undefined;
    let lease: AuthLease | undefined;
    try {
      const anonymousKey = callerFairnessKey(ANONYMOUS_PRINCIPAL, source);
      admission = this.fileAdmission.admit(anonymousKey);
      const response = await runtime.runFileRequest({
        request,
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

  private upgradeWebSocket(request: Request, listener: Server<WsData>): Response | undefined {
    if (request.method !== "GET") return methodNotAllowed("GET");
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
