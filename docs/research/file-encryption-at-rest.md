# File encryption at rest in comparable object stores

Updated: 2026-08-07

Research for [issue #219](https://github.com/pedrobzz/AckerDB/issues/219), a child
of the [Files encryption at rest wayfinder map](https://github.com/pedrobzz/AckerDB/issues/217).
Every claim below is cited to vendor documentation, a specification, or library
source. Where a primary source does not answer a question, this document says so
instead of guessing.

## Conclusion

Exactly one third-party design shape fits the AckerDB `FileStore` port
(`probe/put/open/attributes/delete`, no per-object metadata channel) as a
decorator without schema changes: **client-side envelope encryption whose
per-object key material lives in a header prefixed to the object bytes, over a
chunked-AEAD framing with a fixed chunk size**. That is what Tink, `age`, the
AWS Encryption SDK, and MinIO's `sio` all do. Every design that puts the wrapped
data key in *provider metadata* — the Amazon S3 Encryption Client's default mode,
Azure's client-side encryption, MinIO's own server-side scheme — needs a metadata
channel that the port does not have.

Two port invariants break under any expanding cipher and have to be repaired
explicitly inside the decorator, not worked around: `put` must return the
**plaintext** SHA-256 and length rather than what the inner store computed, and
`attributes.size` must report the **plaintext** length. The second is solvable
without new metadata only because chunked framings make encrypted size a pure,
invertible function of plaintext size — MinIO's `sio` ships that function as
`EncryptedSize`/`DecryptedSize`
([sio.go](https://github.com/minio/sio/blob/master/sio.go)).

Ranged `GET` survives chunked AEAD (age, Tink, and `sio` all document seeking in
chunk increments) but does **not** survive a single whole-object AEAD: the Amazon
S3 Encryption Client's answer to ranged reads is to turn authentication *off*
behind an opt-in flag it calls a temporary fix
([supported encryption algorithms](https://docs.aws.amazon.com/amazon-s3-encryption-client/latest/developerguide/encryption-algorithms.html)).

Size-preserving CTR/XTS is a real, standardized alternative, and the documented
reason storage systems choose it is precisely AckerDB's problem: the Linux
fscrypt documentation states that "Authenticated encryption modes are not
currently supported because of the difficulty of dealing with ciphertext
expansion"
([fscrypt.rst](https://github.com/torvalds/linux/blob/master/Documentation/filesystems/fscrypt.rst)).
Its cost is stated just as plainly by NIST: XTS-AES "does not provide
authentication of the data or its source"
([SP 800-38E](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38e.pdf)).

On rotation, every surveyed system agrees: **rotating the master key never
rewrites object bytes.** AWS KMS retains old key material forever and selects it
at decrypt time; GCS keeps previous key versions alive and makes re-encryption an
explicit `Rewrite` job. The only system in the survey that genuinely re-wraps in
place is MinIO — and it can only do that because it has a per-object metadata
channel to rewrite.

## Object stores

### Amazon S3

Server-side encryption is on by default and is transparent to the object model:
"As long as you authenticate your request and you have access permissions, there
is no difference in the way you access encrypted or unencrypted objects."
Presigned URLs "work the same way for both encrypted and unencrypted objects."
SSE-S3 gives "Each object is encrypted with a unique key," itself encrypted "with
a root key that it regularly rotates," using AES-256. DSSE-KMS applies "two
independent layers of AES-256 encryption."
[Protecting data with server-side encryption](https://docs.aws.amazon.com/AmazonS3/latest/userguide/serv-side-encryption.html)

SSE-KMS is textbook envelope encryption, and the wrapped key is co-located with
the object: "Amazon S3 stores the encrypted data key as metadata with the
encrypted data." The encryption context defaults to the object ARN, or the
*bucket* ARN when S3 Bucket Keys are enabled, which is how Bucket Keys amortize
one KMS call across many objects.
[SSE-KMS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html)

SSE-C moves the key out of the provider entirely: "S3 never stores the encryption
key when you use SSE-C. You must supply the encryption key every time." Key
mapping and rotation become the caller's problem: "You manage a mapping of which
encryption key was used to encrypt which object… if you lose the encryption key,
you lose the object." As of April 2026 S3 disables SSE-C by default on new
general-purpose buckets, and it must be re-enabled through `PutBucketEncryption`.
[SSE-C](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ServerSideEncryptionCustomerKeys.html)

Changing a bucket's default encryption does not touch existing objects; the
documented remedy is S3 Batch Operations `Copy`, i.e. a full rewrite of every
object.
[Protecting data with server-side encryption](https://docs.aws.amazon.com/AmazonS3/latest/userguide/serv-side-encryption.html)

### Amazon S3 Encryption Client (client-side)

Unique data key per object, AES-GCM with "a 12-byte initialization vector, and a
16-byte AES-GCM authentication tag," no KDF. Key commitment, when enabled, costs
"+ 56 bytes" per message.
[S3EC concepts](https://docs.aws.amazon.com/amazon-s3-encryption-client/latest/developerguide/concepts.html)

The metadata placement question is answered twice, and this is the most directly
transferable finding in the survey. Default: "Encryption metadata is stored in
the object's metadata headers." Alternative: an **instruction file**, "a separate
Amazon S3 object that stores encryption metadata for an encrypted object… the
same key as the encrypted object with the suffix `.instruction` appended."
[S3EC concepts — instruction files](https://docs.aws.amazon.com/amazon-s3-encryption-client/latest/developerguide/concepts.html)

Rewrap is impossible under the default mode, for a reason that applies verbatim
to AckerDB's port: "For objects encrypted using the default Object Metadata
storage (not instruction files), it is not possible to change the encrypted data
key associated with the object without changing the object. Object Metadata in S3
is immutable, so changing the metadata is equivalent to changing the object
itself."
[S3EC concepts — key commitment](https://docs.aws.amazon.com/amazon-s3-encryption-client/latest/developerguide/concepts.html)

Ranged reads are the sharpest warning. Because the object is one AES-GCM blob
rather than a framed stream, a partial read cannot be authenticated: "If you need
to decrypt objects that were encrypted with a legacy algorithm, or you need to
partially decrypt an AES-GCM encrypted object by performing a ranged request, you
need to use the unauthenticated legacy mode… The decryption of AES-CBC encrypted
objects and ranged requests are considered *unauthenticated* because the
algorithms do not provide any form of authentication to ensure the integrity of
the object." The flag "is designed to be a temporary fix." The default decryption
mode instead **buffers the whole object in memory** (64 MB default in Java) "to
prevent the release of unauthenticated objects."
[Supported encryption algorithms](https://docs.aws.amazon.com/amazon-s3-encryption-client/latest/developerguide/encryption-algorithms.html)

### Google Cloud Storage

"Cloud Storage always encrypts your data on the server side, before it is written
to disk, at no additional charge."
[Data encryption options](https://docs.cloud.google.com/storage/docs/encryption)

CMEK records the key in object metadata (`kmsKeyName`) and encrypts "the object's
data, CRC32C checksum, and MD5 hash," while "Cloud Storage uses standard
server-side keys to encrypt the remaining metadata for the object, including the
object's name." Rotation does not touch bytes: "After rotating a key, Cloud
Storage uses the new version for all operations that encrypt using the key," and
"Previous versions of the key are not disabled or destroyed, so Cloud Storage can
still decrypt existing objects that were previously encrypted using those
versions." Re-encryption is an explicit job: "Use the Rewrite Object method to
re-encrypt each object with the new key. To re-encrypt millions or billions of
objects in bulk with a single job, use Storage batch operations."
[CMEK](https://docs.cloud.google.com/storage/docs/encryption/customer-managed-keys)

CSEK supplies the key per request and stores only a fingerprint: "Cloud Storage
does not permanently store your key in its servers or otherwise manage your key,"
"your key is purged from Cloud Storage servers after the operation is complete,"
and "Cloud Storage stores only a cryptographic hash of the key so that future
requests can be validated against the hash" — the SHA-256 of the key, in object
metadata. Rotation is a rewrite: "you can rotate the object's key by rewriting
the object."
[CSEK](https://docs.cloud.google.com/storage/docs/encryption/customer-supplied-keys)

**Not answered by the primary source:** the CSEK page does not state whether
ranged reads are supported on CSEK-encrypted objects.

### Azure Blob Storage

Service-side customer-managed keys wrap an account-level root key rather than
per-object keys: "Azure Storage wraps the account encryption key with the
customer-managed key in Azure Key Vault," and on rotation "the protection of the
root encryption key changes, but the data in your Azure Storage account remains
encrypted at all times. There is no additional action required on your part." No
data is re-encrypted.
[Customer-managed keys overview](https://learn.microsoft.com/en-us/azure/storage/common/customer-managed-keys-overview)

Client-side encryption is the more interesting comparison. Version 2 uses AES-GCM
(version 1 used AES-CBC and is withdrawn for a documented vulnerability in the
library's CBC implementation). "During encryption, the client library generates a
random initialization vector (IV) of 16 bytes and a random CEK of 32 bytes… The
wrapped CEK and some additional encryption metadata are then stored as blob
metadata along with the encrypted blob."
[Client-side encryption for blobs](https://learn.microsoft.com/en-us/azure/storage/blobs/client-side-encryption)

It is framed, and framing is what buys ranged reads: "Client-side encryption v2
chunks data into 4 MiB buffered authenticated encryption blocks which can only be
transformed whole," with v2.1 making the region length "configurable from 16
bytes up to 1 GiB." "For downloads, both complete and range downloads are
supported," and "Downloading an arbitrary range in the encrypted blob involves
adjusting the range provided by users to get a small amount of additional data
that can be used to successfully decrypt the requested range." That range
adjustment is exactly the translation an AckerDB decorator would have to perform.

The metadata channel is also documented as fragile: "If you upload new metadata
without also preserving the encryption metadata, then the wrapped CEK, IV, and
other metadata will be lost and you will not be able to retrieve the contents of
the blob." Migration from v1 to v2 requires download, decrypt, re-encrypt,
re-upload — there is no in-place path.

### MinIO

MinIO is the only surveyed system that documents a full per-object key hierarchy
and a genuine in-place rewrap. It uses "a unique, randomly generated secret key
per object also known as, Object Encryption Key (OEK)… stored as part of the
object metadata next to the object in an encrypted form." The wrapping key is
derived rather than stored: `KEK := PRF(EK, IV, context_values)` where `EK` is
the SSE-C client key or a KMS data key, `IV` "is public and part of the object
metadata," and the context binds bucket and object name. Primitives: HMAC-SHA-256
as PRF, "AES-256-GCM if the CPU supports AES-NI, ChaCha20-Poly1305 otherwise."
[MinIO security overview](https://github.com/minio/minio/blob/master/docs/security/README.md)

Content encryption is chunked: "the *Secure Channel* splits the plaintext content
into fixed size chunks and en/decrypts each chunk separately using a unique
key-nonce combination," with "chunks of a fixed size of `65536` bytes. The last
chunk may be smaller to avoid adding additional overhead and is treated specially
to prevent truncation attacks. The nonce value is 96 bits long and generated
randomly per object… supports plaintexts up to `65536 * 2^32 = 256 TiB`."
Multipart uploads derive a per-part key as `PRF(OEK, part_id)`.

SSE-S3 rotation re-wraps without touching bytes: the server decrypts the OEK
using the stored encrypted data key and master key id, requests a fresh data key
from the KMS "using the master key ID of the **current MinIO KMS
configuration**," derives a new KEK, re-encrypts the OEK, and stores the new
wrapped OEK, new encrypted data key, and master key id back in object metadata.
SSE-C rotation is instead an S3 `COPY` with source equal to destination carrying
both the current and new keys in headers.

MinIO's `sio` library implements the **DARE** format, which is the cleanest
published example of the framing under discussion. A package is a 16-byte header
(1-byte version, 1-byte cipher suite, 2-byte payload size, 4-byte sequence
number, 8-byte nonce) plus a payload of "1 byte - 64 KB" plus a 16-byte tag. The
sequence number "**must** be 0 for the first package and **must** be incremented
for every subsequent package," which is what makes reordering and truncation
detectable. The AEAD is "either AES-256_GCM or CHACHA20_POLY1305."
[DARE spec](https://github.com/minio/sio/blob/master/DARE.md)

Two `sio` API details matter directly to the port question. Size is an exact,
invertible function — `EncryptedSize(size)` and `DecryptedSize(size)` are
documented as inverses of one another, computed purely from
`headerSize + tagSize` per 64 KiB package. And ranged decryption is a first-class
use: `Config.SequenceNumber` is documented as "The first expected sequence
number. It should only be set manually when decrypting a range within a stream,"
alongside a `DecryptReaderAt` returning an `io.ReaderAt`.
[sio.go](https://github.com/minio/sio/blob/master/sio.go)

**Caveat:** MinIO's security document describes the "Secure Channel" abstractly
and does not itself name DARE, so the binding between the server's chunking and
the `sio` format is inferred from the two documents sharing a 64 KiB chunk size
and the same cipher pair, not stated by either.

### Cloudflare R2

"Objects are encrypted using AES-256, a widely tested, highly performant and
industry-standard encryption algorithm," and "Encryption and decryption are
automatic, do not require user configuration to enable, and do not impact the
effective performance of R2."
[R2 data security](https://developers.cloudflare.com/r2/reference/data-security/)

R2 supports SSE-C across `HeadObject`, `GetObject`, `PutObject`,
`CreateMultipartUpload`, `UploadPart`, `CopyObject`, and `UploadPartCopy`, via
the standard `x-amz-server-side-encryption-customer-algorithm` / `-key` /
`-key-MD5` headers; AWS KMS encryption is not supported.
[R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
The key "must be 32 bytes in length," and the hash is identification only: "while
SSE-C does provide MD5 hashes, this hash can be used for identification of keys
only. The MD5 hash is not used in the encryption process itself." Key loss is
terminal: "In the event you misplace them, Cloudflare will be unable to recover
the body of any objects encrypted using those keys."
[Use SSE-C](https://developers.cloudflare.com/r2/examples/ssec/)

**Not answered by the primary source:** R2's documentation makes no statement
about object size changes or ranged-read behavior under SSE-C.

### Tigris

"Tigris encrypts all data at rest automatically. The bucket encryption
configuration APIs accept requests but server-side encryption with managed keys
is always on." `PutBucketEncryption` / `GetBucketEncryption` are marked partially
supported; `PutObject (SSE-S3)` is fully supported.
[Tigris S3 API compatibility](https://www.tigrisdata.com/docs/api/s3/)

**Not answered by the primary source:** Tigris does not document SSE-C, a cipher
name, per-object key material, or rotation semantics.

### Summary table

| System | Per-object key material lives | Size change | Ranged `GET` | Rotation |
| --- | --- | --- | --- | --- |
| S3 SSE-S3 / SSE-KMS | Provider metadata beside the object | None observable | Unchanged | Rewrap is invisible; changing scheme needs Batch Copy |
| S3 SSE-C | Nowhere — caller supplies per request | None observable | Unchanged | Caller-side; per-object rewrite |
| S3 Encryption Client | Object metadata headers, or a `.instruction` sibling object | Expands (GCM tag; +56 B with key commitment) | Only unauthenticated, opt-in | Impossible in place; rewrite |
| GCS CMEK | `kmsKeyName` in object metadata | None observable | Unchanged | Old versions retained; `Rewrite` to re-encrypt |
| GCS CSEK | SHA-256 of key in object metadata | None observable | Not documented | Rewrite the object |
| Azure CMK (service-side) | Account root key wrapped in Key Vault | None observable | Unchanged | Rewrap root key only |
| Azure client-side v2 | Wrapped CEK + IV in blob metadata | Expands (4 MiB regions) | Supported, via range adjustment | Download + re-upload |
| MinIO SSE-S3/-KMS | Encrypted OEK + IV + key id in object metadata | Expands (64 KiB chunks) | Supported (`sio` ranged decrypt) | True in-place rewrap |
| R2 | Provider-managed; SSE-C key caller-held | Not documented | Not documented | Not documented |
| Tigris | Provider-managed | Not documented | Not documented | Not documented |

## Streaming AEAD constructions

All four surveyed formats are variants of the same construction, **STREAM** from
*Online Authenticated-Encryption and its Nonce-Reuse Misuse-Resistance* (Hoang,
Reyhanitabar, Rogaway, Vizár), which both Tink and `age` cite by name.
[eprint 2015/189](https://eprint.iacr.org/2015/189)

The shared shape is: a per-message random value in a header, a key derived from
that value, plaintext split into fixed-size chunks, and a per-chunk nonce built
as **nonce prefix ‖ big-endian chunk counter ‖ a final-chunk flag byte**. The
flag byte is what makes truncation detectable; the counter is what makes
reordering detectable.

### Google Tink

`Header := len(Header) ‖ Salt ‖ NoncePrefix`, where the length byte is 24 or 40,
the salt is `DerivedKeySize` (16 or 32) bytes, and the nonce prefix is 7 bytes.
The segment key is `HKDF(master key, salt, associatedData)`. The per-segment IV
is `NoncePrefix ‖ i ‖ b`, `i` big-endian over 4 bytes, `b = 0x00` for
non-final and `0x01` for the final segment. Each segment carries a 16-byte GCM
tag. The first segment is shortened by the header length, so segment boundaries
are at `CiphertextSegmentSize` offsets after the header.
[AES-GCM-HKDF-STREAMING](https://developers.google.com/tink/streaming-aead/aes_gcm_hkdf_streaming)

The CTR variant is the same skeleton with the block counter appended:
`IV_i := NoncePrefix ‖ i ‖ b ‖ 0x00000000`, with the tag computed as
`HMAC(k₂, IV_i ‖ C'_i)` over the AES-CTR ciphertext, and tag sizes from 10 up to
the digest length.
[AES-CTR-HMAC-STREAMING](https://developers.google.com/tink/streaming-aead/aes_ctr_hmac_streaming)

Tink states the seeking property as a design goal: "The underlying encryption
modes are selected so that partial plaintext can be obtained fast by decrypting
and authenticating just a part of the ciphertext," and ships
`newSeekableDecryptingChannel`, whose contract is "random read access to the
plaintext… All bytes returned have been authenticated." Two restrictions are
called out: "Encryption must be done in one session. There is no possibility to
modify an existing ciphertext or append to it," and "implementations of this
interface have no protection against roll-back attacks: an attacker can always
try to restore a previous version of the file without detection."
[StreamingAead.java](https://github.com/tink-crypto/tink-java/blob/main/src/main/java/com/google/crypto/tink/StreamingAead.java)
Standard key templates fix the segment size at 4 KB or 1 MB.
[Streaming AEAD overview](https://developers.google.com/tink/streaming-aead)

### AWS Encryption SDK message format

The most metadata-rich of the four, because it carries the wrapped keys inline.
Header fields in order: `Version` (1 B), `Type` (1 B, v1 only), `Algorithm ID`
(2 B), `Message ID` (16 B in v1, 32 B in v2), `AAD Length` (2 B), `AAD`,
`Encrypted Data Key Count` (2 B), a sequence of encrypted data keys each carrying
`Key Provider ID` and `Key Provider Information` (the KMS key ARN), `Content
Type` (1 B), `Reserved` (4 B, v1 only), `IV Length` (1 B, v1 only), `Frame
Length` (4 B), `Algorithm Suite Data` (v2 only), and `Header Authentication`.

The body is framed by default: each regular frame is `Sequence Number` (4 B) ‖
`IV` ‖ `Encrypted Content` ‖ `Authentication Tag`, and "Framed data must start at
sequence number 1. Subsequent frames must be in order and must contain an
increment of 1 of the previous frame. Otherwise, the decryption process stops and
reports an error." The final frame is marked by a sentinel: "An indicator for the
final frame. The value is encoded as the 4 bytes `FF FF FF FF`," followed by the
sequence number, IV, a 4-byte `Encrypted Content Length`, ciphertext, and tag.
Non-framed content is supported "only for legacy use." Signing algorithm suites
append a footer with a length-prefixed ECDSA signature.
[Message format reference](https://docs.aws.amazon.com/encryption-sdk/latest/developer-guide/message-format.html)

This is the design that answers "there is no metadata channel" by putting the
encrypted data keys — plural, one per wrapping key — into the message itself.

### age

The tightest specification of the four, and the only one that spells out seeking
in normative language. "The binary payload… begins with a 16-byte nonce generated
by the sender from a CSPRNG. A new nonce MUST be generated for each file." Key
derivation: `payload key = HKDF-SHA-256(ikm = file key, salt = nonce, info =
"payload")`. Framing: "The payload is split in chunks of 64 KiB, and each of them
is encrypted with ChaCha20-Poly1305, using the payload key and a 12-byte nonce
composed as follows: the first 11 bytes are a big endian chunk counter starting
at zero and incrementing by one for each subsequent chunk; the last byte is 0x01
for the final chunk and 0x00 for all preceding ones. The final chunk MAY be
shorter than 64 KiB but MUST NOT be empty unless the whole payload is empty."

Seeking: "The payload can be seeked by jumping ahead in chunk increments, and
decrypting the whole chunk that contains the seeked position. Seeking relatively
to the end of file MUST first decrypt and verify that the last chunk is a valid
final chunk." Immutability: "The payload MUST NOT be modified without
re-encrypting it as a new file with a fresh nonce." Truncation: "Streaming
decryption MUST signal an error if the end of file is reached without
successfully decrypting a final chunk." The file key is 128 bits and "MUST NOT be
reused across multiple files."
[age specification](https://github.com/C2SP/C2SP/blob/main/age.md)

age also documents *why* it omits the nonce-prefix-in-AEAD-nonce trick Tink uses:
"it doesn't prefix the AEAD nonce with key material as the payload key is 256
bits… and derived from both file key and nonce."

### libsodium `crypto_secretstream_xchacha20poly1305`

The outlier: **not seekable, by construction.** The stream begins with a
`HEADERBYTES` header — defined as
`crypto_aead_xchacha20poly1305_ietf_NPUBBYTES`, i.e. 24 bytes — and each message
costs `ABYTES` = `1 + crypto_aead_xchacha20poly1305_ietf_ABYTES` = 17 bytes
(one tag byte plus the 16-byte Poly1305 tag).
[secretstream header](https://github.com/jedisct1/libsodium/blob/master/src/libsodium/include/sodium/crypto_secretstream_xchacha20poly1305.h)

The reason it cannot be seeked is visible in the implementation: after each
message, the state's inner nonce is XORed with that message's MAC —
`XOR_BUF(STATE_INONCE(state), mac, INONCEBYTES)` — before a 4-byte counter is
incremented, and the key is automatically rekeyed when the counter wraps.
Decrypting chunk *N* therefore requires having decrypted chunks 0…*N*−1.
[secretstream_xchacha20poly1305.c](https://github.com/jedisct1/libsodium/blob/master/src/libsodium/crypto_secretstream/xchacha20poly1305/secretstream_xchacha20poly1305.c)

Its tag vocabulary is richer than the others' single final-chunk flag:
`TAG_MESSAGE`, `TAG_PUSH` ("the message marks the end of a set of messages, but
not the end of the stream"), `TAG_REKEY`, and `TAG_FINAL` ("indicates that the
message marks the end of the stream").
[secretstream documentation](https://doc.libsodium.org/secret-key_cryptography/secretstream)

### Framing comparison

| Format | Chunk size | Per-chunk nonce | Per-chunk overhead | Header | Seekable |
| --- | --- | --- | --- | --- | --- |
| Tink AES-GCM-HKDF | 4 KB or 1 MB (template) | 7-B prefix ‖ 4-B counter ‖ 1-B final flag | 16 B | 24 or 40 B (self-describing) | Yes, authenticated |
| Tink AES-CTR-HMAC | 4 KB or 1 MB | prefix ‖ counter ‖ flag ‖ 4-B block counter | 10–64 B HMAC | 24 or 40 B | Yes, authenticated |
| AWS Encryption SDK | `Frame Length`, per message | 4-B sequence number + IV | 4 B + IV + tag; `FF FF FF FF` sentinel on final | Variable; carries wrapped keys | Not documented |
| age | 64 KiB fixed | 11-B counter ‖ 1-B final flag | 16 B | 16-B payload nonce + textual header | Yes, normatively specified |
| MinIO DARE 1.0 | ≤64 KB | 8-B stream nonce + 4-B sequence number | 16-B header + 16-B tag | Per-package, not per-stream | Yes (`DecryptReaderAt`) |
| libsodium secretstream | Caller's choice | MAC-chained, counter-incremented | 17 B | 24 B | **No** |

## Size-preserving alternatives

The one place a length-preserving mode is deliberately chosen over an AEAD is
where ciphertext expansion is structurally unaffordable — block-device and
filesystem encryption, where every plaintext byte must land on a specific
physical byte.

NIST approves XTS-AES exclusively for that setting and states the tradeoff
without hedging: it is approved "as an option for protecting the confidentiality
of data on storage devices," and "the mode does not provide authentication of the
data or its source."
[SP 800-38E](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38e.pdf)

Linux fscrypt gives the rationale explicitly: "Authenticated encryption modes are
not currently supported because of the difficulty of dealing with ciphertext
expansion. Therefore, contents encryption uses a block cipher in XTS mode or
CBC-ESSIV mode, or a wide-block cipher," with "(AES-256-XTS, AES-256-CBC-CTS)…
the recommended default."
[fscrypt.rst](https://github.com/torvalds/linux/blob/master/Documentation/filesystems/fscrypt.rst)

dm-crypt shows what integrity costs when you want it back: authenticated
encryption requires an `integrity:<bytes>:aead` mapping, where "the device
requires additional `<bytes>` metadata per-sector stored in per-bio integrity
structure. This metadata must by provided by underlying dm-integrity target… The
additional space is then used for storing authentication tag (and persistent IV
if needed)." In other words, the AEAD is available only by adding a separate
per-sector metadata area — the block-device equivalent of adding a metadata
channel.
[dm-crypt.rst](https://github.com/torvalds/linux/blob/master/Documentation/admin-guide/device-mapper/dm-crypt.rst)

Amazon EBS is the envelope-over-length-preserving example at cloud scale:
"Amazon EBS encrypts your volume with a data key using industry-standard AES-256
data encryption. The data key is generated by AWS KMS and then encrypted by AWS
KMS with a AWS KMS key prior to being stored with your volume information," and
"Amazon EC2 uses the plaintext data key in the Nitro hardware to encrypt disk I/O
to the volume."
[How EBS encryption works](https://docs.aws.amazon.com/ebs/latest/userguide/how-ebs-encryption-works.html)

**Not answered by the primary source:** that EBS page names AES-256 but does not
name the mode, so it is not evidence that EBS uses XTS specifically.

It is worth noting that the S3 Encryption Client classifies AES-CTR alongside
AES-CBC as an unauthenticated legacy suite requiring
`enableLegacyUnauthenticatedModes` to decrypt at all — unless it is "AES-CTR with
key commitment," which is accepted even under the strictest commitment policy.
[Supported encryption algorithms](https://docs.aws.amazon.com/amazon-s3-encryption-client/latest/developerguide/encryption-algorithms.html)

## Envelope encryption and rotation in practice

The consistent finding across every vendor: **rotating a master key does not
re-encrypt data.**

AWS KMS is the bluntest: "Key rotation has no effect on the data that the KMS key
protects. It does not rotate the data keys that the KMS key generated or
re-encrypt any data protected by the KMS key." Old key material is retained
indefinitely — "AWS KMS retains all key material for a KMS key with `AWS_KMS`
origin, even if key rotation is disabled" — and selection is automatic: "When you
use the rotated KMS key to decrypt ciphertext, AWS KMS uses the same version of
the key material that was used to encrypt it. You cannot select a particular
version of the key material for decrypt operations."
[Rotate AWS KMS keys](https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html)

GCS CMEK behaves identically at the object layer, and re-encryption of *N*
million objects is an explicitly separate bulk `Rewrite` job. Azure re-wraps a
single account-level root key and leaves data untouched. MinIO is the only
in-place rewrap in the survey, and it works precisely because there is a
mutable per-object metadata slot holding the wrapped OEK and the master key id.
The Amazon S3 Encryption Client is the counterexample that proves the rule: with
immutable S3 object metadata and no separate mutable slot, "it is not possible to
change the encrypted data key associated with the object without changing the
object."

The practical taxonomy is therefore three-way, not two-way:

1. **Rewrap in place** — needs a mutable per-object metadata slot (MinIO).
2. **Never rewrap; keep old key versions alive forever** — needs only a key
   version identifier recorded with the ciphertext, and is what AWS KMS, GCS
   CMEK, and Azure CMK all actually ship.
3. **Rewrite every object** — the fallback everywhere else (S3 Batch Copy, GCS
   `Rewrite`, SSE-C `COPY` onto itself, Azure client-side v1→v2 migration).

## What transfers to AckerDB's `FileStore` port

Port facts this section is measured against, read from `origin/canary`:
`packages/server/src/files/store/contract.ts` defines `probe`, `put(key, body,
{contentLength}) → {size, sha256}`, `open(key, {range}) → {attributes, range?,
body}`, `attributes(key) → {size, lastModified, etag?}`, `delete(key)`. There is
no per-object metadata channel. `LocalFileStore.attributes()` returns
`stat.size`, and `LocalFileStore.open()` calls `assertRange(range,
attributes.size)` against that same on-disk size
(`packages/server/src/files/store/local.ts`). Object keys are `files/<uuid>` and
survive store migration unchanged.

### Fits the port unchanged

- **Provider server-side encryption** (S3 SSE-S3/SSE-KMS/DSSE-KMS, GCS CMEK,
  Azure CMK, R2 and Tigris always-on). It sits *below* the object abstraction, so
  size, ranged `GET`, and hashing are unaffected — which is exactly why
  `s3-configuration.ts` can already default `encryption` to `{ type: "AES256" }`
  with no other code aware of it. It has no local-filesystem analogue inside the
  port; the operator-level equivalent (LUKS/dm-crypt/fscrypt under the data
  directory) is equally invisible to the port and equally outside it.
- **SSE-C with a single deployment-wide key.** The port has nowhere to record
  *which* key encrypted an object, and every SSE-C implementation surveyed
  (S3, R2, MinIO) stores only a key *fingerprint* — R2's MD5 is "for
  identification of keys only," GCS stores the key's SHA-256 — which lets the
  provider reject a wrong key but does not let AckerDB discover the right one. So
  SSE-C is usable only if there is exactly one key per deployment at a time.
  Rotation then requires re-`put`ting every object, since the port has no
  server-side copy operation. S3 additionally disabled SSE-C by default for new
  buckets in April 2026, which makes it a weak choice for a framework default.

### Requires adding a metadata channel

- **Amazon S3 Encryption Client's default mode** and **Azure client-side
  encryption** — both store the wrapped CEK/data key in provider object metadata.
  The port's `put` returns only `{size, sha256}` and `open` returns only
  `{attributes, range?, body}`; there is no slot to write to or read from. This
  is ground truth #7 in the map, confirmed against two independent vendor
  implementations.
- **MinIO-style in-place rewrap.** Rewrap without rewriting bytes is only
  possible against a mutable per-object metadata slot. Without one, AckerDB
  cannot express MinIO's rotation at all.

### Fits the port as a decorator, with three repairs

**Client-side envelope with the key material in an object-prefixed header, over
chunked AEAD** — Tink, `age`, the AWS Encryption SDK, and DARE. Nothing
per-object needs to live outside the bytes: salt/nonce, key version, and the
wrapped data key all fit in the header, exactly as the AWS Encryption SDK's
`Encrypted Data Key(s)` field demonstrates. The S3 Encryption Client's
**instruction file** is the alternative precedent — a sibling object at
`<key>.instruction` — but it would double the object count and add a second
delete to every cleanup path, and the header approach dominates it here.

Three things break and must be repaired inside the decorator:

1. **`put` must return the plaintext SHA-256 and plaintext size.** The inner
   store computes the hash of what it actually wrote, which is ciphertext. The
   decorator has to hash the plaintext on the way in and discard the inner
   result. Four consumers depend on that value being the plaintext hash (upload
   `expectedSha256`, the HTTP `ETag`/`Digest` headers, backup verification, and
   store-migration verification). `contentLength` passed inward must likewise be
   the *encrypted* length, computed from the plaintext length before streaming.
2. **`attributes.size` must report plaintext length.** The inner store reports
   stored size. This is solvable *without* new metadata only because chunked
   framing makes the mapping a pure invertible function of size — MinIO ships it
   as `sio.DecryptedSize`, and age's fixed 64 KiB / 16-byte-tag framing is
   equally invertible. Tink's header is 24 *or* 40 bytes, self-describing in its
   first byte, so a Tink-shaped framing would cost one extra ranged read per
   `attributes()` call unless the parameters are pinned. **A fixed chunk size and
   fixed header length is therefore a hard requirement, not a preference.**
3. **`open({range})` must translate ranges.** The decorator must run its own
   `assertRange` against the plaintext size *before* delegating (the inner store
   validates against the stored size), widen the range to chunk boundaries, and
   trim the decrypted prefix/suffix. This is exactly what Azure documents as
   "adjusting the range provided by users to get a small amount of additional
   data," and what age specifies as "jumping ahead in chunk increments, and
   decrypting the whole chunk that contains the seeked position."

### Does not fit at all

- **Whole-object single AEAD.** The S3 Encryption Client's default AES-GCM blob
  cannot serve an authenticated ranged read; its own remedy is an opt-in
  unauthenticated mode described as "a temporary fix," and its default is to
  buffer the entire object in memory. AckerDB's HTTP layer serves ranges, so this
  shape is unusable as-is.
- **libsodium `secretstream`.** MAC-chained state makes chunk *N* undecryptable
  without chunks 0…*N*−1. No ranged read.

### Size-preserving CTR/XTS: the one shape that changes nothing

CTR or XTS leaves `put.size`, `attributes.size`, and range translation all
identity operations, so none of the three repairs above is needed, and `open`,
`attributes`, backup, and migration keep working byte-for-byte. The precedent is
real and standardized, and its cost is exactly what NIST states: no
authentication.

Two AckerDB-specific observations sharpen this:

- AckerDB already stores a whole-file plaintext SHA-256 in `_ackerdb_files` and
  re-verifies it in backup and store migration, so it already has the whole-object
  integrity anchor that fscrypt and dm-crypt lack. But a whole-file digest cannot
  authenticate a *ranged* read without reading the whole file, so it is not a
  substitute for per-chunk tags at the `open({range})` boundary.
- A size-preserving mode needs a unique per-object nonce/tweak with no metadata
  channel to store one. The only per-object value available is the object key
  itself, `files/<uuid>` — unique per File, opaque, and preserved unchanged
  across store migration. Deriving the IV/tweak from the object key is therefore
  the only derivation the port actually permits, and it is safe precisely because
  keys are fresh UUIDs and never reused. Any scheme that would reuse an object
  key for different content would be a keystream-reuse bug.

### Rotation, expressed against this port

With the wrapped key in an object header and no partial-write operation on the
port (`put` takes a whole body with an exact `contentLength`), MinIO-style rewrap
is unavailable and the choices reduce to:

1. **Key-version byte in the header, old KEKs retained.** New writes use the
   current key; reads decrypt under whatever version the header names. This needs
   **no port change and no schema change**, and it is what AWS KMS, GCS CMEK, and
   Azure CMK all actually do. It is the option the evidence points at.
2. **Full rewrite job.** Read, decrypt, re-encrypt, re-`put` every object. This
   is what S3 Batch Copy, GCS `Rewrite`, and SSE-C `COPY` all are, and it is
   precisely what `migrateFileStore` is documented never to do ("this operation
   never deletes source bytes or mutates database metadata").
3. **Add a metadata column and rewrap.** Only reachable by widening the port and
   `_ackerdb_files`.

### Threat model, confirmed

Every server-side scheme surveyed defends against the storage substrate, not
against the service. S3 holds the plaintext data key in memory during the
operation; MinIO's OEK "only [resides] in RAM during the en/decryption process";
Azure unwraps the account key on every read. Only SSE-C, CSEK, and client-side
encryption move the key out of the provider, and all three vendors then state the
same consequence in near-identical words — AWS: "if you lose the encryption key,
you lose the object"; Google: "you are no longer able to read your data";
Cloudflare: "Cloudflare will be unable to recover the body of any objects
encrypted using those keys." This is ground truth #2 of the map, independently
confirmed three times.

## Questions the primary sources did not answer

- Whether GCS supports ranged reads on CSEK-encrypted objects.
- Whether R2 or Tigris change object size, or how they behave on ranged reads,
  under SSE-C — neither documents it.
- Which block-cipher mode Amazon EBS uses; the encryption page names AES-256 but
  not the mode.
- Whether MinIO's server-side "Secure Channel" is literally the DARE format; the
  two documents agree on chunk size and cipher pair but neither states the
  binding.
- Whether the AWS Encryption SDK supports seeking to an arbitrary plaintext
  offset; the message format makes it structurally possible (fixed `Frame
  Length`, monotonic sequence numbers) but no AWS document states it as a
  supported operation.
