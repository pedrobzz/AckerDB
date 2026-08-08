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
 * runs on. A credential that opens the surface over one transport and cannot
 * establish a session over the other is broken, and saying "connected" would
 * be the plausible-looking answer nobody notices.
 */
import type { AckerDBAuthenticationState } from "@ackerdb/client-react";
import type { AdminSystemInfo } from "@ackerdb/core";
import type { StudioProbe } from "./probe.ts";

export type StudioConnection =
  /** The probe has not answered yet; nothing is known. */
  | { readonly state: "connecting" }
  /** The application is not answering Studio. `detail` is why. */
  | { readonly state: "unreachable"; readonly detail: string }
  /** The application answers and Studio holds no credential. */
  | { readonly state: "unconfigured" }
  /** The credential Studio holds does not open Studio. `detail` is why. */
  | { readonly state: "refused"; readonly detail: string }
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
  switch (input.authentication.phase) {
    case "refresh-required":
    case "failed":
      return { state: "refused", detail: input.authentication.error.message };
    default:
      break;
  }
  switch (input.probe.status) {
    case "pending":
      return { state: "connecting" };
    case "refused":
      return { state: "refused", detail: input.probe.detail };
    case "open":
      return { state: "authenticated", application: input.probe.application };
  }
}
