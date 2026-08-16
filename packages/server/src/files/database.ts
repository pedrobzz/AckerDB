import type { FileGrantId, FileId, Identity } from "@ackerdb/core";
import type { ManagedInsert, ManagedTable } from "../database/managed.ts";
import {
  FILE_CLEANUP_TABLE,
  FILE_GRANTS_TABLE,
  FILE_UPLOADS_TABLE,
  FILES_TABLE,
} from "./tables.ts";

export interface FileRow {
  readonly id: FileId;
  readonly state: "pending" | "active" | "deleting";
  readonly objectKey: string;
  readonly owner: Identity | null;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string | null;
  readonly name: string | null;
  readonly createdAt: number;
  readonly pendingExpiresAt: number | null;
}

export interface FileUploadRow {
  readonly id: bigint;
  readonly secretHash: string;
  readonly state: "open" | "uploading" | "committed";
  readonly objectKey: string;
  readonly owner: Identity | null;
  readonly maxBytes: number;
  readonly contentTypesJson: string | null;
  readonly expectedSha256: string | null;
  readonly expiresAt: number;
  readonly fileId: FileId | null;
  readonly attemptToken: string | null;
  readonly createdAt: number;
}

export interface FileGrantRow {
  readonly id: FileGrantId;
  readonly fileId: FileId;
  readonly secretHash: string;
  readonly accessType: "bearer" | "authenticated" | "validated";
  readonly authorizeAddress: string | null;
  readonly authorizeArgsJson: string | null;
  readonly expiresAt: number | null;
  readonly dispositionType: "attachment" | "inline";
  readonly filename: string | null;
  readonly createdAt: number;
}

export interface FileCleanupRow {
  readonly id: bigint;
  readonly objectKey: string;
  readonly fileId: FileId | null;
  readonly state: "staging" | "pending" | "running";
  readonly attempt: number;
  readonly runAt: number;
  readonly leaseToken: string | null;
  readonly leaseUntil: number | null;
  readonly lastError: string | null;
  readonly createdAt: number;
}

export interface FileDatabase {
  readonly [FILES_TABLE]: ManagedTable<FileRow>;
  readonly [FILE_UPLOADS_TABLE]: ManagedTable<FileUploadRow>;
  readonly [FILE_GRANTS_TABLE]: ManagedTable<FileGrantRow>;
  readonly [FILE_CLEANUP_TABLE]: ManagedTable<FileCleanupRow>;
}

/** Runtime table validation has already decoded these rows at this seam. */
export function fileDatabase(value: unknown): FileDatabase {
  return value as FileDatabase;
}

export function pendingCleanupRow(input: {
  readonly objectKey: string;
  readonly fileId: FileId | null;
  readonly now: number;
  readonly lastError: string | null;
}): ManagedInsert<FileCleanupRow> {
  return {
    objectKey: input.objectKey,
    fileId: input.fileId,
    state: "pending",
    attempt: 0,
    runAt: input.now,
    leaseToken: null,
    leaseUntil: null,
    lastError: input.lastError,
    createdAt: input.now,
  };
}

export function storedFileError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_048);
}
