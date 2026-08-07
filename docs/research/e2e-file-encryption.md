# End-to-end encrypted file products: keys, sharing, recovery

Updated: 2026-08-07

## Conclusion

Every shipping E2E file product converges on the same three-layer shape: a
**random per-file data key**, that key **wrapped** by something the recipient
already holds, and a **chunked or single-shot AEAD** over the bytes. Nothing
below derives a file key from the file's path, identity, or contents. The
differences between products are entirely in the wrapping layer — who holds the
wrapping key, how it reaches a second person, and who else is allowed to hold a
copy for recovery. Those are product decisions, not cryptographic necessities.

For AckerDB this partitions cleanly. The framework contract is small and mostly
negative: mark a File as **opaque**, stop claiming its declared metadata is
trustworthy, refuse the operations that cannot work on ciphertext, and carry an
application-owned key blob that dies with the File. Everything else — cipher,
framing, key hierarchy, sharing, revocation, recovery, previews — belongs to the
application, because every product surveyed makes those choices differently and
each difference is defensible.

The single most useful finding is that a **ranged read of client-encrypted bytes
is unauthenticated unless the payload format is per-chunk AEAD**, and all three
products that offer ranged reads say so in their own words
([MEGA §9.13](https://mega.nz/SecurityWhitepaper.pdf),
[Proton Drive SDK `getSeekableStream`](https://github.com/ProtonDriveApps/sdk/blob/main/client/js/src/interface/download.ts),
[AWS S3 Encryption Client](https://github.com/aws/amazon-s3-encryption-client-java/blob/main/src/examples/java/software/amazon/encryption/s3/examples/RangedGetExample.java)).
[Cryptomator](https://github.com/cryptomator/docs/blob/main/docs/security/vault.mdx)
is the counter-example that shows what it costs to keep it authenticated.

## Source inventory

Primary sources only. Vendor whitepapers are first-party and normative for the
vendor's own design, but they are self-reported and not independently verified;
open client source is verifiable. The distinction is marked.

| Product | Source | Kind |
| --- | --- | --- |
| Cryptomator | [Security Architecture](https://github.com/cryptomator/docs/blob/main/docs/security/architecture.mdx), [Vault Cryptography](https://github.com/cryptomator/docs/blob/main/docs/security/vault.mdx) | Open-source project's own spec, implementation is open |
| Proton Drive | [Proton Drive SDK source](https://github.com/ProtonDriveApps/sdk), [Proton Drive security model](https://proton.me/blog/protondrive-security) | Open client source (verifiable) + first-party design document |
| Tresorit | [Encryption Whitepaper](https://cdn.tresorit.com/202208011608/tresorit-encryption-whitepaper.pdf) | Vendor whitepaper, closed source — **self-reported, unverifiable** |
| MEGA | [MEGA Security White Paper, 3rd ed., June 2022](https://mega.nz/SecurityWhitepaper.pdf) | Vendor whitepaper; clients are open at [github.com/meganz](https://github.com/meganz/) |
| Signal attachments | [`AttachmentCipherOutputStream.kt`](https://github.com/signalapp/Signal-Android/blob/main/lib/libsignal-service/src/main/java/org/whispersystems/signalservice/api/crypto/AttachmentCipherOutputStream.kt), [`AttachmentCipherStreamUtil.kt`](https://github.com/signalapp/Signal-Android/blob/main/lib/libsignal-service/src/main/java/org/whispersystems/signalservice/api/crypto/AttachmentCipherStreamUtil.kt), [`PaddingInputStream.java`](https://github.com/signalapp/Signal-Android/blob/main/lib/libsignal-service/src/main/java/org/whispersystems/signalservice/internal/crypto/PaddingInputStream.java), [`SignalService.proto`](https://github.com/signalapp/Signal-Android/blob/main/lib/libsignal-service/src/main/protowire/SignalService.proto) | Open client source |
| Matrix encrypted media | [Client-Server API, "Sending encrypted attachments"](https://spec.matrix.org/latest/client-server-api/#sending-encrypted-attachments) ([spec source](https://github.com/matrix-org/matrix-spec/blob/main/content/client-server-api/modules/end_to_end_encryption.md)) | Protocol specification |
| iCloud Advanced Data Protection | [iCloud encryption](https://support.apple.com/guide/security/icloud-encryption-sec3cac31735/web), [Advanced Data Protection for iCloud](https://support.apple.com/guide/security/advanced-data-protection-for-icloud-sec973254c5f/web), [Escrow security for iCloud Keychain](https://support.apple.com/guide/security/escrow-security-for-icloud-keychain-sec3e341e75d/web) | Apple Platform Security guide (first-party, closed source) |
| Bitwarden Send | [`shareable_key.rs`](https://github.com/bitwarden/sdk-internal/blob/main/crates/bitwarden-crypto/src/keys/shareable_key.rs), [`send.rs`](https://github.com/bitwarden/sdk-internal/blob/main/crates/bitwarden-send/src/send.rs), [CLI `receive.command.ts`](https://github.com/bitwarden/clients/blob/main/apps/cli/src/tools/send/commands/receive.command.ts) | Open client source |
| AWS S3 Encryption Client | [What is the S3 Encryption Client](https://docs.aws.amazon.com/amazon-s3-encryption-client/latest/developerguide/what-is-s3-encryption-client.html), [`RangedGetExample.java`](https://github.com/aws/amazon-s3-encryption-client-java/blob/main/src/examples/java/software/amazon/encryption/s3/examples/RangedGetExample.java) | First-party docs + open source |
| Browser crypto constraint | [W3C Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/) | W3C specification |

## 1. Per-file key model

| Product | Per-file data key | Wrapped by | Travels with the ciphertext | Held as server metadata |
| --- | --- | --- | --- | --- |
| Cryptomator | 256-bit random content key | Vault encryption masterkey, AES-GCM, inside a 68-byte file header | **Everything**: header nonce, wrapped content key, per-chunk nonces and tags | Nothing — the store sees only opaque files and Base32/Base64url names |
| Proton Drive | PGP session key ("content key") per file node | PKESK-wrapped to that node's own key; the node's passphrase is wrapped by the parent node key or a share key | Encrypted blocks and per-block encrypted signatures | Content key packet, node key, wrapped passphrase, block hashes |
| Tresorit | Fresh 256-bit AES key per file (and per re-key), 128-bit IV per version | Stored encrypted inside the parent folder; the parent chain roots in the tresor key file (AES-256-GCM + RSA-4096 OAEP) | Ciphertext + HMAC-SHA-512 | Encrypted parent-folder blobs, 32-byte file identifier, upload date, uploader email |
| MEGA | 128-bit File Key + 64-bit nonce | XOR-obfuscated with the IV and the condensed MAC, then `AES-ECB(Master Key, …)`; in a share, `AES-CBC(Share Key, …)` | Chunk ciphertext | Encrypted (obfuscated) file key, node handle, parent handle |
| Signal | 64-byte `combinedKeyMaterial` = AES-256 key ‖ HMAC-SHA-256 key | Nothing — it is carried in the encrypted message | `IV(16) ‖ AES-256-CBC/PKCS5 ciphertext ‖ HMAC-SHA-256(32)` | CDN sees only `cdnKey`/`cdnId` and the blob |
| Matrix | Single-use 256-bit AES-CTR key | Nothing — carried in the Megolm-encrypted room event | Raw AES-CTR ciphertext only | The `mxc://` blob |
| iCloud (ADP) | CloudKit record keys, and all CloudKit assets | Wrapped to the container's CloudKit **Service key**, which under ADP lives only in the iCloud Keychain protection domain | Not documented at this level | Modification timestamps and content checksums (see §4) |
| Bitwarden Send | Derived, not random: `HKDF-Expand(HMAC-SHA256("bitwarden-send", secret), info="send") → 64 bytes` = AES-256-CBC key ‖ HMAC key, from a 16-byte `secret` | The 16-byte secret lives in the URL fragment; a copy is also stored encrypted under the creator's user key | Ciphertext | Encrypted Send key, access id, access count, expiry |

Two structural facts hold across all of them.

**The data key is always random per file, never derived from identity.**
Bitwarden Send is the only derivation, and it derives from a random link secret,
not from anything the server chose. Cryptomator states it plainly: `contentKey
:= createRandomBytes(32)` per file, wrapped under the vault masterkey in the
header ([vault.mdx](https://github.com/cryptomator/docs/blob/main/docs/security/vault.mdx)).
Proton's SDK generates the content key as a fresh PGP session key for the node
and wraps it to the node's own key
([`driveCrypto.ts` `generateContentKey`](https://github.com/ProtonDriveApps/sdk/blob/main/client/js/src/crypto/driveCrypto.ts)),
then encrypts blocks with that session key
(`encryptBlock(blockData, encryptionKey, sessionKey, signingKey)`, with the
comment "Blocks use the session key so we do not send encryption key").

**Where the key lives splits the field in two.** Cryptomator puts the wrapped
key *in the object* — an in-band header — so the storage backend needs no
metadata channel at all. Everyone else keeps key material *out of band*: in the
server's database (Proton, Tresorit, MEGA, Bitwarden), inside a separately
encrypted message (Signal, Matrix), or in a device keychain (Apple). For a
framework that owns a metadata table, this is the decisive choice: in-band means
zero schema change; out-of-band means a column.

Framing details worth carrying:

- **Cryptomator**: 68-byte header = 12-byte nonce + 40-byte AES-GCM payload
  (8 bytes of `0xFF` + the 32-byte content key) + 16-byte tag. Content is split
  into ≤32 KiB chunks, each emitted as `nonce(12) ‖ AES-GCM ciphertext ‖ tag(16)`
  with the AAD set to the **big-endian 64-bit chunk number** (prevents
  reordering) **and the file header nonce** (binds the chunk to its file). This
  is the only design surveyed that keeps random access authenticated.
- **Signal**: encrypt-then-MAC, `AES/CBC/PKCS5Padding` with a 32-byte key and
  `HmacSHA256` with the next 32 bytes; the IV is written first and fed to the
  MAC. The `digest` in `AttachmentPointer` is the SHA-256 of the *entire
  ciphertext blob including the IV prefix and HMAC suffix*
  ([`AttachmentCipherStreamUtil.computeCiphertextSha256`](https://github.com/signalapp/Signal-Android/blob/main/lib/libsignal-service/src/main/java/org/whispersystems/signalservice/api/crypto/AttachmentCipherStreamUtil.kt)).
- **Matrix**: "the client generates a single-use 256-bit AES key, and encrypts
  the file using AES-CTR. The counter is 64 bits long, starting at 0 and
  prefixed by a random 64-bit Initialization Vector (IV)". The event carries a
  JWK (`alg: "A256CTR"`, `kty: "oct"`, `k`), the `iv`, `v: "v2"`, and
  `hashes.sha256`. The spec is explicit that the hash is of the ciphertext: "A
  hash of the ciphertext MUST also be included, in order to prevent the
  homeserver from changing the file content. Clients MUST verify the hash before
  using the file contents."
- **MEGA**: chunks are AES-CCM with the 64-bit nonce incremented per chunk; a
  "Condensed MAC" folds every chunk MAC together via XOR + AES-ECB. The file key
  handed to a recipient is *obfuscated* — the IV and the condensed MAC are
  XOR-folded into it — so the key doubles as the integrity anchor. The whitepaper
  does not state a chunk size.

## 2. Sharing

| Product | Grant mechanism | What the server learns | What revocation actually does |
| --- | --- | --- | --- |
| Proton Drive | Share passphrase re-encrypted to each member's address key; public URL = share passphrase re-encrypted under a URL password Proton "will never receive" | Membership list, roles, the URL itself | Removes the member's wrapped passphrase — future content only |
| Tresorit | Tresor key file re-encrypted to the recipient's tresor share public key (RSA-4096 OAEP) | Member list and ACL, upload dates, uploader email | "the tresor key file is re-encrypted so the affected user can no longer decrypt it"; old content is **not** re-encrypted — explicitly "lazy re-encryption" |
| MEGA | 128-bit Share Key; `AES-CBC(Share Key, Obfuscated File Key)` per node; `RSA(Public RSA Key, Share Key)` per contact | The share graph, node handles | Nothing cryptographic for already-fetched keys; link expiry is "barred by the API logic" |
| Signal / Matrix | The key is inside the encrypted message; membership *is* the grant | Nothing (the CDN/homeserver sees only opaque blobs) | Impossible — there is no revocation concept for a delivered attachment key |
| iCloud (ADP) | Apple servers "are used only to establish sharing but don't have access to the encryption keys for the shared data" | Sharing establishment; a title and thumbnail under standard protection | Not cryptographic; "anyone with a link" **downgrades the content to standard data protection** |
| Bitwarden Send | 16-byte secret in the URL fragment; optional password gates the *server*, not the ciphertext | Access id, access count, expiry, whether a password is set | Server-side refusal only: disable, expire, or exhaust `max_access_count` |
| Cryptomator Hub | Per-user JWE (`alg: ECDH-ES`, `enc: A256GCM`, P-384 ephemeral key) of the 512-bit raw masterkey, fetched from the vault's `/access-token` sub-resource | That a user is authorized | Stop issuing the JWE — future unlocks only |

**The URL fragment is load-bearing and it is a real property, not a trick.**
MEGA states it directly: "everything after an anchor hash (#) in the URL is not
sent to the MEGA servers and is kept locally in the client's browser". Tresorit
says the same of its `https://web.tresorit.com/l/<pathId>#<clientSecret>` form —
the 128-bit `clientSecret` "is never transmitted to the Tresorit backend,
neither by the client applications nor by the browser used to open the shared
link", and the client runs PBKDF2 over it to derive a `<linkId>` (used to fetch
the encrypted metadata package from the server) and an `<encKey>` (used to
decrypt it). Bitwarden's CLI shows the mechanism in four characters of code:
`url.hash.slice(1).split("/").slice(-2)` yields the Send id and key.

**Password-protecting a link means two different things.** MEGA does it
cryptographically: PBKDF2-HMAC-SHA512, 100 000 rounds, 256-bit salt, 512-bit
derived key; the first 128/256 bits XOR the actual key and the last 256 bits key
an HMAC-SHA256 over `Algorithm ‖ Type ‖ Public Handle ‖ Salt ‖ Encrypted Key`.
Bitwarden does it as a *server gate*: the client computes
`PBKDF2(password, salt = keyArray)` and sends the hash to obtain an access
token; the ciphertext key is still the fragment secret. Both are legitimate; only
the first survives a compromised server.

**Revocation, honestly stated.** Once a recipient has held the data key, no
product can take back the bytes they already read. Every "revoke" surveyed is one
of: (a) stop wrapping the key for that principal, which only affects content
encrypted afterwards — Tresorit names this "lazy re-encryption" and notes "the
ACL will limit access to old data immediately when rights are revoked, [but]
this method does not require the data in the shared folder to be re-encrypted
immediately"; or (b) a server-side refusal to serve the ciphertext, which is
exactly what AckerDB grant revocation already is. Cryptographic revocation of
past content requires re-keying **and** re-encrypting every affected object, and
nobody surveyed does it eagerly. MEGA's §5.6 makes the ceiling visible from the
other side: importing a file from a public link stores the same encrypted key
against the same handle rather than re-uploading, so a takedown of the original
kills every import too.

## 3. Device loss and recovery

| Product | Recovery mechanism | Second key holder | What the user is told they lose |
| --- | --- | --- | --- |
| MEGA | Exported "Recovery Key", which "is technically their Master Key"; password reset re-encrypts the Master Key under a new password and requires email confirmation | The user, on paper | Forgetting the password with no active session and no Recovery Key "results in the inability to decrypt the user's data, which is highly destructive" |
| iCloud (ADP) | iCloud Keychain escrow in HSM clusters, unlocked by SRP proof of the iCloud security code; plus a recovery key or recovery contacts, at least one of which is **required** to enable ADP | Apple's HSM cluster (rate-limited) and/or a chosen contact | "If the recovery methods fail … Apple can't help recover the user's end-to-end encrypted iCloud data" |
| Tresorit | Password *reset* (not recovery): an emailed one-time code plus a device-local private key re-encrypts the profile under a new password | Optionally the tenant admin, via "Advanced control" | "the password change process involves the complete re-encryption of the user profile [which] makes server-side password recovery theoretically impossible" |
| Bitwarden Send | The creator keeps a copy of the Send key encrypted under their user key, so they can regenerate the link | The creator's own vault | A recipient who loses the link has no path back |
| Signal / Matrix | None per attachment; recovery is a whole-account/whole-session concern | — | A lost session loses the message and therefore the attachment key |

Apple's escrow is the most precisely documented rate-limited escrow in
production and is worth quoting for the shape: "The escrow service allows only
10 attempts to authenticate and retrieve an escrow record. … After the 10th
failed attempt, the HSM cluster destroys the escrow record and the keychain is
lost forever. … These policies are coded in the HSM firmware. The administrative
access cards that permit the firmware to be changed have been destroyed."

Tresorit's "Advanced control" is the clearest example of recovery as a deliberate
*product* choice rather than a cryptographic one: "When a new user is registered
to Tresorit, they accept their tenant administrator and automatically encrypt
their profile with the public key associated with the tenant." The tenant admin
can therefore decrypt and re-key any user's profile. This is not weaker crypto;
it is a second authorized key holder chosen at registration time. Whether the
user can decline it is a policy question.

**Unavoidable vs. chosen.** Unavoidable: if no reachable party holds key
material, the data is gone — every recovery mechanism above is simply *a second
key holder*. Chosen: who that holder is (the user on paper, a rate-limited HSM,
a named contact, a tenant admin, the creator's own vault), whether enrolling one
is mandatory, and whether losing a device is survivable without one. Apple makes
enrollment mandatory to turn ADP on; MEGA merely nags; Tresorit escrows to the
tenant by default; Signal and Matrix opt out entirely at the per-attachment
level.

## 4. What the server can still do

**Size.** Every product leaks the ciphertext length, and ciphertext length
approximates plaintext length. Signal is the only one surveyed that pads:
`getPaddedSize(size) = max(541, floor(1.05^ceil(log_1.05(size))))` — roughly 5 %
buckets with a 541-byte floor, in
[`PaddingInputStream`](https://github.com/signalapp/Signal-Android/blob/main/lib/libsignal-service/src/main/java/org/whispersystems/signalservice/internal/crypto/PaddingInputStream.java).
Everyone else accepts the leak.

**Names and content types.** Cryptomator encrypts filenames with AES-SIV using
the parent directory ID as associated data, then Base64url-encodes them. Proton
encrypts the node name with the parent node key. Tresorit stores the name inside
the encrypted parent folder. Signal and Matrix put `fileName` / `body` and
`contentType` / `mimetype` *inside* the encrypted envelope. No surveyed product
stores a plaintext filename or media type next to the ciphertext.

**Timestamps and checksums are the honest residue.** Apple, uniquely, documents
what survives ADP: "Dates and times when a file or object was modified are used
to sort a user's information, and checksums of file and photo data are used to
help Apple de-duplicate and optimize the user's iCloud and device storage".
Apple names the technique — "a well-known technique called convergent
encryption" — and states the metadata "is always encrypted, but the encryption
keys are stored by Apple with standard data protection".

**Server-side thumbnails do not exist for E2E content.** Every product generates
previews client-side and ships them as separate encrypted objects:

- Matrix adds a `thumbnail_file` `EncryptedFile` alongside `file`, with a
  standing warning: "if there are multiple files to encrypt in the same message,
  typically an image and its thumbnail, the files must not share both the same
  key and IV."
- Signal carries `thumbnail`, `blurHash`, `width`, `height`, and `caption` inside
  the encrypted `AttachmentPointer`, so the placeholder is computed on the
  sending device.
- MEGA encrypts thumbnails and previews as "file attributes" with
  `AES-CBC(File Key, File Attribute Data)` — and admits in §9.10 that "File
  attributes (thumbnails) are not integrity protected. An adversary controlling
  the file attribute/API infrastructure or the user's TLS connection to the same
  could alter thumbnails for files with known keys."
- Proton's SDK takes thumbnails as a **caller-supplied argument**:
  `uploadFromStream(stream, thumbnails, onProgress)`. The SDK will encrypt them;
  it will not produce them.
- Apple is the exception that proves the rule: for a sharing operation "a title
  and representative thumbnail may be stored by Apple with standard data
  protection to show a preview to the receiving users" — i.e. the preview is
  bought by dropping E2E for that one artefact.

The cost of a client-side preview is therefore: generate at write time on the
uploading device, encrypt it under its own key, and store it as a second object.
The alternative — decrypt-on-view in the client — costs a full fetch of at least
the leading chunks plus a decode, on every render.

**Partial reads break integrity.** This is the sharpest finding and three
independent sources state it:

- MEGA §9.13, "Partial downloads are not MAC protected": "MEGA protects the
  integrity of regular downloads by way of a cryptographic checksum. It can only
  be computed and verified once the file has been downloaded in its entirety. Any
  action taken on partial data, such as the progressive rendering of images, PDFs
  or video, is therefore not afforded the protection of the file's MAC. It is
  trivial for an adversary who controls the MEGA infrastructure or the user's TLS
  connection to the storage nodes to flip specific bits of a file being accessed."
- Proton Drive SDK, `getSeekableStream()`: "Stream doesn't verify data
  integrity. For the full integrity of the file, use `downloadToStream` instead."
  And: "The file is chunked into blocks that must be fully downloaded to provide
  given range of data within the block."
- AWS S3 Encryption Client: "You must also specify the
  `enableLegacyUnauthenticatedModes` parameter to enable ranged GET requests."
  The opt-in is named after exactly what it costs.

Cryptomator shows the price of avoiding this: per-chunk AEAD at 32 KiB
granularity, with the chunk index and header nonce as AAD, gives authenticated
random access — at the cost of 28 bytes of overhead per 32 KiB (≈0.085 %) and a
format that must be chunk-aligned on read.

## 5. SDK surface

**Proton Drive SDK** is the only full-featured, currently maintained E2E file
SDK with an open interface, and its shape is instructive.

| Concern | Interface |
| --- | --- |
| Upload | `uploadFromStream(stream, thumbnails, onProgress) → Promise<UploadController>`; `uploadFromFile(fileObject, thumbnails, onProgress)`; controller exposes `pause()`, `resume()`, `completion()` |
| Upload metadata | `{ mediaType, expectedSize: number \| null, expectedSha1?, modificationTime?, additionalMetadata? }` — the last three are documented as "encrypted and stored with the file" |
| Download | `downloadToStream(writable, onProgress)`, `unsafeDownloadToStream(...)` ("Use this only for debugging purposes"), `getSeekableStream()` |
| Claimed size | `getClaimedSizeInBytes(): number \| undefined` — "This is encrypted information that is not known to the Proton Drive and thus it is explicitely stated as claimed only and must be treated that way. It can be wrong or missing completely." |
| Sharing | `ShareNodeSettings { users?, urlAccess?: { role, customPassword?, expiration? }, emailOptions?, editorsCanShare? }`; `UnshareNodeSettings { users?, urlAccess?: 'remove' }` |
| Refuses to provide | Its README's "Scope and Limitations": "Authentication or login flows", "Session management", "User address provider" |

Two of those lines transfer directly. `getClaimedSizeInBytes()` is the exact
vocabulary AckerDB needs for a plaintext length that the framework cannot
verify. And `unsafeDownloadToStream` / `getSeekableStream` establish the pattern
of naming the unauthenticated path so a caller cannot reach it by accident.

**AWS S3 Encryption Client** is the closest analogue to a storage framework's
own helper, and its scope is deliberately narrow: "By default, the Amazon S3
Encryption Client generates a unique data key for each object that it encrypts",
and it "protects the data keys that encrypt your objects by encrypting them
under a wrapping key. With the Amazon S3 Encryption Client, you define a wrapping
key by passing the key to the Amazon S3 Encryption Client". It does envelope
encryption and nothing else — no key custody, no authorization, no sharing, and
no safe ranged read.

**Bitwarden** shows the minimal key-wrapping primitive: one 16-byte secret in,
an AES-256-CBC + HMAC key pair out, via
`HKDF-Expand(HMAC-SHA256(key = "bitwarden-send", secret), info = "send")`. The
whole sharing story is that secret's transport in a URL fragment.

**The browser constrains all of this.** W3C WebCrypto's `SubtleCrypto.encrypt`
is `Promise<ArrayBuffer> encrypt(AlgorithmIdentifier, CryptoKey, BufferSource)`
— one-shot, buffer in, buffer out, no streaming interface anywhere on the
`SubtleCrypto` surface. Any browser client encrypting a large file must chunk in
JavaScript. That, not cryptographic taste, is why Cryptomator, Proton, and MEGA
are all block-structured.

**The smallest useful API, across all of them, is three calls**: generate-and-wrap
a data key; encrypt-and-upload a stream; fetch-and-decrypt a stream (plus an
explicitly-named unauthenticated range variant). Not one of them does identity,
authorization, key custody policy, or recovery on the developer's behalf.

## What transfers to AckerDB

Ground truth, all read from `origin/canary`:

- `_ackerdb_files` is `id, state, objectKey, owner, size, sha256, contentType,
  name, createdAt, pendingExpiresAt`
  (`packages/server/src/files/tables.ts`) — no wrapped key, no key version, no
  opacity flag.
- `ctx.files.open()` and `ctx.files.bytes()` return stored bytes
  (`packages/server/src/files/api.ts`), so server code would receive ciphertext.
- `inline` grants require `safeInlineContentType(file.contentType)`, which
  accepts `application/pdf`, `audio/*`, `video/*`, and `image/*` except
  `image/svg+xml` (`packages/server/src/files/namespace.ts:242,365`).
- The stored SHA-256 is served as `ETag` (`"<hex>"`) and
  `Digest` (`sha-256=<base64>`) by `fileEtag`/`fileDigest`
  (`packages/server/src/files/http-headers.ts`).
- `ADR-0019` fixes the surrounding contract: immutable File metadata, grants own
  download authority, one store per deployment, streaming-first backend byte
  access, and "Optional File name and content type are immutable, **untrusted**
  declarations captured with the bytes".

### Minimum viable framework contract

**1. An opacity flag on the File, enforced by the framework.** This is the only
item that genuinely cannot live in application code, because the behaviours it
must change are framework behaviours: refusing `inline` grants, refusing Studio
preview, and telling `ctx.files.*` callers that bytes are opaque. An application
can already keep a parallel `myFiles(fileId, wrappedKey)` table; it cannot make
`createUrl({ inline: true })` refuse.

**2. Stop treating declared metadata as descriptive of the payload.** ADR-0019
already calls `name` and `contentType` untrusted; for an opaque File, `size` and
`sha256` describe the **ciphertext**, and any plaintext length or digest the
application wants is a *claim* in an application table. Borrow Proton's word:
claimed. Note that `ETag`/`Digest` remain correct without any change — HTTP
entity tags identify the representation the server delivers, and the server
delivers ciphertext. This is not a bug to fix; it is the right answer, and
`expectedSha256` on the upload session correspondingly becomes the ciphertext
digest, which the encrypting client is uniquely able to compute.

**3. A per-File opaque key-material blob, if and only if the design is
out-of-band.** Cryptomator proves an in-band header needs no column at all — the
whole key hierarchy fits inside the object, and AckerDB's store, backup, and
migration paths would never know. If AckerDB instead wants the wrapped key in
`_ackerdb_files`, the argument is lifecycle: the framework already deletes the
File row and its grants atomically, and a key blob that outlives its ciphertext
is a leak. That is a real but modest benefit, and the in-band alternative should
be the default recommendation to applications.

**4. Refuse, do not degrade.** `inline`, Studio preview, and any future direct
provider delivery must fail loudly on an opaque File. `safeInlineContentType`
already refuses anything whose declared type is not a trusted media type; an
opaque File should never present one.

**5. Nothing else.** No cipher, no chunk size, no key wrapping, no sharing, no
revocation semantics, no recovery. Every product surveyed differs on all six and
each difference is defensible.

### What the application owns

- **Cipher and framing.** Chunked AEAD (Cryptomator's shape) if authenticated
  ranged reads matter; a single AEAD blob otherwise.
- **The key hierarchy, sharing, and revocation.** AckerDB grants already provide
  server-side revocation; cryptographic revocation is re-keying, and the
  application decides whether it is eager or lazy.
- **Recovery and escrow.** Purely a product decision, per §3.
- **Previews.** A second, separately keyed encrypted File plus an application row
  — exactly Matrix's `thumbnail_file` and Signal's client-computed
  thumbnail/blurHash. This needs zero new framework surface.

### Consequences worth stating plainly

- **Ranged reads are well-defined but unauthenticated.** `open({ range })`
  already returns exactly the stored bytes for the requested offsets; for an
  opaque File those are ciphertext offsets, and the client must translate a
  plaintext range into chunk-aligned ciphertext bytes. Unless the payload is
  per-chunk AEAD, that read cannot be authenticated — MEGA, Proton, and AWS all
  say so about their own products.
- **`ctx.files.open()` / `bytes()` handing back ciphertext is correct.** Document
  it; do not build a decryption hook, because the framework has no key.
- **Backup and store migration keep working unchanged.** `createFilesBackup`
  streams whatever `store.open()` yields, which for a client-encrypted File is
  ciphertext, so backups are opaque with no new code. `migrateFileStore` verifies
  the stored size and SHA-256 at the target — both of which are the ciphertext's
  — so migration needs no rewrapping. This is a genuine asymmetry: the E2E axis
  is far cheaper than the server-key axis, which cannot rewrap per-file key
  material across a master-key change.
- **Key rotation, `probe()` key health, and key custody do not apply.** The
  framework holds no key on this axis, so there is nothing to rotate, report, or
  lose.

## Not established from primary sources

- **Proton Drive account recovery** (recovery phrase / recovery file mechanics).
  The Drive security-model document covers the key hierarchy and sharing but not
  account recovery, and the remaining Proton material on the subject is support
  and marketing pages, which this ticket excludes. Unverified.
- **MEGA chunk sizes.** The whitepaper says files "are split into chunks" and
  that the 64-bit nonce increments per chunk, but states no chunk size. Any
  specific number would have to come from the client source.
- **iCloud Drive's asset-level file format.** Apple documents record keys wrapped
  to a CloudKit Service key and says "all CloudKit assets" are covered by ADP,
  but publishes no per-asset cipher, chunking, or key-wrapping format.
- **Tresorit's implementation.** Everything above is from Tresorit's own
  whitepaper. The clients are closed source, so none of it is independently
  verifiable, including the "lazy re-encryption" and "Advanced control" claims.
- **Bitwarden Send file size limits and streaming behaviour.** The SDK crate
  operates on buffers; no documented maximum was checked against a primary
  source.
