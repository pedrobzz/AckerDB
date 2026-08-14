# The Admin Credential has one definition and three issuers; an authority change never closes the door carrying its own answer

> Amended: the two mentions of "protocol version 7" below name a constant that
> no longer exists. The TTL disclosure gaining `null` is unchanged and is still
> a wire change; what changed is that a wire change no longer moves a separate
> number. A frame declares the AckerDB version that produced it, and a decoder
> accepts exactly its own — so the skew this decision worried about is still one
> refusal at the first frame, named as the mixed install it is. Read "and the
> protocol version is 7" as "and this is a wire change, which the AckerDB
> version already covers".

An application had no way to be administered. `FRAMEWORK_SCOPES` had just been
filled by [ADR-0026](0026-administration-is-a-first-class-surface.md), so a
grant of `["*", "_*"]` finally expanded to real authority — and nothing in the
framework ever issued one. The vault could mint it (`systemCredentials.create`
with a null parent, already documented), but only application code could ask,
which is exactly backwards for the credential an operator needs *before* they
have written any.

Three separate things had to be decided, and each one had a cheap wrong answer
sitting right next to it.

**An Admin Credential is a root credential whose stored grant is exactly
`["*", "_*"]`.** There is no column, no marker, and no flag. The vault owns that
one predicate, and boot-mint, rotation and the offline reset all call it.

## The definition is on the patterns as written, and on rootness

The alternative — "its expansion covers the whole vocabulary" — reads more
principled and is wrong the first time an application declares a scope. A
credential enumerating every scope that existed on Tuesday stops being
administrative on Wednesday, without anyone touching it, and the offline reset
would then leave behind a row the next boot no longer counts. Authority is what
a grant expands to; *kind* is what it says.

Rootness is half the definition rather than a filter on top of it. A child
holding the same two patterns is a delegate: its live authority is intersected
with its parent's at every use, so it is bounded by a master rather than being
one. Counting it would make a rotation revoke credentials that never were
masters, and it would put a credential inside the set that a revocation of
another member of that set cascades away.

## Rotation replaces the credential; it does not re-key it

The obvious shape is a `rotateSecret(tokenId)` that re-randomizes the secret on
the same row, keeping the administrative Identity stable. It cannot work. The
auth-invalidation channel names a credential by `(issuer, subject)`, and the
subject is the token id — so an old secret and its replacement sharing one id
are one subject, and "terminate the leaked secret's live sessions but not the
new one's" is not expressible. A rotation whose entire purpose is to defeat a
leaked secret must produce a different subject.

So rotation mints a new root credential and revokes every credential that was
administrative before the mint, in one transaction. The two are live together
for the length of that transaction, which is the whole of "no downtime": the
replacement already authenticates when the old one stops.

The price is real and we accept it. The administrative Identity changes, because
a credential *is* an Identity; Files owned by the old one keep pointing at an
Identity no credential answers to. The
orphaned row is left where every other revocation already leaves one — `revoke`
has always deleted credential rows and never identities — because a cleanup
special-cased to this one credential kind is the patch, not the fix. One row per
rotation, on a table whose primary key is an integer, is not a cost worth
distorting the model for. And credentials delegated beneath the old master go
with it, by the ordinary cascade: a child of a revoked parent has no source left
to be bounded by.

## Rotation replaces the credential it was called with, and only that

A root credential has no parent to narrow it at use, so whatever bounds it has
to hold entirely at issuance. The first bound we reached for was the subset
invariant — a caller may only mint what its own grant already expands to — and
it is not enough.

It admits a *child* credential issued `["*", "_*"]` beneath a master. Its
effective grant is intersected with its parent's, so it covers the whole
vocabulary, and minting a root from there trades authority the parent can narrow
at any moment for authority nobody can. That is an escalation in permanence
rather than in reach, and it is exactly the persistence that
[ADR-0026](0026-administration-is-a-first-class-surface.md)'s successor kept
credential administration off the MCP tool record to prevent. It admits a
resolver-backed user granted `_admin:*` too, who is not in the master set at
all — so its own credential would survive a rotation that destroyed the
operator's.

**The caller must be one of the Admin Credentials being replaced.** That is a
strictly stronger statement than covering the vocabulary — a root credential
holding those two patterns covers it by construction — so it subsumes the subset
check rather than adding to it, and there is one condition rather than two. It
is also just what rotation means: the master replacing itself. The comparison is
on the Identity, the credential row's own unique key, rather than on a token id
whose shape an external provider also gets to choose.

A consequence worth stating: with no master present, nobody can rotate. That is
correct. There is no administrative credential to replace, and the path back is
a restart, which mints one.

## The three issuers exist because they fail differently

**Boot-mint** covers "there is nothing yet": on startup, a server whose vault
holds no master issues one and prints the plaintext once. It is fatal when it
fails. A server nobody can administer, that printed nothing to say so, is
discovered at the moment administration is most needed — and "serve anyway" is
the outcome an operator cannot detect, which makes it the worse of the two.

**Rotation** covers "it still works, and should not": routine replacement, and
the answer to a suspected leak.

**Break-glass** covers "nothing works": `acker credential reset` opens the
database file, clears the masters by the same vault predicate, and leaves the
next boot to issue a fresh one. It imports no application, because lockout and a
broken build arrive together often enough that the recovery path must not depend
on the code that may be what broke. "Server stopped" is the database ownership
lock rather than a check of its own — a second liveness test is a second thing
that can disagree with the first.

