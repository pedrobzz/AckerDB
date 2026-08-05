# Files

AckerDB Files store immutable bytes behind an application-facing `FileId`.
Physical object keys stay private. Application tables own business metadata and
relationships, while independently revocable File grants own download access.

## Configure one FileStore

Every deployment has exactly one active backend. The default is a local store
under `.ackerdb/files` with a 1 GiB per-File limit:

```json
{
  "files": {
    "backend": "filesystem",
    "path": "./data/files",
    "publicUrl": "https://api.example.com",
    "maxBytes": 1073741824
  }
}
```

The generic S3 adapter uses familiar S3 options and works with AWS S3 or a
compatible service such as R2, MinIO, or Garage when that service implements
the probed PUT, HEAD, whole-GET, ranged-GET, and DELETE behavior:

```json
{
  "files": {
    "backend": "s3",
    "endpoint": "https://account.r2.cloudflarestorage.com",
    "region": "auto",
    "bucket": "documents",
    "forcePathStyle": true,
    "checksum": "disabled",
    "encryption": { "type": "disabled" },
    "publicUrl": "https://api.example.com",
    "maxBytes": 1073741824
  }
}
```

Omit `endpoint` for AWS. `checksum` defaults to `sha256`; encryption defaults
to `{ "type": "AES256" }` and may instead be `disabled` or `aws:kms` with an
optional `keyId` and `bucketKeyEnabled`. CLI deployments use the standard AWS
SDK credential provider chain, including `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`, profiles, and workload
roles. Credentials do not belong in `.ackerdb.config.json`. Programmatic
`S3FileStore` construction from `@ackerdb/server/files/s3` may provide an
explicit credential object. The adapter is a separate entrypoint so local-only
deployments do not load the AWS SDK.

`maxBytes` may be configured from one byte through the initial 5 GiB hard
ceiling. AckerDB probes the configured store before reporting startup ready.

## Reference Files from application data

Use direct `v.file()` columns. The nullable form is supported; arrays and
nested File validators are intentionally not. Use a normal join table for a
collection of Files.

```ts
const schema = defineSchema({
  documents: defineTable({
    id: v.primaryKey(),
    organizationId: v.bigint(),
    file: v.file(),
    preview: v.file().nullable(),
    title: v.string(),
  }).index(["organizationId"]),
});
```

This application row is also where custom metadata belongs. It receives the
ordinary schema validation, indexes, filters, authorization, and reactivity;
Files do not duplicate those facilities with arbitrary framework columns.

Writing a pending File into a declared `v.file()` column claims it atomically.
An intentionally standalone File can instead be claimed with
`ctx.files.claim(fileId)`. Replacing or removing a reference does not
automatically delete the previous File.

## Upload from a client

An application mutation authorizes the upload and creates its one-use Upload
Session:

```ts
export const createUpload = mutation({
  access: "authenticated",
  args: { organizationId: v.bigint() },
  handler: async (ctx, args) => {
    // Check membership in args.organizationId here.
    return ctx.files.createUpload({
      maxBytes: 100 * 1024 * 1024,
      contentTypes: ["application/pdf"],
      expiresIn: "15m",
    });
  },
});
```

The typed helper invokes that mutation and then sends the same raw streaming
`PUT` protocol used by every client:

```ts
const uploaded = await client.files.upload({
  createSession: api.documents.createUpload,
  args: { organizationId },
  file: browserFile,
});

if (!uploaded.ok) throw uploaded.error;
const fileId = uploaded.data;
```

The Upload Session creator becomes the immutable File owner. Giving its bearer
URL to another uploader does not transfer ownership. A raw client may `PUT`
the bytes to the session URL with an exact `Content-Length`, optionally
declaring `Content-Type` and `Content-Disposition`; success returns
`{ "fileId": "..." }`. Browser `Blob` and `File` uploads supply their known
length automatically. AckerDB deliberately uses one streaming S3 `PutObject`,
so an unknown-length stream must first be given a length by its producer;
multipart upload and hidden buffering or temporary staging are not initial
fallbacks.

Sessions expire after one hour by default and may only shorten that lifetime or
narrow the deployment byte limit. They may also require a lowercase SHA-256.
One session commits at most one File. Retrying after a lost success response
returns the same File identity. Completed uploads remain pending for 24 hours
until referenced or explicitly claimed, after which durable cleanup removes
abandoned bytes.

