import { createHash } from "node:crypto";
import { compareCodeUnits } from "../shared/ordering.ts";
import { isPluginDefinitionId, isPluginIdentifier } from "./identifiers.ts";
import type { App } from "../app/definition.ts";
import type { SchemaRefusal } from "../schema/classify.ts";
import { diffSnapshots } from "../schema/diff.ts";
import { planDiff, type SchemaPlan } from "../schema/planner.ts";
import { isSchema, type Schema } from "../schema/definition.ts";
import { snapshotOf, type SchemaSnapshot } from "../schema/snapshot.ts";
import { withFrameworkTables } from "../database/framework-schema.ts";
import {
  normalizePluginSnapshot,
  pluginPhysicalTableName,
  readStoredPluginInventory,
  rollbackAfterFailure,
  storageLayoutFingerprint,
  type Engine,
  type NormalizedPluginSnapshot,
  type StorageScope,
  type StoredPluginStorage,
} from "../database/engine.ts";

export interface DesiredPluginStorage {
  readonly definitionId: string;
  readonly schema: Schema;
}

export type DesiredPluginMounts = Readonly<Record<string, DesiredPluginStorage>>;

/** Project an assembled App to the exact private storage each Plugin owns. */
export function desiredPluginMounts(app: App): DesiredPluginMounts {
  const desired: Record<string, DesiredPluginStorage> = {};
  for (const mount of Object.keys(app.plugins).sort()) {
    const plugin = app.plugins[mount]!;
    desired[mount] = Object.freeze({
      definitionId: plugin.definitionId,
      schema: plugin.schema,
    });
  }
  return Object.freeze(desired);
}

export interface NormalizedPluginStoragePlan {
  readonly applied: readonly string[];
  readonly refusals: readonly Readonly<SchemaRefusal>[];
}

interface PluginStorageRequirementBase {
  readonly mount: string;
  readonly currentDefinitionId: string;
  readonly targetDefinitionId: string | null;
  readonly currentFingerprint: string;
  readonly targetFingerprint: string;
  readonly plan: NormalizedPluginStoragePlan;
}

export interface PluginStorageResetRequirement extends PluginStorageRequirementBase {
  readonly kind: "reset";
  readonly reason: "unsafe-schema" | "data-refusal" | "definition-mismatch";
  readonly targetDefinitionId: string;
}

export interface PluginStorageDropRequirement extends PluginStorageRequirementBase {
  readonly kind: "drop";
  readonly reason: "stale-mount";
  readonly targetDefinitionId: null;
}

export type PluginStorageRequirement =
  | PluginStorageResetRequirement
  | PluginStorageDropRequirement;

export class PluginStorageRequirementsError extends Error {
  readonly requirements: readonly PluginStorageRequirement[];

  constructor(requirements: readonly PluginStorageRequirement[]) {
    const lines = requirements.map((requirement) =>
      requirement.kind === "reset"
        ? `  - reset ${requirement.mount}: ${requirement.reason}`
        : `  - drop ${requirement.mount}: stale-mount`
    );
    super(`Plugin storage requires explicit consent:\n${lines.join("\n")}`);
    this.name = "PluginStorageRequirementsError";
    this.requirements = Object.freeze([...requirements]);
  }
}

export interface PluginStorageReconcileResult {
  readonly scopes: ReadonlyMap<string, StorageScope>;
  readonly applied: readonly string[];
}

interface NormalizedDesiredMount {
  readonly mount: string;
  readonly definitionId: string;
  readonly schema: Schema;
  readonly normalized: NormalizedPluginSnapshot;
}

interface DesiredMount extends NormalizedDesiredMount {
  readonly scope: StorageScope;
}

