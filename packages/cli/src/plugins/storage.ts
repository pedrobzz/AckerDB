/**
 * The CLI boundary for destructive Plugin-storage reconciliation.
 *
 * The server owns classification, fingerprints, and the destructive
 * transaction. This module owns only manifest projection, fresh-process
 * consent, and the human surface. A consent never names a schema vaguely: it
 * carries the exact current and target fingerprints the server produced, then
 * re-derives them against the live app before reset/drop.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  Engine,
  PluginStorageRequirementsError,
  desiredPluginMounts,
  dropPluginStorage,
  reconcilePluginStorage,
  refusalSite,
  resetPluginStorage,
  type DesiredPluginMounts,
  type EngineCloseDisposition,
  type PluginStorageRequirement,
} from "@dbzz/server";
import type { AppConfig } from "../app/config.ts";
import { importApp } from "../app/manifest.ts";
import { NO, YES, type Ask } from "../migrations/form.ts";

export type PluginPlanWire =
  | { readonly clean: true }
  | { readonly clean: false; readonly requirement: PluginStorageRequirement };

export interface PluginStorageConsent {
  readonly kind: "reset" | "drop";
  readonly mount: string;
  readonly currentFingerprint: string;
  readonly targetFingerprint: string;
}

export type PluginApplyResult =
  | { readonly applied: true }
  | { readonly stale: true };

function databasePath(config: AppConfig): string {
  return join(config.dbDir, "data.db");
}

interface PluginStorageState {
  readonly desired: DesiredPluginMounts;
  readonly requirements: readonly PluginStorageRequirement[];
}

/**
 * Open and validate storage, then inspect only Plugin scopes. Root migration
 * and reconciliation belong to startup; an explicit Plugin command is narrow
 * consent for one private mount and never authority to mutate app tables.
 * Expected consent requirements are a successful inspection outcome, so the
 * Engine can close cleanly; any other failure is retained as unclean.
 */
async function withPluginStorage<T>(
  config: AppConfig,
  work: (engine: Engine, state: PluginStorageState) => T | Promise<T>,
): Promise<T> {
  const app = await importApp(config);
  const engine = new Engine(app.schema, databasePath(config), {
    durability: config.durability,
  });
  let disposition: EngineCloseDisposition = "unclean";
  let failed = false;
  let failure: unknown;
  let value: T | undefined;
  try {
    const desired = desiredPluginMounts(app);
    let requirements: readonly PluginStorageRequirement[] = [];
    try {
      // Safe drift remains automatic Plugin reconciliation. A displayed
      // consent gates only the reset/drop primitive below, so stale consent
      // can never clear data even if its replacement safe drift applies.
      reconcilePluginStorage(engine, desired);
    } catch (error) {
      if (!(error instanceof PluginStorageRequirementsError)) throw error;
      requirements = error.requirements;
    }
    value = await work(engine, { desired, requirements });
    disposition = "clean";
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    engine.close(disposition);
  } catch (closeError) {
    if (failed) {
      throw new AggregateError(
        [failure, closeError],
        `Plugin storage operation and database close both failed: ${databasePath(config)}`,
      );
    }
    throw closeError;
  }
  if (failed) throw failure;
  return value!;
}

/** Inspect the next deterministic requirement without authorizing it. */
export async function planPluginStorage(config: AppConfig): Promise<PluginPlanWire> {
  if (!existsSync(databasePath(config))) return Object.freeze({ clean: true });
  return withPluginStorage(config, (_engine, { requirements }) => {
    const requirement = requirements[0];
    return requirement === undefined
      ? Object.freeze({ clean: true })
      : Object.freeze({ clean: false, requirement });
  });
}

function matchesConsent(
  requirement: PluginStorageRequirement,
  consent: PluginStorageConsent,
): boolean {
  return requirement.kind === consent.kind &&
    requirement.mount === consent.mount &&
    requirement.currentFingerprint === consent.currentFingerprint &&
    requirement.targetFingerprint === consent.targetFingerprint;
}

function applyRequirement(
  engine: Engine,
  desired: DesiredPluginMounts,
  requirement: PluginStorageRequirement,
): void {
  if (requirement.kind === "reset") {
    resetPluginStorage(engine, desired, requirement);
  } else {
    dropPluginStorage(engine, desired, requirement);
  }
}

