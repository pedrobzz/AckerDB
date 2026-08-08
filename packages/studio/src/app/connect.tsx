/**
 * The connect flow, in deliberately unstyled markup.
 *
 * This screen is behaviour, not appearance: it captures the Admin Credential,
 * hands it to the client through the credential cell, probes the Admin API with
 * it, and renders the states `studioConnection` derives. The visual system —
 * Tailwind, the vendored registry, the shell — arrives with #238 and restyles
 * exactly these states. The boundary is named so that ticket is a restyle
 * rather than a rewrite, so nothing here reaches for a class name, a colour, or
 * an inline style; the one affordance it leaves behind is `data-studio-state`,
 * which names the rendered state for whatever draws it next.
 *
 * There is no URL field and never will be: Studio talks to its own origin and
 * `acker studio` owns the target. A field here would be a second way to point
 * Studio at a server, and the wrong one — it would put an operator's Admin
 * Credential one typo away from an origin nobody chose.
 */
import { useAuthentication } from "@ackerdb/client-react";
import type { AdminSystemInfo } from "@ackerdb/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { studioCredential } from "./credential.ts";
import { studioConnection, type StudioConnection } from "./connection.ts";
import { probeAdminApi, type StudioProbe } from "./probe.ts";

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

function useStudioConnection(): StudioConnection {
  const held = useSyncExternalStore(studioCredential.subscribe, studioCredential.read, () => null);
  const { state: authentication } = useAuthentication();
  const probe = useAdminProbe(held, authentication.phase === "authenticated");
  return studioConnection({ hasCredential: held !== null, probe, authentication });
}

function ApplicationHeader({ application }: { readonly application: AdminSystemInfo }) {
  return (
    <dl>
      <dt>application</dt>
      <dd>{application.name} {application.version}</dd>
      <dt>ackerdb</dt>
      <dd>{application.ackerdb}</dd>
      <dt>protocol</dt>
      <dd>{application.protocol}</dd>
    </dl>
  );
}

function CredentialForm({ busy, onSubmit }: {
  readonly busy: boolean;
  readonly onSubmit: (token: string) => void;
}) {
  const [token, setToken] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(token);
        setToken("");
      }}
    >
      <label htmlFor="studio-credential">Admin Credential</label>
      <input
        id="studio-credential"
        name="credential"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={token}
        onChange={(event) => setToken(event.target.value)}
      />
      <button type="submit" disabled={busy || token.trim() === ""}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export function ConnectScreen() {
  const connection = useStudioConnection();
  const { refresh, signOut } = useAuthentication();
  const [busy, setBusy] = useState(false);

  // Writing the cell then asking the client to re-pull is the whole sign-in:
  // the source owns what a credential is, and `refresh()` is the client's "a
  // sign-in just happened". The probe re-runs on its own, because the cell it
  // reads is the same one. A rejection is not swallowed — it becomes the
  // authentication phase this screen already renders as `refused`.
  const signIn = (token: string) => {
    studioCredential.write(token);
    setBusy(true);
    void refresh().catch(() => {}).finally(() => setBusy(false));
  };
  const forget = () => {
    studioCredential.write(null);
    setBusy(true);
    void signOut().catch(() => {}).finally(() => setBusy(false));
  };

  return (
    <main data-studio-state={connection.state}>
      <h1>AckerDB Studio</h1>
      {connection.state === "connecting" && <p>Asking the application server…</p>}
      {connection.state === "unreachable" && (
        <>
          <h2>Application unreachable</h2>
          <p>{connection.detail}</p>
          <p>Studio is serving; it retries on its own until the application comes up.</p>
        </>
      )}
      {connection.state === "unconfigured" && (
        <>
          <h2>Sign in</h2>
          <p>Studio authenticates with an Admin Credential, not as an application user.</p>
          <CredentialForm busy={busy} onSubmit={signIn} />
        </>
      )}
      {connection.state === "refused" && (
        <>
          <h2>Credential refused</h2>
          <p>{connection.detail}</p>
          <CredentialForm busy={busy} onSubmit={signIn} />
        </>
      )}
      {connection.state === "session-failed" && (
        <>
          <h2>Signed in, but Studio cannot hold a session</h2>
          <p>{connection.detail}</p>
          <p>
            This credential opens the Admin API, so another one will not help.
            Report the message above.
          </p>
          <button type="button" onClick={forget} disabled={busy}>
            Forget this credential
          </button>
        </>
      )}
      {connection.state === "authenticated" && (
        <>
          <h2>Connected</h2>
          <ApplicationHeader application={connection.application} />
          <button type="button" onClick={forget} disabled={busy}>
            Forget this credential
          </button>
        </>
      )}
    </main>
  );
}
