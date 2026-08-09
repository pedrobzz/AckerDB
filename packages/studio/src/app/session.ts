/**
 * The two things an operator can do to Studio's credential, in one place.
 *
 * Signing in and signing out are the same move in opposite directions: write
 * the cell, then tell the client a credential changed. Stating it once is what
 * keeps the order right — the client re-pulls from the source when asked, so a
 * cell written *after* the ask would hand it the value it already had. Both the
 * connect screen and the shell's header drive this, and neither owns it.
 *
 * A rejected credential is not swallowed and not reported here. It becomes the
 * client's authentication phase, which the connect flow already renders as a
 * refusal — catching it into a second error surface would give one failure two
 * places to appear and let them disagree.
 */
import { useAuthentication } from "@ackerdb/client-react";
import { useState } from "react";
import { studioCredential } from "./credential.ts";

export interface StudioSession {
  /** A credential change is in flight; the forms disable rather than queue. */
  readonly busy: boolean;
  readonly signIn: (token: string) => void;
  readonly forget: () => void;
}

export function useStudioSession(): StudioSession {
  const { refresh, signOut } = useAuthentication();
  const [busy, setBusy] = useState(false);

  const settle = (attempt: Promise<unknown>): void => {
    setBusy(true);
    void attempt.catch(() => {}).finally(() => setBusy(false));
  };

  return {
    busy,
    signIn: (token) => {
      studioCredential.write(token);
      settle(refresh());
    },
    forget: () => {
      studioCredential.write(null);
      settle(signOut());
    },
  };
}
