/**
 * The consent surface: the change ledger a developer reads, and the two prompt
 * loops that put it to them. Like the rename form, everything here is pure of
 * any TTY — the caller injects an `ask`, tests script it.
 *
 *   - `renderLedger`      the grouped what-changed report shown wherever
 *                         consent is asked and whenever a migration is
 *                         generated;
 *   - `runConsentForm`    generate now (with a name) or keep editing — decline
 *                         is the default, so a bare Enter never writes a file;
 *   - `runDivergenceForm` the stale-scaffold offer: delete the unapplied
 *                         migration and re-derive, or keep it — keep is the
 *                         default, so a bare Enter never deletes anything.
 */
import { refusalSite, type SchemaRefusal } from "@dbzz/server";
import { NO, YES, type Ask } from "./form.ts";
import { MIGRATION_NAME } from "./load.ts";
import type { CandidateGroup, RenameCandidates } from "./plan.ts";

/** What the ledger renders: the plan's refusals, safe lines, and rename candidates. */
export interface LedgerView {
  refusals: SchemaRefusal[];
  safe: string[];
  candidates: RenameCandidates;
}

const renameLine = (describe: (name: string) => string, group: CandidateGroup): string[] =>
  group.added.length === 0
    ? []
    : group.dropped.map((dropped) => {
        const targets = group.added.map((added) => `"${added}"`).join(", ");
        return `${describe(dropped)} → ${group.added.length === 1 ? targets : `one of ${targets}`}?`;
      });

function renameLines(candidates: RenameCandidates): string[] {
  return [
    ...renameLine((name) => `table "${name}"`, candidates.tables),
    ...Object.keys(candidates.columns)
      .sort()
      .flatMap((table) => renameLine((name) => `column "${table}.${name}"`, candidates.columns[table]!)),
    ...Object.keys(candidates.variants)
      .sort()
      .flatMap((type) => renameLine((name) => `variant "${type}.${name}"`, candidates.variants[type]!)),
  ];
}

/** The change ledger: what needs a migration and why, what merely rides along. */
export function renderLedger(view: LedgerView): string {
  const section = (title: string, lines: string[]): string[] =>
    lines.length === 0 ? [] : [`  ${title}:`, ...lines.map((line) => `    - ${line}`)];
  return [
    "[dbzz] the change ledger:",
    ...section(
      "needs a migration",
      view.refusals.map((refusal) => `${refusalSite(refusal)}: ${refusal.question}`),
    ),
    ...section("possible renames (asked before generating)", renameLines(view.candidates)),
    ...section("applies automatically", view.safe),
  ].join("\n");
}

export type Consent = { generate: true; name: string } | { generate: false };

/**
 * The consent question over a rendered ledger. Yes proceeds to naming (Enter
 * accepts the derived default; the grammar is the loader's `[A-Za-z0-9_]+`);
 * no or a bare Enter declines. Anything else re-asks — the loop is the whole
 * re-prompt.
 */
export async function runConsentForm(defaultName: string, ask: Ask): Promise<Consent> {
  for (;;) {
    const answer = (await ask("generate a migration for these changes now? [y/N] ")).trim().toLowerCase();
    if (answer === "" || NO.has(answer)) return { generate: false };
    if (!YES.has(answer)) continue;
    for (;;) {
      const name = (await ask(`migration name [${defaultName}]: `)).trim();
      if (name === "") return { generate: true, name: defaultName };
      if (MIGRATION_NAME.test(name)) return { generate: true, name };
    }
  }
}

/**
 * The apply question: pending migrations are ready and the developer decides
 * when they run. Wait is the default — a bare Enter never rewrites rows. A
 * declined apply is remembered against the pending chain's identity, so
 * editing a migration file (filling its TODOs) asks again while unrelated
 * saves only re-print the banner.
 */
export async function runApplyForm(labels: string[], ask: Ask): Promise<"apply" | "wait"> {
  const named = labels.join(", ");
  const prompt = `apply pending migration${labels.length === 1 ? "" : "s"} ${named} now? [y/N] `;
  for (;;) {
    const answer = (await ask(prompt)).trim().toLowerCase();
    if (YES.has(answer)) return "apply";
    if (answer === "" || NO.has(answer)) return "wait";
  }
}

/**
 * The stale-scaffold offer: the schema moved after these migration files were
 * written, so the chain no longer ends at the live schema. Deleting re-derives
 * one migration covering everything; keeping means fill + apply, with further
 * changes becoming the next migration (the right answer for a chain pulled
 * from version control, which is not yours to delete).
 */
export async function runDivergenceForm(files: string[], ask: Ask): Promise<"delete" | "keep"> {
  const prompt = [
    "[dbzz] the schema changed after this migration was scaffolded — the chain no longer ends at your schema.",
    "  delete + re-derive one migration covering everything (discards any transform code you wrote in):",
    ...files.map((file) => `    ${file}`),
    "  keep it to fill + apply as-is; further changes become the next migration (keep a chain pulled from git).",
    "delete and re-derive? [d/K] ",
  ].join("\n");
  for (;;) {
    const answer = (await ask(prompt)).trim().toLowerCase();
    if (answer === "d" || answer === "delete") return "delete";
    if (answer === "" || answer === "k" || answer === "keep") return "keep";
  }
}
