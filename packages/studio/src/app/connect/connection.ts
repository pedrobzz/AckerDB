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
 * and that is the plausible-looking answer nobody notices.
 *
 * **The probe decides refusal and the session decides nothing else.** Once the
 * probe is open the credential demonstrably opens the surface, so every session
 * phase other than `authenticated` describes the session and not the grant —
 * including `refresh-required`, which the client also raises for an attempt
 * that timed out. Calling any of those a credential refusal would send an
 * operator hunting for a token that is already correct.
 */
import type { AckerDBAuthenticationState } from "@ackerdb/client-react";
import { ACKERDB_VERSION, type AdminSystemInfo } from "@ackerdb/core";
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
  /**
   * The credential opens the Admin API and the client still cannot hold a
   * session. A Studio built from a different AckerDB version than the
   * application is the cause this reaches in practice — the Admin API answers
   * over plain HTTP, which carries no version, while the socket refuses a
   * frame from any build but its own.
   */
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
  // Nothing is claimed until the probe answers. Every state below is a settled
  // fact about a live application, and reporting one from an unanswered request
  // would be a guess wearing a diagnosis.
  if (input.probe.status === "pending") return { state: "connecting" };
  if (input.probe.status === "unreachable") {
    return { state: "unreachable", detail: input.probe.detail };
  }
  // Before any statement about a credential: an empty cell is "sign in", and
  // reporting it as a refusal would send the operator looking for a bad token.
  if (!input.hasCredential) return { state: "unconfigured" };
  // The surface itself decides refusal, and it is the only thing that can: it
  // ran the authorization funnel against this exact credential.
  if (input.probe.status === "refused") {
    return { state: "refused", detail: input.probe.detail };
  }
  // The probe is open, so the credential opens the Admin API and cannot be the
  // thing at fault. Whatever the session says now is about the session.
  switch (input.authentication.phase) {
    case "authenticated":
      return { state: "authenticated", application: input.probe.application };
    case "authenticating":
      return { state: "connecting" };
    case "refresh-required":
    case "failed":
      return {
        state: "session-failed",
        detail: sessionDetail(input.probe.application, input.authentication.error.message),
      };
    case "unauthenticated":
      return {
        state: "session-failed",
        detail: "the server confirmed an anonymous session for a credential that opens the Admin API",
      };
    case "closed":
      return { state: "session-failed", detail: "the Studio client was closed" };
  }
}

/**
 * Why a credential that opens the Admin API cannot hold a session.
 *
 * The probe already reported the application's AckerDB version, and that
 * version is the whole compatibility contract — packages ship lockstep, so a
 * Studio built from any other one is a mixed install and every socket it opens
 * is refused. Naming it here is the difference between an operator installing
 * one matching package and an operator reading "internal error" and filing a
 * bug.
 */
function sessionDetail(application: AdminSystemInfo, reported: string): string {
  return application.ackerdb === ACKERDB_VERSION
    ? reported
    : `this application runs AckerDB ${application.ackerdb} and this Studio is ` +
      `${ACKERDB_VERSION} — install @ackerdb/studio@${application.ackerdb}`;
}
