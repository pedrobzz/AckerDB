import {
  Failure,
  MAX_RETRY_AFTER_MS,
  Ok,
  parseOutcome,
  type ApplicationError,
  type FileId,
  type FileUploadSession,
  type MutationRef,
  type Outcome,
} from "@ackerdb/core";
import type {
  AckerDBClientError,
  AckerDBClientScheduler,
  ClientResult,
} from "../client.ts";
import { raceWithAbort } from "../abort.ts";
import { retryDelay, type RetryPolicy } from "../connection/retry-policy.ts";

/** Reusable byte bodies keep an ambiguous upload safe to retry against its session. */
export type AckerDBFileUploadBody = Blob | BufferSource;

export interface AckerDBFileUploadOptions<
  Args,
  Error extends ApplicationError = never,
> {
  /** Application authorization boundary that creates this upload's bearer session. */
  readonly createSession: MutationRef<Args, FileUploadSession, Error>;
  readonly args: NoInfer<Args>;
  readonly file: AckerDBFileUploadBody;
  readonly signal?: AbortSignal;
  /** Overrides a browser File's untrusted presentation name. */
  readonly name?: string;
  /** Overrides a Blob or File's declared media type. */
  readonly contentType?: string;
}

export interface AckerDBFiles {
  upload<Args, Error extends ApplicationError = never>(
    options: AckerDBFileUploadOptions<Args, Error>,
  ): Promise<ClientResult<FileId, Error>>;
  /** Fetch a server-issued File grant through the configured server with a streaming body. */
  fetch(url: string, options?: {
    readonly signal?: AbortSignal;
    readonly method?: "GET" | "HEAD";
    readonly headers?: HeadersInit;
  }): Promise<Response>;
}

interface FileFetchControl {
  readonly signal: AbortSignal;
  release(): void;
}

const SESSION_ABORTED = Symbol("File upload session creation aborted");

export interface AckerDBFilesClientPort {
  mutation<Args, Error extends ApplicationError>(
    ref: MutationRef<Args, FileUploadSession, Error>,
    args: Args,
  ): Promise<ClientResult<FileUploadSession, Error>>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  createFetchControl(signal?: AbortSignal): FileFetchControl;
  authorizationHeaders(): HeadersInit;
  readonly httpOrigin: string;
  readonly scheduler: AckerDBClientScheduler;
  readonly random: () => number;
  readResponse(response: Response, signal: AbortSignal): Promise<string>;
  clientError(outcome: Outcome, interruption?: "suspension"): AckerDBClientError;
}

const MAX_FILE_ID = (1n << 63n) - 1n;
const UPLOAD_RETRY_BASE_MS = 250;
const UPLOAD_RETRY_MAX_MS = 5_000;

function fileRouteUrl(
  value: string,
  httpOrigin: string,
  route: "uploads" | "grants",
): string {
  const label = route === "uploads" ? "upload session" : "grant";
  const shape = route === "uploads" ? "upload" : "grant";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`File ${label} URL must be an absolute HTTP URL`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.startsWith(`/_files/${route}/`)
  ) {
    throw new TypeError(`File ${label} URL has an invalid AckerDB ${shape} shape`);
  }
  return new URL(url.pathname, httpOrigin).href;
}

function uploadFailure<Error extends ApplicationError>(
  error: Error | AckerDBClientError,
): ClientResult<FileId, Error> {
  return Failure<Error | AckerDBClientError, FileId>(error) as unknown as ClientResult<
    FileId,
    Error
  >;
}

function fileIdFromResponse(text: string): FileId {
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, "fileId")
  ) {
    throw new TypeError("upload response must contain only fileId");
  }
  const fileId = Reflect.get(value, "fileId");
  if (typeof fileId !== "string" || !/^[1-9]\d*$/.test(fileId)) {
    throw new TypeError("upload fileId must be a positive decimal string");
  }
  const parsed = BigInt(fileId);
  if (parsed > MAX_FILE_ID) throw new TypeError("upload fileId exceeds signed 64-bit range");
  return parsed as FileId;
}

function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function isBlob(body: AckerDBFileUploadBody): body is Blob {
  return typeof Blob !== "undefined" && body instanceof Blob;
}

function fileName(body: AckerDBFileUploadBody): string | undefined {
  if (!isBlob(body)) return undefined;
  const name = Reflect.get(body, "name");
  return typeof name === "string" ? name : undefined;
}

function uploadHeaders(
  body: AckerDBFileUploadBody,
  options: AckerDBFileUploadOptions<unknown, ApplicationError>,
): Headers {
  const headers = new Headers();
  const contentType = options.contentType ?? (isBlob(body) ? body.type : undefined);
  const name = options.name ?? fileName(body);
  if (contentType) headers.set("content-type", contentType);
  if (name !== undefined) {
    headers.set("content-disposition", `attachment; filename*=UTF-8''${rfc5987(name)}`);
  }
  return headers;
}

