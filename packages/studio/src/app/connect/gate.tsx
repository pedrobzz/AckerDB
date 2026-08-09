/**
 * The gate: nothing in Studio renders until the connect verdict says it can.
 *
 * The verdict is `studioConnection`'s, from two facts this module gathers — the
 * authenticated probe's answer and the client's own authentication phase. The
 * derivation is a pure function next door precisely so that gathering and
 * deciding are not the same code; this file owns only the gathering, and the
 * screen owns only the appearance.
 *
 * **The gate wraps the shell instead of redirecting to a connect route.** The
 * URL an operator arrived on survives signing in, so a link to a screen is a
 * link to that screen even when the tab holding it has no credential yet. A
 * redirect would answer every such link with the connect screen and then drop
 * the operator somewhere else.
 */
import { useAuthentication } from "@ackerdb/client-react";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { studioCredential } from "../credential.ts";
import { studioConnection, type StudioConnection } from "./connection.ts";
import { probeAdminApi, type StudioProbe } from "./probe.ts";
import { ConnectScreen } from "./screen.tsx";

/** How often an unsettled probe is repeated. */
const PROBE_RETRY_MS = 2_000;

const PENDING: StudioProbe = { status: "pending" };

/**
 * Ask the Admin API until the answer and the session agree that Studio is
 * connected, and stop there.
 *
 * Stopping on the first open answer alone would be wrong in the case that
 * matters most: an application that disappears afterwards leaves the session,
 * and a retained `open` would hold the screen on a stale fact instead of
 * reporting *application unreachable*. Tying the stop to both halves gives the
 * steady state zero background work and still notices an outage, because a
 * dropped session flips `sessionHealthy` and re-arms this effect.
 */
function useAdminProbe(credential: string | null, sessionHealthy: boolean): StudioProbe {
  const [probe, setProbe] = useState<StudioProbe>(PENDING);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async (): Promise<void> => {
      const answer = await probeAdminApi((path, init) => fetch(path, init), credential);
      if (!live) return;
      setProbe(answer);
      if (answer.status !== "open" || !sessionHealthy) {
        timer = setTimeout(() => void ask(), PROBE_RETRY_MS);
      }
    };
    setProbe(PENDING);
    void ask();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [credential, sessionHealthy]);
  return probe;
}

export function useStudioConnection(): StudioConnection {
  const held = useSyncExternalStore(studioCredential.subscribe, studioCredential.read, () => null);
  const { state: authentication } = useAuthentication();
  const probe = useAdminProbe(held, authentication.phase === "authenticated");
  return studioConnection({ hasCredential: held !== null, probe, authentication });
}

export function ConnectGate({ children }: { readonly children: ReactNode }) {
  const connection = useStudioConnection();
  return connection.state === "authenticated" ? <>{children}</> : <ConnectScreen connection={connection} />;
}
