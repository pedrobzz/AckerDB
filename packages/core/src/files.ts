import type { Identity } from "./identity.ts";

/** Durable application-facing identity of one immutable stored File. */
export type FileId = bigint & { readonly __ackerdbFileId: unique symbol };

/** The framework-owned lifecycle state of a File. */
export type FileState = "pending" | "active" | "deleting";

/** Public immutable metadata for one File; physical storage identity stays private. */
export interface FileMetadata {
  readonly id: FileId;
  readonly state: FileState;
  readonly owner: Identity | null;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string | null;
  readonly name: string | null;
  readonly createdAt: number;
}

/** Short-lived authority returned by an application mutation before raw upload. */
export interface FileUploadSession {
  readonly url: string;
  readonly expiresAt: number;
  readonly maxBytes: number;
}

/** Result returned after an upload session commits exactly one File. */
export interface FileUploadResult {
  readonly fileId: FileId;
}
