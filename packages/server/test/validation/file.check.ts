/** Compile-time contract for first-class File identity and `v.file()`. */
import {
  defineSchema,
  defineTable,
  v,
  type DbReader,
  type FileId,
  type FileMetadata,
  type FileMutationCapability,
  type FileState,
  type FileUploadResult,
  type FileUploadSession,
  type Identity,
  type InferValidator,
} from "@ackerdb/server";
import type { MutationRef, QueryRef } from "@ackerdb/core";

const file = v.file();
const id = 1n as FileId;
const inferred: InferValidator<typeof file> = id;

const metadata: FileMetadata = {
  id,
  state: "pending",
  owner: null,
  size: 3,
  sha256: "abc",
  contentType: null,
  name: null,
  createdAt: 1,
};
const session: FileUploadSession = {
  url: "https://example.invalid/upload",
  expiresAt: 2,
  maxBytes: 3,
};
const result: FileUploadResult = { fileId: id };
const state: FileState = "active";

// @ts-expect-error ordinary bigints are not branded File identities
const unbranded: FileId = 1n;
// @ts-expect-error File identity is not a general durable user Identity
const wrongBrand: import("@ackerdb/server").Identity = id;
// @ts-expect-error File lifecycle has no hidden terminal or failure state
const invalidState: FileState = "deleted";

void inferred;
void metadata;
void session;
void result;
void state;
void unbranded;
void wrongBrand;
void invalidState;

const schema = defineSchema({
  documents: defineTable({
    id: v.primaryKey(),
    file: v.file(),
    preview: v.file().nullable(),
  }).index(["file"]),
});
declare const db: DbReader<typeof schema>;

db.documents.query().where((row) => row.file.eq(id));
db.documents.query().where((row) => row.file.ne(id));
db.documents.query().where((row) => row.file.in([id]));
db.documents.query().where((row) => row.preview.eq(id).or(row.preview.isNull()));

// @ts-expect-error equality keeps the FileId brand instead of accepting arbitrary bigint
db.documents.query().where((row) => row.file.eq(1n));
// @ts-expect-error File identity supports equality, not numeric range predicates
db.documents.query().where((row) => row.file.lt(id));
// @ts-expect-error File identity is not an ordering key
db.documents.query().orderBy((row) => row.file.asc());

declare const files: FileMutationCapability;
declare const owner: Identity;
declare const authorizeDownload: QueryRef<{
  readonly organizationId: bigint;
  readonly fileId: FileId;
}, boolean>;
declare const authorizeMutation: MutationRef<{
  readonly organizationId: bigint;
  readonly fileId: FileId;
}, boolean>;
declare const nonBooleanAuthorization: QueryRef<{
  readonly organizationId: bigint;
  readonly fileId: FileId;
}, string>;

files.query()
  .where((row) => row.owner.eq(owner).and(row.state.eq("active")))
  .orderBy((row) => row.createdAt.desc())
  .thenBy((row) => row.id.asc());

// @ts-expect-error a File query predicate must come from the query row
files.query().where(() => true);
// @ts-expect-error secondary ordering requires a primary orderBy
files.query().thenBy((row) => row.id.asc());

files.createGrant(id, {
  access: {
    type: "validated",
    authorize: authorizeDownload,
    args: { organizationId: 1n },
  },
  expiresIn: "15m",
});

files.createGrant(id, {
  access: {
    type: "validated",
    authorize: authorizeDownload,
    args: {
      // @ts-expect-error validated Grant arguments are inferred from the authorization query
      organizationId: "1",
    },
  },
  permanent: true,
});

files.createGrant(id, {
  access: {
    type: "validated",
    authorize: authorizeDownload,
    args: {
      organizationId: 1n,
      // @ts-expect-error fileId is supplied by the framework at authorization time
      fileId: id,
    },
  },
  permanent: true,
});

files.createGrant(id, {
  access: {
    type: "validated",
    // @ts-expect-error validated Grants require a read-only query
    authorize: authorizeMutation,
    args: { organizationId: 1n },
  },
  permanent: true,
});

files.createGrant(id, {
  access: {
    type: "validated",
    // @ts-expect-error authorization queries must return boolean
    authorize: nonBooleanAuthorization,
    args: { organizationId: 1n },
  },
  permanent: true,
});

// @ts-expect-error Grant lifetime must be explicit
files.createGrant(id, { access: { type: "bearer" } });
files.createGrant(id, {
  access: { type: "bearer" },
  expiresIn: "15m",
  // @ts-expect-error Grant lifetime cannot be both expiring and permanent
  permanent: true,
});