function cancelResponse(response: Response, reason: unknown): void {
  if (!response.body) return;
  try {
    void response.body.cancel(reason).catch(() => {});
  } catch {
    // A late external response cannot regain ownership from cancellation.
  }
}

function lifecycleInterruption(signal: AbortSignal): "suspension" | undefined {
  const reason = signal.reason;
  return typeof reason === "object" &&
      reason !== null &&
      Reflect.get(reason, "interruption") === "suspension"
    ? "suspension"
    : undefined;
}

async function waitForSession<Error extends ApplicationError>(
  request: Promise<ClientResult<FileUploadSession, Error>>,
  signal: AbortSignal | undefined,
): Promise<ClientResult<FileUploadSession, Error> | typeof SESSION_ABORTED> {
  if (signal === undefined) return request;
  if (signal.aborted) return SESSION_ABORTED;
  const { promise: aborted, resolve: resolveAborted } =
    Promise.withResolvers<typeof SESSION_ABORTED>();
  const onAbort = (): void => resolveAborted(SESSION_ABORTED);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    // The durable mutation is not canceled: if it commits after the caller
    // leaves, its unused Upload Session expires through normal cleanup. The
    // race only releases caller ownership promptly and keeps the late promise
    // observed.
    return await Promise.race([request, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function responseRetryAfterMs(response: Response, now: number): number {
  const header = response.headers.get("retry-after")?.trim();
  if (header === undefined || header === "" || header.length > 64) return 0;
  let delayMs: number;
  if (/^\d+$/.test(header)) {
    delayMs = Number(header) * 1_000;
  } else {
    const at = Date.parse(header);
    if (!Number.isFinite(at)) return 0;
    delayMs = Math.max(0, at - now);
  }
  return Math.min(Number.isFinite(delayMs) ? delayMs : MAX_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS);
}

const UPLOAD_RETRY_POLICY: RetryPolicy = Object.freeze({
  baseDelayMs: UPLOAD_RETRY_BASE_MS,
  maxDelayMs: UPLOAD_RETRY_MAX_MS,
});

/**
 * The same full-jitter schedule reconnect uses, over the upload's own base and
 * cap, floored by the server's `Retry-After` and capped by what is left of the
 * caller's deadline.
 */
function uploadRetryDelay(
  backoffStep: number,
  remainingMs: number,
  retryAfterMs: number,
  random: () => number,
): number {
  return Math.min(
    retryDelay(UPLOAD_RETRY_POLICY, backoffStep, retryAfterMs, random, MAX_RETRY_AFTER_MS),
    remainingMs,
  );
}

function waitForRetry(
  scheduler: AckerDBClientScheduler,
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const handle = scheduler.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      scheduler.clearTimeout(handle);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Transfer response-body ownership to a stream that releases the client lifecycle on termination. */
function managedStreamingResponse(response: Response, control: FileFetchControl): Response {
  if (response.body === null) {
    control.release();
    return response;
  }
  const reader = response.body.getReader();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let finished = false;
  const release = (): void => {
    if (finished) return;
    finished = true;
    control.signal.removeEventListener("abort", onAbort);
    control.release();
  };
  const onAbort = (): void => {
    if (finished) return;
    const reason = control.signal.reason;
    release();
    void reader.cancel(reason).catch(() => {});
    streamController?.error(reason);
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      control.signal.addEventListener("abort", onAbort, { once: true });
      if (control.signal.aborted) onAbort();
    },
    async pull(controller) {
      if (finished) return;
      try {
        const part = await reader.read();
        if (finished) return;
        if (part.done) {
          release();
          controller.close();
        } else {
          controller.enqueue(part.value);
        }
      } catch (error) {
        if (finished) return;
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (finished) return;
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Internal implementation behind the constructor-owned public `client.files` capability. */
export class AckerDBFilesClient implements AckerDBFiles {
  constructor(private readonly port: AckerDBFilesClientPort) {}

  async fetch(
    url: string,
    options: {
      readonly signal?: AbortSignal;
      readonly method?: "GET" | "HEAD";
      readonly headers?: HeadersInit;
    } = {},
  ): Promise<Response> {
    if (options.signal?.aborted) throw options.signal.reason;
    const method = options.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      throw new TypeError("File grant fetch method must be GET or HEAD");
    }
    const grantUrl = fileRouteUrl(url, this.port.httpOrigin, "grants");
    const control = this.port.createFetchControl(options.signal);
    try {
      const headers = new Headers(options.headers);
      const authorization = new Headers(this.port.authorizationHeaders()).get("authorization");
      if (authorization === null) headers.delete("authorization");
      else headers.set("authorization", authorization);
      const response = await raceWithAbort(
        Promise.resolve().then(() => this.port.fetch(grantUrl, {
          method,
          headers,
          signal: control.signal,
          credentials: "omit",
          redirect: "error",
        })),
        control.signal,
        () => control.signal.reason,
        (late) => cancelResponse(late, control.signal.reason),
      );
      return managedStreamingResponse(response, control);
    } catch (error) {
      control.release();
      throw error;
    }
  }

  async upload<Args, Error extends ApplicationError = never>(
    options: AckerDBFileUploadOptions<Args, Error>,
  ): Promise<ClientResult<FileId, Error>> {
    if (options.signal?.aborted) {
      return uploadFailure<Error>(this.port.clientError({
        code: "unavailable",
        message: "File upload was canceled before creating a session",
        retryable: false,
        resource: "operation",
      }));
    }
    const { createSession, args, file } = options;
    const session = await waitForSession(
      this.port.mutation(createSession, args),
      options.signal,
    );
    if (session === SESSION_ABORTED) {
      return uploadFailure<Error>(this.port.clientError({
        code: "unavailable",
        message: "File upload was canceled while creating a session",
        retryable: false,
        resource: "operation",
      }));
    }
    if (!session.ok) return uploadFailure<Error>(session.error);
    let uploadUrl: string;
    try {
      uploadUrl = fileRouteUrl(session.data.url, this.port.httpOrigin, "uploads");
    } catch {
      return uploadFailure<Error>(this.port.clientError({
        code: "malformed",
        message: "Upload Session returned an invalid AckerDB upload URL",
        retryable: false,
        resource: "operation",
      }));
    }
    if (options.signal?.aborted) {
      return uploadFailure<Error>(this.port.clientError({
        code: "unavailable",
        message: "File upload was canceled before sending bytes",
        retryable: false,
        resource: "operation",
      }));
    }

    const remainingSessionMs = session.data.expiresAt - this.port.scheduler.now();
    if (!(remainingSessionMs > 0)) {
      return uploadFailure<Error>(this.port.clientError({
        code: "unavailable",
        message: "File upload session expired before sending bytes",
        retryable: true,
        resource: "operation",
      }));
    }
    const control = this.port.createFetchControl(options.signal);
    let attempted = false;
    try {
      const headers = uploadHeaders(file, options);
      let backoffStep = 0;
      for (;;) {
        if (this.port.scheduler.now() >= session.data.expiresAt) {
          return uploadFailure<Error>(this.port.clientError({
            code: attempted ? "indeterminate" : "unavailable",
            message: attempted
              ? "File upload completion is unknown after its session expired"
              : "File upload session expired before sending bytes",
            retryable: !attempted,
            resource: attempted ? "idempotency" : "operation",
          }));
        }
        attempted = true;
        let retryAfterMs = 0;
        try {
          const response = await raceWithAbort(
            Promise.resolve().then(() => this.port.fetch(uploadUrl, {
              method: "PUT",
              headers,
              body: file,
              signal: control.signal,
            })),
            control.signal,
            () => control.signal.reason,
            (late) => cancelResponse(late, control.signal.reason),
          );
          if (!response.ok) {
            let outcome: Outcome;
            try {
              const text = await this.port.readResponse(response, control.signal);
              outcome = parseOutcome(JSON.parse(text));
            } catch {
              if (control.signal.aborted) throw control.signal.reason;
              return uploadFailure<Error>(this.port.clientError({
                code: "malformed",
                message: "File upload endpoint returned an invalid error response",
                retryable: false,
                resource: "idempotency",
              }));
            }
            if (!outcome.retryable) {
              return uploadFailure<Error>(this.port.clientError(outcome));
            }
            retryAfterMs = Math.max(
              outcome.retryAfterMs ?? 0,
              responseRetryAfterMs(response, this.port.scheduler.now()),
            );
          }
          if (response.ok) {
            try {
              const text = await this.port.readResponse(response, control.signal);
              return Ok<FileId, Error | AckerDBClientError>(fileIdFromResponse(text));
            } catch {
              if (control.signal.aborted) throw control.signal.reason;
            }
          }
        } catch {
          if (control.signal.aborted) {
            return uploadFailure<Error>(this.port.clientError(
              {
                code: "indeterminate",
                message: "File upload completion is unknown",
                retryable: false,
                resource: "idempotency",
              },
              lifecycleInterruption(control.signal),
            ));
          }
        }
        const remaining = session.data.expiresAt - this.port.scheduler.now();
        if (!(remaining > 0)) continue;
        const delayMs = uploadRetryDelay(backoffStep, remaining, retryAfterMs, this.port.random);
        backoffStep++;
        await waitForRetry(this.port.scheduler, delayMs, control.signal);
      }
    } catch {
      return uploadFailure<Error>(this.port.clientError({
        code: attempted ? "indeterminate" : "unavailable",
        message: attempted
          ? "File upload completion is unknown"
          : "File upload request failed",
        retryable: false,
        resource: attempted ? "idempotency" : "operation",
      }, lifecycleInterruption(control.signal)));
    } finally {
      control.release();
    }
  }
}
