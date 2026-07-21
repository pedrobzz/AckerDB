# SQLite and no-clobber publication coordinate database ownership

Every file-backed DBZZ database has one persistent same-directory SQLite
coordination database. DBZZ brands it with a fixed `application_id`, requires
an empty schema and DELETE journal mode, and holds `BEGIN IMMEDIATE` for the
lifetime of startup, restore, reset, or any other canonical owner. A staged
restore Engine borrows that same ownership connection. The canonical
coordination database is never deleted, renamed, reaped, or treated as
application data.

## Decision

A missing coordination database is initialized in a unique same-directory
`0600` UUIDv4 staging file. DBZZ commits its identity, closes and fsyncs it,
then hard-links it to the canonical path without clobbering a winner. Every
contender removes its own stage after the link attempt.

Before any contender opens canonical SQLite, it scans only strict DBZZ
coordination staging names and removes only aliases whose bigint `(dev, ino)`
match the canonical file. Concurrent removal tolerates `ENOENT`. The canonical
file must then have exactly one hard link, and the parent directory is fsynced.
Only after that convergence does DBZZ open canonical SQLite, set
`busy_timeout=0`, retain `BEGIN IMMEDIATE`, and validate the immutable identity,
empty schema, and journal mode. Only the exact `SQLITE_BUSY`/errno 5 pair means
already open; there is no retry, timeout, polling, or owner record.

A process killed before publication leaves a different-inode, single-link
stage. DBZZ preserves it because pathname shape cannot prove ownership. A
process killed after publication may leave a same-inode, two-link alias. The
next acquisition removes that proven alias before opening the canonical inode.
Once canonical SQLite is open, DBZZ performs no publication-alias cleanup.

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

## Consequences

The steady cost is one small persistent file, one parent-directory sync per
acquisition, and one idle SQLite handle per live database. There is no polling
or background work. Foreign identities, nonempty schemas, corruption,
non-DELETE journal modes, and unproven extra hard links fail closed.

Startup, restore, and reset cannot race because they acquire the same primitive.
`SIGKILL` releases the retained transaction through the OS. Full reset removes
only the canonical application database family and exact application
initialization/restore stages; it retains the coordination database,
different-inode coordination crash residues, and unrelated files. Restore's
vacant-directory check accepts those exact internal residues without deleting
them.
