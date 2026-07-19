/**
 * The rename form: a pure prompt loop over the plan's rename candidates. It
 * never touches a TTY itself — the caller injects an `ask` (production wires it
 * to `node:readline/promises`; tests script it). Renames are asked, never
 * guessed: even a lone drop/add pair is put to the developer as a yes/no
 * question, and a drop with several candidates is a numbered choice that always
 * includes "none (delete + add)".
 *
 * A rename consumes its target from that scope's candidate pool, so two dropped
 * columns choosing from the same two added columns cannot both claim one. The
 * result feeds `generateMigration` directly: `renames` keyed exactly as the
 * runtime expects, plus the drops the developer explicitly chose to keep (which
 * the scaffold acknowledges anyway — this list is for the summary line).
 */
import type { Renames } from "@dbzz/server";
import type { CandidateGroup, RenameCandidates } from "./plan.ts";

export type Ask = (prompt: string) => Promise<string>;

export interface FormResult {
  renames: Renames;
  /** Sites the developer was asked about and chose to delete + add (not rename). */
  dropsAcknowledged: string[];
}

export const YES = new Set(["y", "yes"]);
export const NO = new Set(["n", "no"]);

async function askYesNo(ask: Ask, prompt: string): Promise<boolean> {
  for (;;) {
    const answer = (await ask(prompt)).trim().toLowerCase();
    if (YES.has(answer)) return true;
    if (NO.has(answer)) return false;
    // Anything else re-asks — the loop is the whole re-prompt.
  }
}

/** A numbered choice among candidates plus a trailing "none". Returns the pick or `null` for none. */
async function askChoice(ask: Ask, subject: string, candidates: string[]): Promise<string | null> {
  const menu = [
    subject,
    ...candidates.map((candidate, i) => `  ${i + 1}) rename to "${candidate}"`),
    `  ${candidates.length + 1}) none (delete + add)`,
    "> ",
  ].join("\n");
  for (;;) {
    const choice = Number((await ask(menu)).trim());
    if (Number.isInteger(choice) && choice >= 1 && choice <= candidates.length) return candidates[choice - 1]!;
    if (choice === candidates.length + 1) return null;
    // Out of range re-asks.
  }
}

interface GroupHandlers {
  describe: (name: string) => string;
  onRename: (oldName: string, newName: string) => void;
}

/** Resolve one scope's drops against its added pool, consuming each target as it is claimed. */
async function resolveGroup(
  group: CandidateGroup,
  ask: Ask,
  dropsAcknowledged: string[],
  { describe, onRename }: GroupHandlers,
): Promise<void> {
  const remaining = [...group.added];
  for (const dropped of group.dropped) {
    if (remaining.length === 0) continue; // no target to offer — the scaffold acknowledges the drop
    if (remaining.length === 1) {
      const candidate = remaining[0]!;
      if (await askYesNo(ask, `rename ${describe(dropped)} to "${candidate}"? [y/n] `)) {
        onRename(dropped, candidate);
        remaining.shift();
      } else {
        dropsAcknowledged.push(describe(dropped));
      }
    } else {
      const choice = await askChoice(ask, `${describe(dropped)} was removed — rename it?`, remaining);
      if (choice === null) {
        dropsAcknowledged.push(describe(dropped));
      } else {
        onRename(dropped, choice);
        remaining.splice(remaining.indexOf(choice), 1);
      }
    }
  }
}

export async function runRenameForm(candidates: RenameCandidates, ask: Ask): Promise<FormResult> {
  const tables: Record<string, string> = {};
  const columns: Record<string, Record<string, string>> = {};
  const variants: Record<string, Record<string, string>> = {};
  const dropsAcknowledged: string[] = [];

  await resolveGroup(candidates.tables, ask, dropsAcknowledged, {
    describe: (name) => `table "${name}"`,
    onRename: (oldName, newName) => {
      tables[oldName] = newName;
    },
  });

  for (const table of Object.keys(candidates.columns).sort()) {
    await resolveGroup(candidates.columns[table]!, ask, dropsAcknowledged, {
      describe: (name) => `column "${table}.${name}"`,
      onRename: (oldCol, newCol) => {
        (columns[table] ??= {})[oldCol] = newCol;
      },
    });
  }

  for (const type of Object.keys(candidates.variants).sort()) {
    await resolveGroup(candidates.variants[type]!, ask, dropsAcknowledged, {
      describe: (name) => `variant "${type}.${name}"`,
      onRename: (oldVariant, newVariant) => {
        (variants[type] ??= {})[oldVariant] = newVariant;
      },
    });
  }

  const renames: Renames = {};
  if (Object.keys(tables).length > 0) renames.tables = tables;
  if (Object.keys(columns).length > 0) renames.columns = columns;
  if (Object.keys(variants).length > 0) renames.variants = variants;
  return { renames, dropsAcknowledged };
}