## Work with bytes in trusted backend code

Procedures, raw HTTP handlers, Services, and system runs can stream bytes.
Queries and mutations stay metadata-only so slow external I/O never holds the
database writer.

```ts
const fileId = await ctx.files.store(sourceStream, {
  size: expectedSize,
  expectedSha256,
  contentType: "application/pdf",
  name: "report.pdf",
});

const opened = await ctx.files.open(fileId, {
  range: { start: 0, end: 1023 }, // inclusive
});
for await (const chunk of opened.body) {
  // Process with bounded memory.
}

const small = await ctx.files.bytes(fileId, { maxBytes: 1024 * 1024 });
```

`store()` requires the exact `size` before consuming the stream and also
creates a pending File. `bytes()` rejects from immutable metadata before
allocating when the File exceeds its explicit memory budget.

## Query metadata and ownership

`ctx.files.get()` and `ctx.files.query()` are ordinary reactive database reads.
Public metadata contains `id`, `state`, optional `owner`, `size`, `sha256`,
optional untrusted `contentType` and `name`, and `createdAt`. It never exposes
the object key.

```ts
const page = await ctx.files
  .query()
  .where((file) => file.owner.eq(identity))
  .orderBy((file) => file.createdAt.desc())
  .paginate({ pageSize: 50 });
```

Initial indexes cover creation time, owner plus creation time, and lifecycle
state plus creation time. Queries do not silently filter by owner; application
authorization remains explicit.

## Create revocable URLs

Every download URL is a separate durable grant. Its lifetime must be explicit:

```ts
const temporary = await ctx.files.createGrant(fileId, {
  access: { type: "bearer" },
  expiresIn: "10m",
});

const permanent = await ctx.files.createGrant(fileId, {
  access: { type: "bearer" },
  permanent: true,
});
```

A short-lived bearer grant is the initial way to share a File with an agent.
Single-download consumption is deliberately not part of the initial contract.

An authenticated grant accepts any current AckerDB user identity:

```ts
await ctx.files.createGrant(fileId, {
  access: { type: "authenticated" },
  expiresIn: "1h",
});
```

For organization membership or another business rule, use a registered query.
It runs on every GET, HEAD, and range request under the request's normal bearer
principal:

```ts
export const canDownload = query({
  access: "authenticated",
  args: { organizationId: v.bigint(), fileId: v.file() },
  handler: async (ctx, args) => {
    return await isOrganizationMember(ctx, args.organizationId);
  },
});

const grant = await ctx.files.createGrant(fileId, {
  access: {
    type: "validated",
    authorize: api.files.canDownload,
    args: { organizationId },
  },
  expiresIn: "15m",
});
```

Use `ctx.files.revokeGrant(grant.id)` to revoke one URL. Grant listings expose
metadata but never the secret URL, which is returned only when created and is
stored only as a hash. Invalid, missing, expired, revoked, and unauthorized
grant requests all return 404.

Downloads proxy through AckerDB and support GET, HEAD, one byte range, ETag,
SHA-256 `Digest`, conditional requests, and request-start expiry. Responses use
`Cache-Control: no-store`. Presentation defaults to attachment plus `nosniff`;
an explicit inline disposition is accepted only for images other than SVG,
audio, video, and PDF.

## Delete, back up, and migrate

Application-owned lifecycle cleanup can be one mutation:

```ts
await ctx.db.documents.delete(documentId);
await ctx.files.delete(fileId);
```

Deletion immediately marks the File unavailable and revokes all grants. A
durable worker retries physical deletion and keeps the File visibly `deleting`
until the backend confirms it; the metadata row then disappears.

`acker backup` includes and verifies live File bytes by default.
`--metadata-only` is explicit and restore then verifies every File against the
independently restored active store before publishing the database. See
[Operations](operations.md#verified-backup-and-restore) for recovery and
[FileStore maintenance migration](operations.md#filestore-maintenance-migration)
for resumable offline backend changes.

Per-user and per-organization quotas remain application-owned indexed data.
The initial feature also omits direct provider URLs, multipart browser uploads,
deduplication, automatic reference cascades, and multiple active stores.
