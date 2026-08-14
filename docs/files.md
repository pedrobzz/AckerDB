# Files

AckerDB Files give immutable bytes a typed `FileId`. They work locally with no
configuration: the CLI stores bytes under `.ackerdb/files`, keeps object keys
private, and defaults to a 1 GiB per-File limit.

The common path is deliberately short:

1. Put a `v.file()` reference in an application table.
2. Let an authenticated mutation create an Upload Session.
3. Upload with `client.files.upload()`.
4. Save the returned `FileId` and create a URL in one mutation.

## A complete profile-image example

Keep application metadata and relationships in an ordinary table. They retain
normal validation, indexes, authorization, and reactivity.

```ts
const schema = defineSchema({
  profiles: defineTable({
    id: v.primaryKey(),
    userId: v.identity(),
    avatar: v.file().nullable(),
    avatarUrl: v.string().nullable(),
  }).index(["userId"], { unique: true }),
});
```

The first mutation authorizes the upload. The second creates a permanent public
URL and saves the application row. `createUrl()` automatically claims a pending
File, and writing it to a declared `v.file()` column does the same, so no
separate claim step is needed.

```ts
export const createAvatarUpload = mutation({
  access: "authenticated",
  args: {},
  handler: async (ctx) => {
    if (ctx.auth.kind !== "user") throw new Error("user required");
    return ctx.files.createUploadSession({
      maxBytes: 10 * 1024 * 1024,
      contentTypes: ["image/jpeg", "image/png", "image/webp"],
    });
  },
});

export const saveAvatar = mutation({
  access: "authenticated",
  args: { fileId: v.file() },
  handler: async (ctx, { fileId }) => {
    if (ctx.auth.kind !== "user") throw new Error("user required");
    const file = await ctx.files.get(fileId);
    if (file?.owner !== ctx.auth.identity) throw new Error("File not owned by user");

    const previous = await ctx.db.profiles
      .query()
      .where((profile) => profile.userId.eq(ctx.auth.identity))
      .unique();
    if (previous?.avatar === fileId && previous.avatarUrl !== null) {
      return previous.avatarUrl;
    }
    const avatar = await ctx.files.createUrl(fileId, {
      permanent: true,
      inline: true,
    });

    if (previous === null) {
      await ctx.db.profiles.insert({
        userId: ctx.auth.identity,
        avatar: fileId,
        avatarUrl: avatar.url,
      });
    } else {
      await ctx.db.profiles.patch(previous.id, {
        avatar: fileId,
        avatarUrl: avatar.url,
      });
      // This example gives each profile image exclusive ownership of its File.
      if (previous.avatar !== null && previous.avatar !== fileId) {
        await ctx.files.delete(previous.avatar);
      }
    }

    return avatar.url;
  },
});
```

Upload from any typed client:

```ts
const uploaded = await client.files.upload({
  createSession: api.profiles.createAvatarUpload,
  args: {},
  file: browserFile,
});
if (!uploaded.ok) throw uploaded.error;

const saved = await client.mutation(api.profiles.saveAvatar, {
  fileId: uploaded.data,
});
if (!saved.ok) throw saved.error;
```

The URL is an ordinary unauthenticated bearer URL, so browser elements work
without a cookie, proxy, custom header, object URL, or framework component:

```tsx
<img src={profile.avatarUrl} alt="Profile" />
```

Anyone who receives that URL can read the File until it is revoked or the File
is deleted. That is the intended simple choice for profile images and other
public media. Use an expiring URL for temporary sharing, or an authenticated or
validated URL for programmatic private downloads.

## Upload Sessions

An Upload Session is one-use bearer authority for one successful upload. A
session created under a user or MCP principal captures that principal's durable
Identity as the immutable File owner, even if someone else receives and uses
the upload URL. Anonymous, workload, and system creation is unowned unless
trusted code supplies `owner` explicitly.

```ts
return ctx.files.createUploadSession({
  maxBytes: 100 * 1024 * 1024,
  contentTypes: ["application/pdf"],
  expectedSha256,
  expiresIn: "15m",
});
```

The deployment owns the maximum size. A session may only narrow that limit and
may only shorten the default one-hour lifetime. Durations are explicit strings
such as `"30s"`, `"15m"`, and `"1h"`.

`client.files.upload()` invokes the application mutation and then sends the raw
streaming `PUT`. It keeps retrying an ambiguous completion against the same
idempotent session until success, cancellation, or session expiry; a retry after
a committed upload returns the same `FileId` rather than creating a duplicate.
The helper routes the Upload Session path through the client's configured
AckerDB origin, so a React Native device, container, LAN client, or tunnel never
mistakes the server's `127.0.0.1` for its own device.

A raw client may instead `PUT` bytes to `session.url` with an exact
`Content-Length` and optional `Content-Disposition`. `Content-Type` is optional
unless the Upload Session restricts `contentTypes`; then it is required and must
exactly match one of the declared values. Pass `contentType` explicitly when a
`BufferSource` or browser `File` does not declare one.

The typed mutation result must be checked before using its Upload Session:

```ts
const session = await client.mutation(api.documents.createUpload, {
  organizationId,
});
if (!session.ok) throw session.error;

const response = await fetch(session.data.url, {
  method: "PUT",
  headers: { "Content-Type": "application/pdf" },
  body: file,
});
if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
```

Success returns `{ "fileId": "..." }`. Browser `Blob` and `File` values already
have a known length. The initial protocol deliberately uses one streaming S3
object write rather than multipart upload or hidden temporary buffering.

