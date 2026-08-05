import type {
  AckerDBFileUploadBody,
  AckerDBFileUploadOptions,
  AckerDBFiles,
  ClientResult,
  FileId,
} from "@ackerdb/client";
import { decode, encode, type ApplicationError } from "@ackerdb/core";
import { callResultThroughCell, useLifetimeCall } from "./lifetime-call.ts";

/** Stable, fully typed File upload capability returned by {@link useFileUpload}. */
export type AckerDBFileUpload = AckerDBFiles["upload"];

function snapshotValue<T>(value: T): T {
  try {
    return decode(encode(value)) as T;
  } catch {
    return value;
  }
}

function isBlob(body: AckerDBFileUploadBody): body is Blob {
  return typeof Blob !== "undefined" && body instanceof Blob;
}

function snapshotBody(body: AckerDBFileUploadBody): AckerDBFileUploadBody {
  if (isBlob(body)) return body;
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice();
  }
  return new Uint8Array(body).slice();
}

function snapshotOptions<Args, Error extends ApplicationError>(
  options: AckerDBFileUploadOptions<Args, Error>,
): AckerDBFileUploadOptions<Args, Error> {
  return {
    createSession: options.createSession,
    args: snapshotValue(options.args),
    file: snapshotBody(options.file),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
  };
}

/**
 * The provider-owned client's typed upload operation. The callable stays stable
 * across renders and provider replacement; a call made before client arrival
 * keeps an immutable copy of reusable BufferSource bytes and honors its abort.
 */
export function useFileUpload(): AckerDBFileUpload {
  return useLifetimeCall(
    "useFileUpload",
    null,
    (cell): AckerDBFileUpload =>
      <Args, Error extends ApplicationError = never>(
        options: AckerDBFileUploadOptions<Args, Error>,
      ): Promise<ClientResult<FileId, Error>> => {
        const request = cell.client === null ? snapshotOptions(options) : options;
        return callResultThroughCell(
          cell,
          request,
          (client, value) => client.files.upload(value),
          options.signal === undefined
            ? undefined
            : { signal: options.signal, canceled: "File upload was canceled" },
        );
      },
  );
}
