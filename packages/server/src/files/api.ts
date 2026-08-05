import type {
  FileId,
  FileMetadata,
  FileUploadSession,
  Identity,
  QueryRef,
} from "@ackerdb/core";
import type {
  OrderExpression,
  PredicateExpression,
  QueryMaterializers,
} from "../database/query/types.ts";

export type FileDuration = number | `${number}${"ms" | "s" | "m" | "h" | "d"}`;

export interface CreateFileUploadOptions {
  readonly maxBytes?: number;
  readonly contentTypes?: readonly string[];
  readonly expectedSha256?: string;
  readonly expiresIn?: FileDuration;
  /** Trusted server code may override automatic principal ownership. */
  readonly owner?: Identity | null;
}

type FileGrantAuthorizationArgs = { readonly fileId: FileId };

export type FileGrantAccess<
  Args extends FileGrantAuthorizationArgs = FileGrantAuthorizationArgs,
> =
  | { readonly type: "bearer" }
  | { readonly type: "authenticated" }
  | {
      readonly type: "validated";
      readonly authorize: QueryRef<Args, boolean>;
      readonly args: Omit<Args, "fileId">;
    };

export type FileGrantLifetime =
  | { readonly expiresIn: FileDuration; readonly permanent?: never }
  | { readonly permanent: true; readonly expiresIn?: never };

export type FileGrantDisposition =
  | { readonly type: "attachment"; readonly filename?: string }
  | { readonly type: "inline"; readonly filename?: string };

export type CreateFileGrantOptions<
  Args extends FileGrantAuthorizationArgs = FileGrantAuthorizationArgs,
> = FileGrantLifetime & {
  readonly access: FileGrantAccess<Args>;
  readonly disposition?: FileGrantDisposition;
};

export interface FileGrant {
  readonly id: bigint;
  readonly fileId: FileId;
  readonly url: string;
  readonly access: FileGrantAccess["type"];
  readonly expiresAt: number | null;
  readonly disposition: FileGrantDisposition;
  readonly createdAt: number;
}

/** Persisted Grant metadata; the bearer secret URL is intentionally absent. */
export type FileGrantMetadata = Omit<FileGrant, "url">;

export interface FileGrantMetadataQuery extends QueryMaterializers<FileGrantMetadata> {}

export type FileMetadataPredicate = PredicateExpression<FileMetadata>;

export interface FileMetadataQuery extends QueryMaterializers<FileMetadata> {
  where(predicate: (row: FileMetadataQueryRow) => FileMetadataPredicate): FileMetadataQuery;
  orderBy(order: (row: FileMetadataQueryRow) => OrderExpression): OrderedFileMetadataQuery;
}

export interface OrderedFileMetadataQuery extends QueryMaterializers<FileMetadata> {
  where(predicate: (row: FileMetadataQueryRow) => FileMetadataPredicate): OrderedFileMetadataQuery;
  thenBy(order: (row: FileMetadataQueryRow) => OrderExpression): OrderedFileMetadataQuery;
}

interface Comparable<Value> {
  eq(value: Value): FileMetadataPredicate;
  ne(value: Value): FileMetadataPredicate;
  in(values: readonly Value[]): FileMetadataPredicate;
  lt(value: Value): FileMetadataPredicate;
  lte(value: Value): FileMetadataPredicate;
  gt(value: Value): FileMetadataPredicate;
  gte(value: Value): FileMetadataPredicate;
  between(lower: Value, upper: Value): FileMetadataPredicate;
  asc(): OrderExpression;
  desc(): OrderExpression;
}

interface NullableComparable<Value> extends Comparable<Value> {
  isNull(): FileMetadataPredicate;
  isNotNull(): FileMetadataPredicate;
}

export interface FileMetadataQueryRow {
  readonly id: Comparable<FileId>;
  readonly state: Comparable<FileMetadata["state"]>;
  readonly owner: NullableComparable<Identity>;
  readonly size: Comparable<number>;
  readonly sha256: Comparable<string>;
  readonly contentType: NullableComparable<string>;
  readonly name: NullableComparable<string>;
  readonly createdAt: Comparable<number>;
}

export interface FileQueryCapability {
  get(fileId: FileId): Promise<FileMetadata | null>;
  query(): FileMetadataQuery;
  grants(fileId: FileId): FileGrantMetadataQuery;
}

export interface FileMutationCapability extends FileQueryCapability {
  createUpload(options?: CreateFileUploadOptions): Promise<FileUploadSession>;
  createGrant<Args extends FileGrantAuthorizationArgs>(
    fileId: FileId,
    options: CreateFileGrantOptions<Args>,
  ): Promise<FileGrant>;
  revokeGrant(grantId: bigint): Promise<void>;
  claim(fileId: FileId): Promise<void>;
  delete(fileId: FileId): Promise<void>;
}

export interface FileRange {
  readonly start: number;
  readonly end?: number;
}

export interface OpenedFile {
  readonly metadata: FileMetadata;
  readonly body: ReadableStream<Uint8Array>;
}

export interface StoreFileOptions {
  /** Exact stream length, required for one-pass filesystem and S3 writes. */
  readonly size: number;
  readonly name?: string;
  readonly contentType?: string;
  readonly owner?: Identity | null;
  readonly expectedSha256?: string;
}

export interface FileProcedureCapability {
  get(fileId: FileId): Promise<FileMetadata | null>;
  store(body: ReadableStream<Uint8Array>, options: StoreFileOptions): Promise<FileId>;
  open(fileId: FileId, options?: { readonly range?: FileRange }): Promise<OpenedFile>;
  bytes(fileId: FileId, options: { readonly maxBytes: number }): Promise<Uint8Array>;
}
