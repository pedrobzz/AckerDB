# Reactive execution root: subscriber work runs in the reactive system's own context

Subscription re-evaluation and event delivery execute application code *on
behalf of subscribers*, but they used to run in whatever async context happened
to trigger them. Async context flows implicitly through every async hop, so
when a commit landed inside a handler's still-open invocation scope (`ctx.tx`
in MCP tools, procedures, SSE procedures), each affected subscriber's query
re-ran looking like a *nested invocation under the mutator's principal* — and
the confused-deputy guard correctly revoked it. Symptom: every live dashboard
subscription errored `unauthorized` the moment any MCP action committed. The
unstated invariant "nothing commits while an invocation scope is ambient" held
only for WS mutations, whose transaction *contains* the handler invocation
rather than the reverse — an accident of containment order, not a design.

We decided the reactive system owns its execution context: `OrderedReactive`
captures a pristine context snapshot at construction (the runtime is built
before any request exists) and runs **subscriber-facing work** — the
application-code boundary: query re-evaluation and event-listener matching —
under that root. A subscriber evaluation's context derives from the
subscription alone (its principal, its fairness key); the identity of whatever
triggered the commit is irrelevant to it. The root deliberately wraps *only*
the application-code calls, not the surrounding bookkeeping: observer calls
stay on the ambient causal chain, because evaluation spans correlate to their
triggering operation through the trace context, and severing that would trade
an authority leak for an observability one. Authority must never cross a
scheduling boundary implicitly; diagnostic causality should. This makes an existing house rule structural: **async context never
crosses a scheduling boundary implicitly** — the commit coordinator already
follows it by passing an explicit snapshot when telemetry needs to cross.

## Considered options

- **Detach context at every executor boundary**: rejected — the commit
  coordinator deliberately *restores* the caller's context snapshot around
  commit + publication for telemetry correlation, which re-leaks past any
  executor-level detach; and the reader executor serves direct queries whose
  trace context legitimately should flow.
- **Detach at `ctx.tx` entry**: rejected — transaction bodies are application
  code; exiting invocation context around them would blind the confused-deputy
  guard inside transactions, a security regression.
- **Per-call-site detach in the query evaluator** (the first attempted patch):
  rejected — it fixes one symptom site, leaves event delivery and every future
  subscriber-work site leaky, and puts context ownership in each callee
  instead of the one owner.

## Consequences

Every commit path — WS mutation, MCP tool, procedure, SSE procedure, and
anything added later — now lands identically: commit → publication → each
subscriber re-evaluated under its own principal inside the reactive root.
Tripping the confused-deputy guard is now always a genuine context bug, never
reactive fallout, and it reports `invocation context principal mismatch` —
distinct from policy denials, so it can't be mistaken for an access rule
firing. Any new runtime subsystem that executes application code on others'
behalf must own an execution root the same way.
