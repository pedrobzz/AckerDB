# Exact vector search streams database-filtered candidates

AckerDB V1 stores fixed-dimensional Float32 vectors and supports only exact
cosine, L2, and dot-distance nearest search. SQLite evaluates typed predicates
and uses ordinary indexes first; AckerDB streams only eligible primary keys and
vector blobs through NumKong's native kernels, retains bounded top-k state, and
materializes only winners inside the same SQLite snapshot. Embedding generation
remains outside AckerDB.

Approximate search, vector indexes, stored norm companions, workers, and custom
SQLite builds are excluded. A focused SQLite extension could reduce per-row
boundary overhead, but on macOS it would also require replacing Bun's faster
SQLite and would make AckerDB own a cross-platform native SQLite release matrix.
That machinery is justified only if later end-to-end evidence shows the simple
SQL-prefiltered streaming design misses an agreed product target by enough to
pay for it.
