# SQLite and no-clobber publication coordinate database ownership

Every file-backed AckerDB database has one persistent same-directory SQLite
coordination database. AckerDB brands it with a fixed `application_id`, requires
an empty schema and DELETE journal mode, and holds `BEGIN IMMEDIATE` for the
lifetime of startup, restore, reset, or any other canonical owner. A staged
restore Engine borrows that same ownership connection. The canonical
coordination database is never deleted, renamed, reaped, or treated as
application data.

Ownership first resolves one absolute canonical data pathname. Existing final
symbolic links resolve to their target, dangling final links resolve to their
missing target when its parent exists, and symbolic-link parents resolve before
the filename is appended. The Engine uses the returned path for the main file,
SQLite sidecars, initialization and restore artifacts, reporting, and reset;
the spelling supplied by the caller is never a second storage path. A fresh
restore target may have symbolic-link parents but may not itself be a symbolic
link, because that entry violates restore's vacant-target invariant.

## Decision

A missing coordination database is initialized in a unique same-directory
`0600` UUIDv4 staging file. AckerDB commits its identity, closes and fsyncs it,
then hard-links it to the canonical path without clobbering a winner. Every
contender removes its own stage after the link attempt.

Before any contender opens canonical SQLite, it scans only strict AckerDB
coordination staging names and removes only aliases whose bigint `(dev, ino)`
match the canonical file. Concurrent removal tolerates `ENOENT`. The canonical
file must then have exactly one hard link, and the parent directory is fsynced.
Only after that convergence does AckerDB open canonical SQLite, set
`busy_timeout=0`, retain `BEGIN IMMEDIATE`, and validate the immutable identity,
empty schema, and journal mode. Only the exact `SQLITE_BUSY`/errno 5 pair means
already open; there is no retry, timeout, polling, or owner record.

While that transaction is retained, and before any data SQLite connection is
opened, AckerDB checks the canonical data inode. It removes only exact UUIDv4
`ackerdb-init` or `ackerdb-restore` main-file stages whose bigint `(dev, ino)` match
the canonical file, then syncs the parent directory. These are the hard-link
publication aliases AckerDB can prove it owns. The canonical data file must then
have exactly one hard link. Any remaining hard link is unproven and fails
closed without deleting either pathname.

For coordination publication, a process killed before publication leaves a
different-inode, single-link stage. AckerDB preserves it because pathname shape
cannot prove ownership. A process killed after coordination publication may
leave a same-inode, two-link alias; the next acquisition removes that proven
alias before opening the coordination inode. For data publication, same-inode
aliases are removed under the retained coordination transaction, while
different-inode init and restore stages continue through their existing exact
recovery rules after ownership. Once the corresponding SQLite file is open,
AckerDB performs no publication-alias cleanup.

## Why

A pathname owner record cannot safely reclaim or release ownership with the
filesystem primitives available here: checking an owner and then renaming or
deleting its path has an ABA window in which a live replacement can be removed.
SQLite already provides OS-lifetime locking, immediate release on process
death, crash recovery, and a stable typed contention result.

SQLite cannot, however, safely initialize the shared coordination pathname
while contenders are already opening it. Stress tests rejected both apparent
shortcuts:

- `BEGIN IMMEDIATE` elected one writer, but failed contenders transiently held
  shared locks and made the first identity `COMMIT` fail in 5 of 20 thirty-way
  runs, with 12 generic commit errors in total.
- `BEGIN EXCLUSIVE` avoided that commit race but produced no winner in 40 of
  100 aligned virgin two-process races.

Private initialization plus hard-link publication produced exactly one winner
with no generic errors or publication residue in 100 of 100 aligned two-process
runs and 100 of 100 thirty-process runs. Both pre-link and post-link `SIGKILL`
windows were exercised.

Ordering is part of the invariant on macOS. Removing a same-inode staging alias
after canonical SQLite connections were open produced `SQLITE_IOERR_VNODE` in
3 of 100 thirty-way runs. Alias convergence therefore happens before canonical
open, not as later scavenging.

Pathname canonicalization closes the ordinary symbolic-link alias split: real
and alias contenders derive the same coordination file, and a gated thirty-way
cross-process race still elects exactly one owner. Hard links have no unique
pathname to resolve to. Requiring a single data link, with the narrow
publication-stage exception above, is the only deterministic filesystem rule
that neither invents an owner registry nor scans and deletes unknown paths.

## Consequences

The steady cost is one small persistent file, one parent-directory sync per
acquisition, and one idle SQLite handle per live database. Acquisition also
resolves the data path and stats its main file; it scans data-stage names only
when that file actually has multiple links. There is no polling or background
work. Foreign identities, nonempty schemas, corruption,
non-DELETE journal modes, and unproven extra hard links fail closed. File-backed
Engine paths and reset results expose the canonical absolute pathname.

Startup, restore, and reset cannot race because they acquire the same primitive.
`SIGKILL` releases the retained transaction through the OS. Full reset removes
only the canonical application database family and exact application
initialization/restore stages; it retains the coordination database,
different-inode coordination crash residues, and unrelated files. Restore's
vacant-directory check accepts those exact internal residues without deleting
them.
