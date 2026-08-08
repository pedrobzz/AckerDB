/**
 * What Studio can honestly say about itself, from two facts: the answer to one
 * authenticated probe against the Admin API, and the client's own
 * authentication phase.
 *
 * **The states are ordered by what the operator can act on**, not by which
 * layer produced them. An application that is not answering makes every
 * statement about credentials unknowable, so it is read first — that is what
 * makes `acker studio` against a stopped application show a diagnosis rather
 * than a dead port. An absent credential comes next, because "you have not
 * signed in" must never be reported as "your credential was refused".
 *
 * Both facts are kept, because they can disagree and the disagreement matters.
 * The probe proves the credential opens the Admin API; the client's phase
 * proves Studio can hold a session, which is what every screen after this one
 * runs on. A request answers before a socket does, so the probe alone would
 * report Connected while the session is still being established — or never is —
 * and that is the plausible-looking answer nobody notices. Connected therefore
 * needs both. When they disagree the reducer names which half failed, because
 * "your credential was refused" and "Studio cannot hold a session with a
 * credential that plainly works" send an operator to entirely different places.
 */
import type { AckerDBAuthenticationState } from "@ackerdb/client-react";
import type { AdminSystemInfo } from "@ackerdb/core";
import type { StudioProbe } from "./probe.ts";

export type StudioConnection =
  /** Nothing has settled yet. */
  | { readonly state: "connecting" }
  /** The application is not answering Studio. `detail` is why. */
  | { readonly state: "unreachable"; readonly detail: string }
  /** The application answers and Studio holds no credential. */
  | { readonly state: "unconfigured" }
  /** The credential Studio holds was refused. Try another one. */
  | { readonly state: "refused"; readonly detail: string }
  /** The credential opens the Admin API and the client still cannot hold a session. */
  | { readonly state: "session-failed"; readonly detail: string }
  /** Signed in, with the application the credential opened. */
  | { readonly state: "authenticated"; readonly application: AdminSystemInfo };

export interface StudioConnectionInput {
  /** Whether the credential cell holds anything; see `credential.ts`. */
  readonly hasCredential: boolean;
  readonly probe: StudioProbe;
  readonly authentication: AckerDBAuthenticationState;
}

export function studioConnection(input: StudioConnectionInput): StudioConnection {
  if (input.probe.status === "unreachable") {
    return { state: "unreachable", detail: input.probe.detail };
  }
  // Before any statement about a credential: an empty cell is "sign in", and
  // reporting it as a refusal would send the operator looking for a bad token.
  if (!input.hasCredential) return { state: "unconfigured" };
  // Two ways to learn the credential is the problem, and both mean the same
  // thing to the operator: the server rejected the presentation, or the surface
  // would not run the function.
  if (input.authentication.phase === "refresh-required") {
    return { state: "refused", detail: input.authentication.error.message };
  }
  if (input.probe.status === "refused") {
    return { state: "refused", detail: input.probe.detail };
  }
  // A client that stopped permanently while the credential plainly opens the
  // surface is not a refusal, and calling it one sends the operator hunting for
  // a credential that is already correct.
  if (input.authentication.phase === "failed") {
    return { state: "session-failed", detail: input.authentication.error.message };
  }
  return input.probe.status === "open" && input.authentication.phase === "authenticated"
    ? { state: "authenticated", application: input.probe.application }
    : { state: "connecting" };
}
