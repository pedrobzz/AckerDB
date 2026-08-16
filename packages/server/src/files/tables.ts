/** Framework-owned relational state for Files. Physical bytes live in FileStore. */
import { Schema, TableDef } from "../schema/definition.ts";
import { v } from "../validation/v.ts";

export const FILES_TABLE = "_ackerdb_files";
export const FILE_UPLOADS_TABLE = "_ackerdb_file_uploads";
export const FILE_GRANTS_TABLE = "_ackerdb_file_grants";
export const FILE_CLEANUP_TABLE = "_ackerdb_file_cleanup";

export const FILE_TABLES = Object.freeze([
  FILES_TABLE,
  FILE_UPLOADS_TABLE,
  FILE_GRANTS_TABLE,
  FILE_CLEANUP_TABLE,
] as const);

function filesTable(): TableDef {
  return new TableDef({
    id: v.primaryKey(),
    state: v.string(),
    objectKey: v.string(),
    owner: v.identity().nullable(),
    size: v.int(),
    sha256: v.string(),
    contentType: v.string().nullable(),
    name: v.string().nullable(),
    createdAt: v.float(),
    pendingExpiresAt: v.float().nullable(),
  }, "table")
    .index(["createdAt"])
    .index(["owner", "createdAt"])
    .index(["state", "createdAt"])
    .index(["state", "pendingExpiresAt"]) as TableDef;
}

function uploadsTable(): TableDef {
  return new TableDef({
    id: v.primaryKey(),
    secretHash: v.string(),
    state: v.string(),
    objectKey: v.string(),
    owner: v.identity().nullable(),
    maxBytes: v.int(),
    contentTypesJson: v.string().nullable(),
    expectedSha256: v.string().nullable(),
    expiresAt: v.float(),
    fileId: v.bigint().nullable(),
    attemptToken: v.string().nullable(),
    createdAt: v.float(),
  }, "table")
    .index(["state", "expiresAt"]) as TableDef;
}

function grantsTable(): TableDef {
  return new TableDef({
    id: v.primaryKey(),
    fileId: v.bigint(),
    secretHash: v.string(),
    accessType: v.string(),
    authorizeAddress: v.string().nullable(),
    authorizeArgsJson: v.string().nullable(),
    expiresAt: v.float().nullable(),
    dispositionType: v.string(),
    filename: v.string().nullable(),
    createdAt: v.float(),
  }, "table")
    .index(["fileId", "createdAt"])
    .index(["expiresAt"]) as TableDef;
}

function cleanupTable(): TableDef {
  return new TableDef({
    id: v.primaryKey(),
    objectKey: v.string(),
    fileId: v.bigint().nullable(),
    state: v.string(),
    attempt: v.int(),
    runAt: v.float(),
    leaseToken: v.string().nullable(),
    leaseUntil: v.float().nullable(),
    lastError: v.string().nullable(),
    createdAt: v.float(),
  }, "table")
    .index(["state", "runAt"])
    .index(["state", "leaseUntil"])
    .index(["createdAt"]) as TableDef;
}

/** The Files tables, as one framework schema contribution. */
export function filesSchema(): Schema {
  return new Schema({
    [FILES_TABLE]: filesTable(),
    [FILE_UPLOADS_TABLE]: uploadsTable(),
    [FILE_GRANTS_TABLE]: grantsTable(),
    [FILE_CLEANUP_TABLE]: cleanupTable(),
  }, new Map());
}
