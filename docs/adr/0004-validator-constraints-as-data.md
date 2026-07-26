# Validator constraints are data, and stored tightenings are optimistic

AckerDB admits only declarative, serializable validator constraints: the same
constraint must drive runtime validation, generated protocol schemas, schema
snapshots, and migration checks. Arbitrary closure-based refinements are
excluded because they cannot become durable schema facts. Loosening a stored
constraint is shape-safe; tightening one is optimistic — apply it immediately
when every stored value already complies, otherwise refuse without touching
data and require a volunteered row transform. Function-input constraints remain
invocation-only because they govern no stored data.

## Considered options

- **Function-input constraints only**: rejected because serializable constraints
  can be enforced soundly for stored rows by the existing migration model.
- **Write-time-only stored refinements**: rejected because existing rows could
  silently violate a declared schema that migrations cannot inspect.
- **Every tightening requires a migration file**: rejected because a transform
  would be ceremony when all stored values already comply.

## Consequences

Constraint rules must have one canonical descriptor form and cannot depend on
application closures. A regex change is always treated as a tightening because
the system does not try to prove implication between patterns. Constraints do
not change TypeScript value types, so they do not weaken migration pre-snapshot
type soundness.
