/** Compile-time contract for first-class File identity and `v.file()`. */
import {
  defineSchema,
  defineTable,
  v,
  type DbReader,
  type FileGrantId,
  type FileId,
  type FileMetadata,
  type FileMutationCapability,
  type FileState,
  type FileUploadSession,
  type Identity,
  type InferValidator,
} from "@ackerdb/server";
import type { MutationRef, QueryRef } from "@ackerdb/core";

const file = v.file();
const fileGrant = v.fileGrant();
const id = 1n as FileId;
const inferred: InferValidator<typeof file> = id;
const inferredGrant: InferValidator<typeof fileGrant> = 1n as FileGrantId;

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
const grantId = 1n as FileGrantId;
const state: FileState = "active";

// @ts-expect-error ordinary bigints are not branded File identities
const unbranded: FileId = 1n;
// @ts-expect-error ordinary bigints are not branded File Grant identities
const unbrandedGrant: FileGrantId = 1n;
// @ts-expect-error File and File Grant identities are distinct
const wrongGrantBrand: FileGrantId = id;
// @ts-expect-error File identity is not a general durable user Identity
const wrongBrand: import("@ackerdb/server").Identity = id;
// @ts-expect-error File lifecycle has no hidden terminal or failure state
const invalidState: FileState = "deleted";

void inferred;
void inferredGrant;
void metadata;
void session;
void grantId;
void state;
void unbranded;
void unbrandedGrant;
void wrongGrantBrand;
void wrongBrand;
void invalidState;

const schema = defineSchema({
  documents: defineTable({
    id: v.primaryKey(),
    file: v.file(),
    preview: v.file().nullable(),
    grant: v.fileGrant().nullable(),
  }).index(["file"]),
});
declare const db: DbReader<typeof schema>;

db.documents.query().where((row) => row.file.eq(id));
db.documents.query().where((row) => row.file.ne(id));
db.documents.query().where((row) => row.file.in([id]));
db.documents.query().where((row) => row.preview.eq(id).or(row.preview.isNull()));
db.documents.query().where((row) => row.grant.eq(grantId).or(row.grant.isNull()));

// @ts-expect-error equality keeps the FileId brand instead of accepting arbitrary bigint
db.documents.query().where((row) => row.file.eq(1n));
// @ts-expect-error File and File Grant identities cannot cross query columns
db.documents.query().where((row) => row.grant.eq(id));
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

files.createUploadSession({ expiresIn: "15m" });
files.revokeGrant(grantId);
files.revokeGrant(inferredGrant);

// @ts-expect-error Upload Session durations are unit-bearing strings
files.createUploadSession({ expiresIn: 15_000 });
// @ts-expect-error the old creation name was removed
files.createUpload({ expiresIn: "15m" });
// @ts-expect-error File identity cannot be used where a File Grant identity is required
files.revokeGrant(id);

files.query()
  .where((row) => row.owner.eq(owner).and(row.state.eq("active")))
  .orderBy((row) => row.createdAt.desc())
  .thenBy((row) => row.id.asc());
files.query().sum((row) => row.size);

// @ts-expect-error a File query predicate must come from the query row
files.query().where(() => true);
// @ts-expect-error ordinary query aggregate capabilities reject non-numeric columns
files.query().sum((row) => row.sha256);
// @ts-expect-error secondary ordering requires a primary orderBy
files.query().thenBy((row) => row.id.asc());

files.createUrl(id, {
  access: {
    type: "validated",
    authorize: authorizeDownload,
    args: { organizationId: 1n },
  },
  expiresIn: "15m",
});

files.createUrl(id, {
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

files.createUrl(id, {
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

files.createUrl(id, {
  access: {
    type: "validated",
    // @ts-expect-error validated Grants require a read-only query
    authorize: authorizeMutation,
    args: { organizationId: 1n },
  },
  permanent: true,
});

files.createUrl(id, {
  access: {
    type: "validated",
    // @ts-expect-error authorization queries must return boolean
    authorize: nonBooleanAuthorization,
    args: { organizationId: 1n },
  },
  permanent: true,
});

files.createUrl(id, {
  permanent: true,
  inline: true,
  filename: "preview.png",
});

// @ts-expect-error URL lifetime must be explicit
files.createUrl(id, {});
files.createUrl(id, {
  expiresIn: "15m",
  // @ts-expect-error URL lifetime cannot be both expiring and permanent
  permanent: true,
});
files.createUrl(id, {
  // @ts-expect-error URL durations are unit-bearing strings
  expiresIn: 15_000,
});
files.createUrl(id, {
  permanent: true,
  // @ts-expect-error nested disposition creation was removed
  disposition: { type: "inline" },
});
// @ts-expect-error the old creation name was removed
files.createGrant(id, { permanent: true });
