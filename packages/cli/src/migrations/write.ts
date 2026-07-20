/**
 * Migration generation, on disk: re-derive pre/target fresh and lay the three
 * artifacts of the next migration onto disk. The pure string computation lives in
 * `scaffold.ts`; this module is generation's filesystem half — it reads the stored
 * state and optimistic probes from its sibling `plan.ts`, validates that a new
 * migration may be written at all, and owns the `migrations/` + `meta/` layout.
 * The single generation path behind both `dbz generate` and the `__generate` child.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  snapshotOf,
  validateHistoryPrefix,
  type Renames,
} from "@dbzz/server";
import { importSchema } from "../app.ts";
import type { AppConfig } from "../config.ts";
import { loadMigrationChain, migrationArtifactPaths, MIGRATION_NAME } from "./load.ts";
import { planFingerprint, probeOptimisticRefusals, readStoredState } from "./plan.ts";
import { generateMigration } from "./scaffold.ts";

/**
 * Consent that no longer matches the plan on disk: the schema moved between
 * the ledger the developer said yes to and this write. Nothing is written; the
 * caller re-plans, shows the fresh ledger, and asks again.
 */
export class StaleConsentError extends Error {}

export interface GenerateRequest {
  name: string;
  renames?: Renames;
  /** The fingerprint of the ledger the developer consented to (see `planFingerprint`). */
  consent?: string;
}

/**
 * Re-derive pre/target fresh and write the three artifacts of the next
 * migration, returning their absolute paths. Refuses the same states
 * `computePlan` flags — no database, a chain that diverged from applied history
 * (the shared `validateHistoryPrefix`, which throws before any file is written),
 * or a chain that is not fully applied — so the recorded `pre` is always the true
 * pre-state. This is the single generation path behind both `dbz generate` and
 * the `__generate` child.
 */
export async function writeMigration(config: AppConfig, request: GenerateRequest): Promise<string[]> {
  if (!MIGRATION_NAME.test(request.name)) {
    throw new Error(`migration name "${request.name}" must be one or more of [A-Za-z0-9_]`);
  }
  const state = readStoredState(config);
  if (state === null) {
    throw new Error(`no database at ${join(config.dbDir, "data.db")}; run \`dbz dev\` to initialize it first`);
  }
  const chain = await loadMigrationChain(config);
  const { pending } = validateHistoryPrefix(state.applied, chain);
  if (pending.length > 0) {
    throw new Error(`apply the ${pending.length} pending migration(s) first — start \`dbz dev\``);
  }

  const schema = await importSchema(config);
  const number = (chain.at(-1)?.number ?? 0) + 1;
  // Generation's classification is pure (no database); optimistic previews run
  // here and its refusals flow into the scaffold alongside the shape-classified
  // ones. Re-probed fresh (never carried on the wire), so the scaffold reflects
  // the database as it actually is at write time.
  const target = snapshotOf(schema);
  // Consent is verified against the freshly derived plan, not the one the
  // prompt displayed — so a yes and the write are atomic, and a schema that
  // moved in between can never be generated for unseen.
  if (request.consent !== undefined && request.consent !== planFingerprint(state.snapshot, target)) {
    throw new StaleConsentError("the schema changed since this ledger was shown");
  }
  const probedRefusals = probeOptimisticRefusals(config, state.snapshot, target, request.renames);
  const { migrationTs, typesTs, metaJson } = generateMigration({
    number,
    name: request.name,
    pre: state.snapshot,
    schema,
    renames: request.renames ?? {},
    probedRefusals,
  });

  mkdirSync(join(config.migrationsDir, "meta"), { recursive: true });
  const [modulePath, typesPath, metaPath] = migrationArtifactPaths(config, { number, name: request.name });
  const artifacts: [string, string][] = [
    [modulePath, migrationTs],
    [typesPath, typesTs],
    [metaPath, metaJson],
  ];
  for (const [path, content] of artifacts) writeFileSync(path, content);
  return artifacts.map(([path]) => path);
}