Completed uploads remain pending for 24 hours. Saving one in a direct
`v.file()` or `v.file().nullable()` column, or calling `createUrl()`, claims it
automatically in the same transaction. Use `ctx.files.claim(fileId)` only for an
intentionally standalone File. Unclaimed pending bytes are durably cleaned up.

Collections use a normal join table. Nested or array File validators and
arbitrary framework metadata columns are intentionally absent.

## Create URLs

Every URL is an independently revocable durable Grant. Bearer access is the
default, so a public or shareable URL needs only an explicit lifetime:

```ts
const temporary = await ctx.files.createUrl(fileId, { expiresIn: "10m" });
const permanent = await ctx.files.createUrl(fileId, { permanent: true });
const image = await ctx.files.createUrl(fileId, {
  permanent: true,
  inline: true,
});
```

`inline: true` is accepted only for images other than SVG, audio, video, and
PDF. Otherwise delivery defaults to a safe attachment. `filename` optionally
overrides the attachment name without changing immutable File metadata.

For a URL that accepts any current signed-in AckerDB user:

```ts
await ctx.files.createUrl(fileId, {
  access: { type: "authenticated" },
  expiresIn: "1h",
});
```

For organization membership or another application rule, register a read-only
authorization function. It runs for every retrieval with the request's normal
principal, and its arguments remain typed:

```ts
export const canDownload = query({
  access: "authenticated",
  args: { organizationId: v.bigint(), fileId: v.file() },
  handler: async (ctx, args) => {
    return await isOrganizationMember(ctx, args.organizationId);
  },
});

const url = await ctx.files.createUrl(fileId, {
  access: {
    type: "validated",
    authorize: api.files.canDownload,
    args: { organizationId },
  },
  expiresIn: "15m",
});
```

Authenticated and validated URLs require the normal `Authorization` header;
use `client.files.fetch(url)` to stream their `Response` with the client's
current credential. Plain browser elements cannot attach that header, so use a
bearer URL when an `<img>`, `<video>`, or `<a>` must load the URL directly.

`ctx.files.revokeGrant(url.id)` revokes one URL idempotently. Grant listings
expose metadata but never the secret URL, which is returned only at creation
and stored only as a hash in framework Grant state. An application may
intentionally persist the returned plaintext URL, as the public-avatar example
does. Missing, expired, revoked, unauthorized, and invalid URLs all return
`404 Not Found`.

If application data needs to retain one URL identity for later revocation,
store it in a direct `v.fileGrant()` or `v.fileGrant().nullable()` column. The
validator preserves the `FileGrantId` brand across tables and function
arguments; unlike `v.file()`, writing it has no File-lifecycle side effect.

Downloads proxy through AckerDB and support `GET`, `HEAD`, one byte range,
`ETag`, SHA-256 `Digest`, `Content-Length`, `Content-Type`, and conditional
requests. Responses use `Cache-Control: no-store`, and expiration is checked
when a request begins so an admitted stream may finish normally.

## Query File metadata

`ctx.files.get()` and `ctx.files.query()` are ordinary reactive database reads.
Metadata contains `id`, lifecycle `state`, optional immutable `owner`, `size`,
`sha256`, optional untrusted `contentType` and `name`, and `createdAt`. It never
exposes the physical object key.

```ts
const page = await ctx.files
  .query()
  .where((file) => file.owner.eq(identity))
  .orderBy((file) => file.createdAt.desc())
  .paginate({ pageSize: 50 });

const totalBytes = await ctx.files
  .query()
  .where((file) => file.owner.eq(identity))
  .sum((file) => file.size);
```

The built-in indexes cover creation time, owner plus creation time, and state
plus creation time. Queries do not silently filter by owner; application code
owns authorization. Business-specific metadata, filtering, indexes, and quotas
belong in application tables that reference `FileId`.

## Work with bytes in backend code

Procedures, raw HTTP handlers, and system runs may stream bytes.
Queries and mutations remain metadata-only so external I/O never holds the
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

`store()` requires the exact size before consuming the stream and creates a
pending File. `bytes()` rejects from metadata before allocation when the File
exceeds the caller's explicit memory budget.

## Configure filesystem or S3-compatible storage

Each deployment has one active backend. No Files configuration means the local
filesystem default described above. To choose a different directory:

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
compatible service such as R2, MinIO, or Garage when it implements the probed
`PUT`, `HEAD`, whole `GET`, ranged `GET`, and `DELETE` behavior:

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
SDK credential provider chain. Credentials do not belong in
`.ackerdb.config.json`.

Programmatic `S3FileStore` construction is available from
`@ackerdb/server/files/s3`. The separate entrypoint keeps the AWS SDK out of
local-only runtime imports. `maxBytes` may be configured from one byte through
the initial 5 GiB hard ceiling, and startup probes the selected store before
reporting ready.

## Delete, back up, and migrate

Application-owned lifecycle cleanup can be one mutation:

```ts
await ctx.db.documents.delete(documentId);
await ctx.files.delete(fileId);
```

Deletion immediately makes the File unavailable and revokes all of its Grants.
A durable worker retries physical deletion and keeps the File visibly
`deleting` until the backend confirms it; the metadata row then disappears.
Replacing or removing an application reference never implicitly deletes the
old File because another row or Grant may still use it.

`acker backup` includes and verifies live File bytes by default.
`--metadata-only` is explicit and restore then verifies every File against the
independently restored active store before publishing the database. See
[Operations](operations.md#verified-backup-and-restore) for recovery and
[FileStore maintenance migration](operations.md#filestore-maintenance-migration)
for resumable offline backend changes.

The initial feature intentionally omits direct provider delivery, multipart
browser uploads, content deduplication, automatic reference cascades, arbitrary
File metadata columns, single-use downloads, and multiple active stores.
