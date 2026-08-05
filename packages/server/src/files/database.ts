import type { FileGrantId, FileId, Identity } from "@ackerdb/core";
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

type InsertRow<Row extends { readonly id: bigint }> = Omit<Row, "id">;
type PatchRow<Row extends { readonly id: bigint }> = Partial<InsertRow<Row>>;

export interface FileDatabaseQuery<Row> {
  where(predicate: (row: never) => unknown): FileDatabaseQuery<Row>;
  orderBy(order: (row: never) => unknown): FileDatabaseQuery<Row>;
  thenBy(order: (row: never) => unknown): FileDatabaseQuery<Row>;
  collect(): Promise<Row[]>;
  take(count: number): Promise<Row[]>;
  first(): Promise<Row | null>;
  unique(): Promise<Row | null>;
  count(): Promise<number>;
  sum(column: (row: never) => unknown): Promise<number | bigint>;
  avg(column: (row: never) => unknown): Promise<number | null>;
  min(column: (row: never) => unknown): Promise<unknown | null>;
  max(column: (row: never) => unknown): Promise<unknown | null>;
  iter(): AsyncIterable<Row>;
  paginate(options: { cursor?: string | null; pageSize: number }): Promise<{
    items: Row[];
    nextCursor: string | null;
  }>;
}

export interface FileDatabaseTable<Row extends { readonly id: bigint }> {
  get(id: bigint): Promise<Row | null>;
  insert(row: InsertRow<Row>): PromiseLike<Row["id"]>;
  patch(id: bigint, row: PatchRow<Row>): PromiseLike<void>;
  delete(id: bigint): PromiseLike<void>;
  deleteMany(ids: readonly bigint[]): Promise<number>;
  query(): FileDatabaseQuery<Row>;
}

export interface FileDatabase {
  readonly [FILES_TABLE]: FileDatabaseTable<FileRow>;
  readonly [FILE_UPLOADS_TABLE]: FileDatabaseTable<FileUploadRow>;
  readonly [FILE_GRANTS_TABLE]: FileDatabaseTable<FileGrantRow>;
  readonly [FILE_CLEANUP_TABLE]: FileDatabaseTable<FileCleanupRow>;
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
}): InsertRow<FileCleanupRow> {
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
