# PROTOTYPE — Application source topologies

This is disposable evidence for the Wayfinder ticket
[Prototype: one mixed source root without a type or import fixed point](https://github.com/pedrobzz/AckerDB/issues/304).
It is not production code and none of its interfaces are proposals to preserve.

## Question

Which authoring, discovery, and code-generation topology can give AckerDB one
renameable mixed source root, exact types, complete runtime descriptors, inert
planning, canonical module identity, and less machinery than today's Plugin,
Service, Job, and Function assembly paths?

The runner executes the same fixture through four deliberately different
topologies:

0. folder-only consolidation (control);
1. generated dual indexes with inference-first types;
2. a TypeScript-compiler-materialized manifest;
3. captured pure evaluation with bootstrap/refinement.

It writes separately inspectable membership, type, descriptor, and lifecycle
outputs for each candidate, records deliberate failure cases, exercises source
mutations, and measures TypeScript at 10, 100, and 1,000 mostly-server modules.

## Run

```sh
bun packages/cli/prototype/application-source-topologies/run.ts
```

Then open:

```text
packages/cli/prototype/application-source-topologies/output/prototype.html
```

The HTML is self-contained and can also be opened by double-clicking it. Use
the candidate tabs and guided scenarios to decide whether the evidence and the
recommended compiler-materialized topology feel right.
