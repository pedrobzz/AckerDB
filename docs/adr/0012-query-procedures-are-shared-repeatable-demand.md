---
status: accepted
---

# Query procedures are shared repeatable demand

A query procedure observes an ordinary procedure through the same query-shaped
client state as a live query, without introducing a new server function kind or
enforcing idempotence. The application owns the promise that the procedure is
safe to execute repeatedly. Committed consumers in one client lifetime share a
single observation when the procedure address, canonical arguments, and
configuration are equal; that observation owns one execution, refresh schedule,
and result state until its final consumer leaves.

A fresh execution starts for initial demand, changed arguments or configuration,
manual refresh, a configured completion-based interval, or connection recovery.
Executions never overlap; refresh demand arriving during an execution coalesces
into one trailing execution. Failures, including indeterminate outcomes, update
the query-shaped state but never create failure-specific retries. A server
`retryAfterMs` hint may delay the next configured automatic refresh, while the
void-returning `refresh()` remains immediate explicit demand. The exact state
snapshot and `refresh` function are shared and stable for the lifetime of that
observation; changing its address, arguments, or configuration creates a new
observation with a new identity.

The sole option is an optional positive safe-integer `refreshIntervalMs`;
omitting it disables automatic polling. Different configurations are different
observations and do not deduplicate. In-flight procedure work remains
non-resumable: cancellation, provider retirement, or native suspension settles
that execution under the ordinary procedure contract, while surviving
query-procedure demand may start a new execution after recovery.
