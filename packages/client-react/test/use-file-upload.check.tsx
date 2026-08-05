// Compile-time contract for useFileUpload. This file is typechecked and never
// executed; unused @ts-expect-error directives fail the package typecheck.
import type {
  AckerDBClientError,
  ClientResult,
} from "@ackerdb/client";
import {
  Status,
  type ApplicationError,
  type FileId,
  type FileUploadSession,
  type MutationRef,
} from "@ackerdb/core";
import {
  useFileUpload,
  type AckerDBFileUpload,
} from "@ackerdb/client-react";
import type { ReactNode } from "react";

type UploadDenied = ApplicationError<
  "upload-denied",
  { readonly folder: string },
  typeof Status.Forbidden
>;

declare const createUpload: MutationRef<
  { readonly folder: string },
  FileUploadSession,
  UploadDenied
>;
declare const wrongResult: MutationRef<{ readonly folder: string }, string>;

export function TypedFileUpload(): ReactNode {
  const upload = useFileUpload();
  const _publicShape: AckerDBFileUpload = upload;

  const result: Promise<ClientResult<FileId, UploadDenied>> = upload({
    createSession: createUpload,
    args: { folder: "contracts" },
    file: new Blob(["document"]),
    name: "contract.txt",
    contentType: "text/plain",
    signal: new AbortController().signal,
  });
  void upload({
    createSession: createUpload,
    args: { folder: "photos" },
    file: new Uint8Array([1, 2, 3]),
  });

  // @ts-expect-error createSession determines the exact argument shape
  void upload({ createSession: createUpload, args: { folder: 1 }, file: new Blob() });
  // @ts-expect-error a session mutation must return FileUploadSession
  void upload({ createSession: wrongResult, args: { folder: "x" }, file: new Blob() });
  // @ts-expect-error file bytes must be a reusable Blob or BufferSource
  void upload({ createSession: createUpload, args: { folder: "x" }, file: "bytes" });
  // @ts-expect-error presentation names are strings
  void upload({ createSession: createUpload, args: { folder: "x" }, file: new Blob(), name: 1 });

  const inspect = async (): Promise<void> => {
    const settled = await result;
    if (settled.ok) {
      const _fileId: FileId = settled.data;
      void _fileId;
      return;
    }
    const _error: UploadDenied | AckerDBClientError = settled.error;
    void _error;
  };
  void [inspect, _publicShape];
  return null;
}