/** Re-prove a displayed fingerprint pair, then reset/drop exactly that one mount. */
export async function applyPluginStorageConsent(
  config: AppConfig,
  consent: PluginStorageConsent,
): Promise<PluginApplyResult> {
  if (!existsSync(databasePath(config))) return Object.freeze({ stale: true });
  return withPluginStorage(config, (engine, { desired, requirements }) => {
    const requirement = requirements.find((candidate) => matchesConsent(candidate, consent));
    if (requirement === undefined) return Object.freeze({ stale: true });
    applyRequirement(engine, desired, requirement);
    return Object.freeze({ applied: true });
  });
}

function reasonLine(requirement: PluginStorageRequirement): string {
  switch (requirement.reason) {
    case "unsafe-schema":
      return "unsafe private-schema change (alpha Plugins do not migrate private data)";
    case "data-refusal":
      return "the otherwise safe private-schema change conflicts with the stored private data";
    case "definition-mismatch":
      return `definition changed from ${requirement.currentDefinitionId} to ${requirement.targetDefinitionId}`;
    case "stale-mount":
      return `the app no longer mounts ${requirement.currentDefinitionId} here`;
  }
}

/** Human projection of the server-owned plan; schema JSON stays out of the terminal. */
export function renderPluginStorageRequirement(requirement: PluginStorageRequirement): string {
  const action = requirement.kind === "reset" ? "reset" : "dropped";
  const consequences = requirement.kind === "reset"
    ? "Only this mount's private data will be cleared; its target schema is then created."
    : "Only this stale mount's private tables and data will be removed.";
  const section = (title: string, lines: readonly string[]): string[] =>
    lines.length === 0 ? [] : [`  ${title}:`, ...lines.map((line) => `    - ${line}`)];
  return [
    `[dbzz] Plugin storage mount "${requirement.mount}" must be ${action}:`,
    `  reason: ${reasonLine(requirement)}`,
    ...section(
      "requires clearing",
      requirement.plan.refusals.map((refusal) => `${refusalSite(refusal)}: ${refusal.question}`),
    ),
    ...section("would otherwise apply", requirement.plan.applied),
    `  ${consequences}`,
  ].join("\n");
}

/** Yes is destructive and therefore never the default. */
export async function runPluginStorageConsentForm(
  requirement: PluginStorageRequirement,
  ask: Ask,
): Promise<boolean> {
  const action = requirement.kind;
  for (;;) {
    const answer = (await ask(
      `${action} Plugin storage mount "${requirement.mount}" now? [y/N] `,
    )).trim().toLowerCase();
    if (YES.has(answer)) return true;
    if (answer === "" || NO.has(answer)) return false;
  }
}

function shellWord(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function pluginStorageCommand(
  requirement: PluginStorageRequirement,
  appDir?: string,
): string {
  const suffix = appDir === undefined ? "" : ` ${shellWord(appDir)}`;
  return `dbzz plugin ${requirement.kind} ${shellWord(requirement.mount)}${suffix}`;
}

/** Non-interactive startup recourse: explicit commands, never an automatic clear. */
export function pluginStorageRecourse(
  error: PluginStorageRequirementsError,
  appDir?: string,
): string {
  const commands = error.requirements.map((requirement) =>
    `    ${pluginStorageCommand(requirement, appDir)}`
  );
  return `${error.message}\n\nThe v0.6 alpha has no Plugin migrations; clearing private data requires explicit consent. Run:\n\n${commands.join("\n")}`;
}

/** Explicit command invocation is consent, but only for a freshly re-derived matching requirement. */
export async function executePluginStorageCommand(
  config: AppConfig,
  kind: "reset" | "drop",
  mount: string,
): Promise<PluginStorageRequirement> {
  if (!existsSync(databasePath(config))) {
    throw new Error(`no database at ${databasePath(config)}; there is no Plugin storage to ${kind}`);
  }
  const outcome = await withPluginStorage(config, (engine, { desired, requirements }) => {
    const requirement = requirements.find((candidate) => candidate.mount === mount);
    if (requirement === undefined) {
      return {
        error: `Plugin storage mount "${mount}" has no pending ${kind} requirement`,
      } as const;
    }
    if (requirement.kind !== kind) {
      return {
        error: `Plugin storage mount "${mount}" requires \`${pluginStorageCommand(requirement)}\`, not ${kind}`,
      } as const;
    }
    applyRequirement(engine, desired, requirement);
    return { requirement } as const;
  });
  if ("error" in outcome) throw new Error(outcome.error);
  return outcome.requirement;
}