interface PreparedMount extends DesiredMount {
  readonly current: StoredPluginStorage | undefined;
  readonly plan: SchemaPlan | undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeDesiredMounts(desired: DesiredPluginMounts): NormalizedDesiredMount[] {
  if (!isPlainRecord(desired)) throw new TypeError("desired Plugin mounts must be a plain object");
  return Object.keys(desired).sort().map((mount) => {
    if (!isPluginIdentifier(mount)) {
      throw new TypeError(`Plugin mount "${mount}" must be an identifier`);
    }
    const entry = desired[mount];
    if (!isPlainRecord(entry)) throw new TypeError(`Plugin mount "${mount}" must be a Plugin storage descriptor`);
    if (
      typeof entry.definitionId !== "string" ||
      !isPluginDefinitionId(entry.definitionId)
    ) {
      throw new TypeError(`Plugin mount "${mount}" has an invalid definition identity`);
    }
    if (!isSchema(entry.schema)) throw new TypeError(`Plugin mount "${mount}" has an invalid private schema`);
    return Object.freeze({
      mount,
      definitionId: entry.definitionId,
      schema: entry.schema,
      normalized: normalizePluginSnapshot(snapshotOf(entry.schema)),
    });
  });
}

/**
 * Plan every desired mount's private storage. Planning only — the scopes are
 * not activated on the Engine, because reconciliation may still refuse any of
 * them for want of explicit consent.
 */
function planDesired(engine: Engine, desired: DesiredPluginMounts): DesiredMount[] {
  return normalizeDesiredMounts(desired).map((entry) => Object.freeze({
    ...entry,
    scope: engine.planPluginScope(entry.mount, entry.schema),
  }));
}

/** Fingerprint the exact storage layout requested by an App without touching storage. */
export function desiredStorageFingerprint(root: Schema, desired: DesiredPluginMounts): string {
  if (!isSchema(root)) throw new TypeError("root schema must be a AckerDB schema");
  // The Engine's layout always carries every framework-owned logical table.
  return storageLayoutFingerprint(
    snapshotOf(withFrameworkTables(root)),
    normalizeDesiredMounts(desired).map((entry) => ({
      mount: entry.mount,
      definitionId: entry.definitionId,
      schema: entry.normalized.snapshot,
    })),
  );
}

function stateFingerprint(
  mount: string,
  definitionId: string | null,
  encodedSnapshot: string | null,
): string {
  return createHash("sha256")
    .update(JSON.stringify([mount, definitionId, encodedSnapshot]))
    .digest("hex");
}

function normalizedRefusals(refusals: readonly SchemaRefusal[]): readonly Readonly<SchemaRefusal>[] {
  return Object.freeze(refusals.map((refusal) => Object.freeze({ ...refusal })));
}

function normalizedPlan(
  plan?: SchemaPlan,
  refusals: readonly SchemaRefusal[] = plan?.refusals ?? [],
): NormalizedPluginStoragePlan {
  return Object.freeze({
    applied: Object.freeze([...(plan?.applied ?? [])]),
    refusals: normalizedRefusals(refusals),
  });
}

function resetRequirement(
  current: StoredPluginStorage,
  target: DesiredMount,
  reason: PluginStorageResetRequirement["reason"],
  plan?: SchemaPlan,
  refusals?: readonly SchemaRefusal[],
): PluginStorageResetRequirement {
  return Object.freeze({
    kind: "reset",
    reason,
    mount: target.mount,
    currentDefinitionId: current.definitionId,
    targetDefinitionId: target.definitionId,
    currentFingerprint: stateFingerprint(current.mount, current.definitionId, current.encodedSnapshot),
    targetFingerprint: stateFingerprint(target.mount, target.definitionId, target.normalized.encoded),
    plan: normalizedPlan(plan, refusals),
  });
}

function dropRequirement(current: StoredPluginStorage): PluginStorageDropRequirement {
  return Object.freeze({
    kind: "drop",
    reason: "stale-mount",
    mount: current.mount,
    currentDefinitionId: current.definitionId,
    targetDefinitionId: null,
    currentFingerprint: stateFingerprint(current.mount, current.definitionId, current.encodedSnapshot),
    targetFingerprint: stateFingerprint(current.mount, null, null),
    plan: normalizedPlan(),
  });
}

function sortedRequirements(
  requirements: readonly PluginStorageRequirement[],
): PluginStorageRequirement[] {
  return [...requirements].sort((left, right) => compareCodeUnits(left.mount, right.mount));
}

function writeInventory(engine: Engine, target: NormalizedDesiredMount): void {
  engine.writer.query(
    `INSERT INTO _ackerdb_plugins (mount, definition_identity, schema) VALUES (?, ?, ?)
      ON CONFLICT(mount) DO UPDATE SET
        definition_identity = excluded.definition_identity,
        schema = excluded.schema`,
  ).run(target.mount, target.definitionId, target.normalized.encoded);
}

function dropPhysicalScope(engine: Engine, mount: string, snapshot: SchemaSnapshot): void {
  for (const [table, definition] of Object.entries(snapshot.tables)) {
    if (definition.kind === "table") {
      const physicalName = pluginPhysicalTableName(mount, table);
      engine.dropStoredFullTextPhysical(physicalName, definition);
      engine.writer.exec(`DROP TABLE ${quote(physicalName)}`);
    }
  }
  const tagPrefix = `${mount.length}:${mount}`;
  engine.writer
    .query("DELETE FROM _ackerdb_tags WHERE substr(type, 1, ?) = ?")
    .run(tagPrefix.length, tagPrefix);
  engine.writer.query("DELETE FROM _ackerdb_plugins WHERE mount = ?").run(mount);
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function assertCurrentConsent(
  current: StoredPluginStorage | undefined,
  requirement: PluginStorageRequirement,
): StoredPluginStorage {
  if (
    current === undefined ||
    requirement.currentFingerprint !== stateFingerprint(
      current.mount,
      current.definitionId,
      current.encodedSnapshot,
    )
  ) {
    throw new Error(`stale Plugin storage consent for mount "${requirement.mount}"`);
  }
  return current;
}

/** Reconcile all assembled desired mounts as one Plugin-schema transaction. */
export function reconcilePluginStorage(
  engine: Engine,
  desired: DesiredPluginMounts,
): PluginStorageReconcileResult {
  const targets = planDesired(engine, desired);
  const targetByMount = new Map(targets.map((target) => [target.mount, target]));
  const stored = readStoredPluginInventory(engine.writer);
  const requirements: PluginStorageRequirement[] = [];
  const prepared: PreparedMount[] = [];

  for (const current of stored.values()) {
    if (!targetByMount.has(current.mount)) requirements.push(dropRequirement(current));
  }
  for (const target of targets) {
    const current = stored.get(target.mount);
    if (current === undefined) {
      prepared.push({ ...target, current, plan: undefined });
      continue;
    }
    if (current.definitionId !== target.definitionId) {
      requirements.push(resetRequirement(current, target, "definition-mismatch"));
      continue;
    }
    const plan = planDiff(
      {
        engine,
        current: current.snapshot,
        planOf: (table) => target.scope.plan(table),
      },
      diffSnapshots(current.snapshot, target.normalized.snapshot),
    );
    if (plan.refusals.length > 0) {
      requirements.push(resetRequirement(current, target, "unsafe-schema", plan));
      continue;
    }
    prepared.push({ ...target, current, plan });
  }

  if (requirements.length > 0) {
    throw new PluginStorageRequirementsError(sortedRequirements(requirements));
  }

  const changed = prepared.filter((mount) =>
    mount.current === undefined || mount.current.encodedSnapshot !== mount.normalized.encoded
  );
  if (changed.length === 0) {
    for (const target of targets) engine.activateScope(target.scope);
    return Object.freeze({
      scopes: new Map(targets.map((target) => [target.mount, target.scope])),
      applied: Object.freeze([]),
    });
  }

  engine.writer.exec("BEGIN IMMEDIATE");
  try {
    const dataRequirements: PluginStorageRequirement[] = [];
    for (const mount of changed) {
      if (mount.current === undefined || mount.plan === undefined) continue;
      const refusals = mount.plan.probes.flatMap((probe) => [...probe()]);
      if (refusals.length > 0) {
        dataRequirements.push(
          resetRequirement(mount.current, mount, "data-refusal", mount.plan, refusals),
        );
      }
    }
    if (dataRequirements.length > 0) {
      throw new PluginStorageRequirementsError(sortedRequirements(dataRequirements));
    }

    // Every mount is accepted from here on: publish the planned tag maps and
    // bring up the capabilities their tables need, then do the physical work.
    for (const target of targets) engine.activateScope(target.scope);

    const applied: string[] = [];
    for (const mount of changed) {
      engine.persistTags(mount.scope);
      if (mount.current === undefined) {
        for (const table of mount.scope.plans.values()) engine.createTablePhysical(table);
        applied.push(`${mount.mount}: initialized ${mount.scope.plans.size} table(s)`);
      } else {
        for (const operation of mount.plan!.ops) operation();
        applied.push(...mount.plan!.applied.map((line) => `${mount.mount}: ${line}`));
      }
      writeInventory(engine, mount);
    }
    engine.writer.exec("COMMIT");
    return Object.freeze({
      scopes: new Map(targets.map((target) => [target.mount, target.scope])),
      applied: Object.freeze(applied),
    });
  } catch (error) {
    rollbackAfterFailure(
      engine.writer,
      error,
      "Plugin storage reconciliation and rollback both failed",
    );
  }
}

/** Reset exactly one mounted scope after fingerprint-bound explicit consent. */
export function resetPluginStorage(
  engine: Engine,
  desired: DesiredPluginMounts,
  requirement: PluginStorageResetRequirement,
): StorageScope {
  if (requirement.kind !== "reset") throw new TypeError("Plugin reset requires a reset requirement");
  // Only the mount identities and normalized snapshots matter for the consent
  // check; the scope is built once, after consent holds, inside the transaction.
  const target = normalizeDesiredMounts(desired).find((candidate) => candidate.mount === requirement.mount);
  if (target === undefined) throw new Error(`Plugin reset target "${requirement.mount}" is not desired`);
  if (
    requirement.targetFingerprint !==
      stateFingerprint(target.mount, target.definitionId, target.normalized.encoded)
  ) {
    throw new Error(`stale Plugin storage consent for mount "${requirement.mount}"`);
  }
  engine.writer.exec("BEGIN IMMEDIATE");
  try {
    const current = assertCurrentConsent(
      readStoredPluginInventory(engine.writer).get(requirement.mount),
      requirement,
    );
    dropPhysicalScope(engine, requirement.mount, current.snapshot);
    const freshScope = engine.createPluginScope(requirement.mount, target.schema);
    engine.persistTags(freshScope);
    for (const table of freshScope.plans.values()) engine.createTablePhysical(table);
    writeInventory(engine, target);
    engine.writer.exec("COMMIT");
    return freshScope;
  } catch (error) {
    rollbackAfterFailure(
      engine.writer,
      error,
      `Plugin storage reset and rollback both failed: ${requirement.mount}`,
    );
  }
}

/** Drop exactly one stale mounted scope after fingerprint-bound explicit consent. */
export function dropPluginStorage(
  engine: Engine,
  desired: DesiredPluginMounts,
  requirement: PluginStorageDropRequirement,
): void {
  if (requirement.kind !== "drop") throw new TypeError("Plugin drop requires a drop requirement");
  // A drop only has to prove the mount is no longer desired, which is a name
  // comparison — it never needs a storage plan, let alone an activated scope.
  if (normalizeDesiredMounts(desired).some((target) => target.mount === requirement.mount)) {
    throw new Error(`stale Plugin storage consent for mount "${requirement.mount}"`);
  }
  if (requirement.targetFingerprint !== stateFingerprint(requirement.mount, null, null)) {
    throw new Error(`stale Plugin storage consent for mount "${requirement.mount}"`);
  }
  engine.writer.exec("BEGIN IMMEDIATE");
  try {
    const current = assertCurrentConsent(
      readStoredPluginInventory(engine.writer).get(requirement.mount),
      requirement,
    );
    dropPhysicalScope(engine, requirement.mount, current.snapshot);
    engine.writer.exec("COMMIT");
  } catch (error) {
    rollbackAfterFailure(
      engine.writer,
      error,
      `Plugin storage drop and rollback both failed: ${requirement.mount}`,
    );
  }
}