## A committed authority change is withheld from its own origin until handoff

Revoking the credential you are authenticated with is not an edge case; it is
what rotation *is*. The publication was immediate and unfiltered, so the
revocation reached the connection carrying the new plaintext before that answer
had left: on a WebSocket the session terminated and discarded the result frame,
and on the MCP endpoint the tool call's own abort signal fired. The exposed HTTP
door survived only because its body happened to be encoded inside the
transaction — an accident of ordering, not a guarantee.

**A commit now carries its originating principal's own subscription, and an
invalidation naming that principal is withheld from it until the transport has
handed off the response.** Every other holder is still cancelled at commit; the
origin follows immediately after. This is not new machinery: it is the deferral
`ctx.unlinkAccount` already used, finally wired to the other kind of authority
change.

For it to mean anything, every subscriber had to be addressable. The boundary
kept two registries — one excludable, one not — and the unexcludable one was the
door every MCP call goes through, so an exclusion that could not reach it was an
exclusion with a hole in it. There is now one registry, and every subscription
mints a scope.

The loss this prevents is unrecoverable by design. The token-bearing result is
marked non-replayable, so a retry answers with a receipt and never a second
secret — and the old credential is already gone. Rotation is not retry-safe and
was never going to be; it is response-handoff-safe instead, which is what the
origin exclusion buys.

One window stays open and we accept it: an answer lost *after* the commit — a
dropped connection, or a post-commit convergence failure — takes the plaintext
with it. Escrowing the secret until delivery was rejected, because it would put
the one thing this design keeps out of storage into storage, and the property
that only a digest is ever at rest is worth more than removing a window that
break-glass already covers. The failure is at least legible: a committed outcome
reports `committed: true`, so a caller can tell it apart from a call that never
landed. It is why boot-mint prints before it checks for shutdown, and why the
offline reset exists at all.

## A credential that does not expire discloses `null`, and the protocol says so

Making the Admin Credential work over the client stack surfaced a defect that
had never been reachable: an identity credential's `expiresAt` is
`Number.POSITIVE_INFINITY`, and the welcome frame's credential TTL disclosure is
that value minus now. The result is `Infinity`, the wire contract requires a
non-negative safe integer, and the session died on its own welcome frame. No
identity credential could authenticate over WebSocket at all, though the
documentation said all three transports worked.

The disclosure is now `number | null`, `null` meaning the credential does not
expire. A finite stand-in was rejected: it is a
lie the client schedules a pointless re-pull against, and clamping to a large
integer hides the one fact the field exists to communicate. Omitting the field
was rejected too — a client must never have to read silence as a value — so it
stays required and gains an honest one.

## Two costs accepted deliberately

**The deferral is per subscription, not per operation.** A WebSocket session
subscribes once for every operation on it, and one MCP POST holds one lease for
its whole batch, so a concurrent call on that connection keeps the revoked
credential until the rotating call's answer lands. Narrowing it would mean a
subscription per operation on a long-lived session, plus a partial termination
that keeps a socket open for exactly one more frame. The window is bounded by
one response, and the sharer is the same principal by construction — one
connection carries one credential — so the purchase is a moment more use of an
authority the caller already held and is itself retiring, not a boundary anyone
crosses.

**Boot-mint competes for the root capacity bucket.** Rotation does not, because
it revokes before it mints and a failed mint rolls both back; a full bucket is
exactly what a rotation makes room in. Boot-mint has nothing to revoke, so a
database holding `maxPerIdentity` standalone credentials and no master cannot
start. Reserving a slot for the framework's own credential was rejected: it is a
special case inside the one capacity rule, for a state the framework's own paths
cannot produce. The master is minted before any application code runs, so an
application can only ever fill the bucket to one below the limit, and clearing
the master frees the slot the next boot needs. Reaching it requires lowering
`maxPerIdentity` under an already-populated database — the same class of change
as shrinking any other limit under live data.

## Consequences

- `_admin:credentials:read` and `_admin:credentials:write` join the framework
  vocabulary; `admin.credentials.list` and `admin.credentials.rotate` join the
  `admin` group. Neither is exposed as an MCP tool: the subset invariant blocks
  escalation but not persistence, and issuing authority is the one operation
  whose product is authority.
- `admin.credentials.list` is a query and `rotate` is a mutation, because the
  credential capability is bound for reads and writes and never for procedure
  contexts. That split is what keeps "a write needs a write set" a type rather
  than a runtime assertion, and it was not widened for uniformity.
- Every fresh database now spends Identity 1 and one commit version on the
  master. Subsequent starts write nothing.
- This is a wire change, and it needs no separate number to be one: packages
  ship lockstep, so a 0.17 client meets a 0.18 server as one refusal on the
  first frame either sends.
- `AuthInvalidationBoundary.subscribeDirect` returns a subscription with a scope,
  like every other subscription. `publishCredentialInvalidations` is gone; a
  commit request carries `publishAuthInvalidation` instead, defaulting to the
  Runtime's immediate fan-out for commits the framework itself originates.
- `acker credential reset [app-dir]` is the third command that works against a
  stopped database without importing an application, after `acker reset` and
  `acker status`.
