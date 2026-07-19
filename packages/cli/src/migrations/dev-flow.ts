/**
 * The dev supervisor's crash flow: what happens between a refused reload and a
 * migration (or a decline). Pure of any terminal or process — the supervisor
 * injects effects, tests script them.
 *
 * The consent question is about a state. When the state changes under an open
 * prompt — the developer saves a file instead of answering — the prompt is
 * RETRACTED: the supervisor cancels it, the flow exits silently, and the next
 * refusal asks again over the fresh ledger. Retraction is not decline (Ctrl+C
 * is): it remembers nothing, so the same ledger re-asks. A crash that arrives
 * while a flow is still unwinding is queued, never swallowed — the flow re-runs
 * against a fresh plan the moment the current one exits.
 */
import { deriveSlug, type PlanWire } from "./plan.ts";
import { renderLedger, runConsentForm, runDivergenceForm, type Consent } from "./consent.ts";
import { runRenameForm, type Ask, type FormResult } from "./form.ts";
import type { GenerateRequest } from "./write.ts";

/** What a `__generate` child reports: the artifacts it wrote, or a consent gone stale. */
export type GenerateResult = { written: string[] } | { stale: true };

/** How one interactive question ended: an answer, a Ctrl+C, or a supervisor retraction. */
export type PromptOutcome<T> = { answer: T } | { interrupted: true } | { canceled: true };

export interface DevFlowEffects {
  plan(): Promise<PlanWire>;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  /** Run one form on the terminal. At most one prompt is ever open. */
  prompt<T>(form: (ask: Ask) => Promise<T>): Promise<PromptOutcome<T>>;
  deleteFiles(files: string[]): void;
  /** Restart the serve child — the crash resolved without a migration. */
  startServer(): Promise<void>;
  report(written: string[], form: FormResult): void;
  log(line: string): void;
  error(line: string): void;
}

const FILL_TODOS =
  "[dbz] a scaffolded migration is not applied yet — fill its TODOs; the server reloads when it compiles";
const DECLINED_BANNER =
  "[dbz] migration declined — server stays down; edit the schema (a clean ledger starts it, a changed one asks again), run `dbz generate`, or wipe local data with `dbz reset`";

/**
 * One pass over a crashed state: plan, present, and resolve. Returns the
 * declined-ledger fingerprint to carry forward (`null` when nothing stands
 * declined). Retraction returns the incoming fingerprint unchanged.
 */
async function runFlow(fx: DevFlowEffects, declined: string | null): Promise<string | null> {
  let deletedScaffold = false;
  for (;;) {
    const wire = await fx.plan();
    if ("error" in wire) return declined; // fresh db, or a diverged chain the child already reported
    if (wire.clean) {
      // Deleting a stale scaffold can leave nothing to answer — the crash is
      // resolved, so the server comes straight back.
      if (deletedScaffold) await fx.startServer();
      return declined;
    }
    if (wire.pendingCount > 0) {
      if (!wire.stale) {
        fx.error(FILL_TODOS);
        return declined;
      }
      const res = await fx.prompt((ask) => runDivergenceForm(wire.pendingFiles, ask));
      if ("canceled" in res) return declined;
      if ("interrupted" in res || res.answer === "keep") {
        fx.error("[dbz] keeping it — fill its TODOs; further changes become the next migration");
        return declined;
      }
      fx.deleteFiles(wire.pendingFiles);
      deletedScaffold = true;
      continue;
    }
    if (wire.fingerprint === declined) {
      fx.error(DECLINED_BANNER);
      return declined;
    }
    fx.log(renderLedger(wire));
    const consentRes = await fx.prompt((ask) => runConsentForm(deriveSlug(wire.refusals), ask));
    if ("canceled" in consentRes) return declined;
    const consent: Consent = "interrupted" in consentRes ? { generate: false } : consentRes.answer;
    if (!consent.generate) {
      fx.error(DECLINED_BANNER);
      return wire.fingerprint;
    }
    const formRes = await fx.prompt((ask) => runRenameForm(wire.candidates, ask));
    if ("canceled" in formRes) return declined;
    if ("interrupted" in formRes) {
      fx.error(DECLINED_BANNER);
      return wire.fingerprint;
    }
    const result = await fx.generate({
      name: consent.name,
      renames: formRes.answer.renames,
      consent: wire.fingerprint,
    });
    if ("stale" in result) {
      fx.error("[dbz] more changes happened while the question was open — the fresh ledger:");
      continue;
    }
    fx.report(result.written, formRes.answer);
    return null; // generated: nothing stands declined anymore
  }
}

/**
 * The supervisor-facing handler. `onCrash` is called for every serve-child
 * crash; a crash during a running flow retracts the open prompt and queues a
 * re-run, so no refusal ever goes unpresented. `retractPrompt` is also called
 * directly on every file-change trigger — a save means the state the open
 * question was asked about may be gone.
 */
export function makeDevFlowHandler(
  fx: DevFlowEffects,
  gate: () => boolean,
  retractPrompt: () => void,
): { onCrash: () => Promise<void>; retractPrompt: () => void } {
  let running = false;
  let crashPending = false;
  let declined: string | null = null;

  const onCrash = async (): Promise<void> => {
    if (!gate()) return;
    if (running) {
      crashPending = true;
      retractPrompt();
      return;
    }
    running = true;
    try {
      do {
        crashPending = false;
        try {
          declined = await runFlow(fx, declined);
        } catch (error) {
          fx.error(`[dbz] ${error instanceof Error ? error.message : String(error)}`);
        }
      } while (crashPending);
    } finally {
      running = false;
    }
  };

  return { onCrash, retractPrompt };
}
