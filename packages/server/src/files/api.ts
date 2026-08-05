import type {
  FileGrantId,
  FileId,
  FileMetadata,
  FileUploadSession,
  Identity,
  QueryRef,
} from "@ackerdb/core";
import type {
  OrderedTableQuery,
  QueryMaterializers,
  TableQuery,
} from "../database/query/types.ts";
import type {
  NullableValidator,
  StandardValidator,
} from "../validation/validator.ts";

export type FileDuration = `${number}${"ms" | "s" | "m" | "h" | "d"}`;

export interface CreateFileUploadSessionOptions {
  readonly maxBytes?: number;
  readonly contentTypes?: readonly string[];
  readonly expectedSha256?: string;
  readonly expiresIn?: FileDuration;
  /** Trusted server code may override automatic principal ownership. */
  readonly owner?: Identity | null;
}

type FileGrantAuthorizationArgs = { readonly fileId: FileId };

/** URL access policy: possession, a signed-in user, or an application query decision. */
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

export type CreateFileUrlOptions<
  Args extends FileGrantAuthorizationArgs = FileGrantAuthorizationArgs,
> = FileGrantLifetime & {
  readonly access?: FileGrantAccess<Args>;
  readonly inline?: boolean;
  readonly filename?: string;
};

export interface FileGrant {
  readonly id: FileGrantId;
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

/** Public projection of the private framework table, expressed through the ordinary query DSL. */
type FileMetadataColumns = {
  readonly id: StandardValidator<FileId, "pk">;
  readonly state: StandardValidator<FileMetadata["state"], "string">;
  readonly owner: NullableValidator<StandardValidator<Identity, "identity">>;
  readonly size: StandardValidator<number, "int">;
  readonly sha256: StandardValidator<string, "string">;
  readonly contentType: NullableValidator<StandardValidator<string, "string">>;
  readonly name: NullableValidator<StandardValidator<string, "string">>;
  readonly createdAt: StandardValidator<number, "float">;
};

export type FileMetadataQuery = TableQuery<FileMetadataColumns, FileMetadata>;
export type OrderedFileMetadataQuery = OrderedTableQuery<FileMetadataColumns, FileMetadata>;

export interface FileQueryCapability {
  get(fileId: FileId): Promise<FileMetadata | null>;
  query(): FileMetadataQuery;
  grants(fileId: FileId): FileGrantMetadataQuery;
}

export interface FileMutationCapability extends FileQueryCapability {
  createUploadSession(options?: CreateFileUploadSessionOptions): Promise<FileUploadSession>;
  createUrl<Args extends FileGrantAuthorizationArgs = FileGrantAuthorizationArgs>(
    fileId: FileId,
    options: CreateFileUrlOptions<Args>,
  ): Promise<FileGrant>;
  revokeGrant(grantId: FileGrantId): Promise<void>;
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
