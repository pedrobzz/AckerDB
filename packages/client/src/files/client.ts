import {
  Failure,
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
  ClientResult,
} from "../client.ts";

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
  readResponse(response: Response, signal: AbortSignal): Promise<string>;
  clientError(outcome: Outcome, interruption?: "suspension"): AckerDBClientError;
}

const MAX_FILE_ID = (1n << 63n) - 1n;

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

async function waitForFetch(
  request: Promise<Response>,
  signal: AbortSignal,
): Promise<Response> {
  const observed = request.then((response) => {
    if (!signal.aborted) return response;
    cancelResponse(response, signal.reason);
    throw signal.reason;
  });
  if (signal.aborted) {
    void observed.catch(() => {});
    throw signal.reason;
  }
  let rejectAborted!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(signal.reason);
  });
  const onAbort = (): void => rejectAborted();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([observed, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function waitForSession<Error extends ApplicationError>(
  request: Promise<ClientResult<FileUploadSession, Error>>,
  signal: AbortSignal | undefined,
): Promise<ClientResult<FileUploadSession, Error> | typeof SESSION_ABORTED> {
  if (signal === undefined) return request;
  if (signal.aborted) return SESSION_ABORTED;
  let resolveAborted!: () => void;
  const aborted = new Promise<typeof SESSION_ABORTED>((resolve) => {
    resolveAborted = () => resolve(SESSION_ABORTED);
  });
  const onAbort = (): void => resolveAborted();
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

/** Internal implementation behind the constructor-owned public `client.files` capability. */
export class AckerDBFilesClient implements AckerDBFiles {
  constructor(private readonly port: AckerDBFilesClientPort) {}

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
    if (options.signal?.aborted) {
      return uploadFailure<Error>(this.port.clientError({
        code: "unavailable",
        message: "File upload was canceled before sending bytes",
        retryable: false,
        resource: "operation",
      }));
    }

    const control = this.port.createFetchControl(options.signal);
    try {
      const headers = uploadHeaders(file, options);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await waitForFetch(
            Promise.resolve().then(() => this.port.fetch(session.data.url, {
              method: "PUT",
              headers,
              body: file,
              signal: control.signal,
            })),
            control.signal,
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
            return uploadFailure<Error>(this.port.clientError(outcome));
          }
          const text = await this.port.readResponse(response, control.signal);
          let fileId: FileId;
          try {
            fileId = fileIdFromResponse(text);
          } catch {
            if (attempt === 0) continue;
            return uploadFailure<Error>(this.port.clientError({
              code: "malformed",
              message: "File upload endpoint returned an invalid success response",
              retryable: false,
              resource: "idempotency",
            }));
          }
          return Ok<FileId, Error | AckerDBClientError>(fileId);
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
          if (attempt === 0) continue;
        }
      }
      return uploadFailure<Error>(this.port.clientError({
        code: "indeterminate",
        message: "File upload completion is unknown",
        retryable: false,
        resource: "idempotency",
      }));
    } catch {
      return uploadFailure<Error>(this.port.clientError({
        code: control.signal.aborted ? "indeterminate" : "unavailable",
        message: control.signal.aborted
          ? "File upload completion is unknown"
          : "File upload request failed",
        retryable: false,
        resource: "idempotency",
      }));
    } finally {
      control.release();
    }
  }
}
