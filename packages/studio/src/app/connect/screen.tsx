/**
 * The connect screen: the five states Studio can be in before it is connected,
 * and the one field it ever asks for.
 *
 * The states themselves are `studioConnection`'s and are not re-derived here —
 * this file decides only what each one looks like. Two of them earn their
 * appearance rather than inheriting it:
 *
 * - **Unreachable is not an error the operator caused.** Studio is up and the
 *   application is not; it is amber rather than red, it says Studio keeps
 *   asking, and it offers no field, because typing a credential would not help
 *   and the screen should not imply it might.
 * - **A protocol Studio does not speak names the fix.** The detail carries the
 *   two versions and the AckerDB release to install, so the screen renders it
 *   as the instruction it is instead of flattening it into "something went
 *   wrong". That sentence is the entire value of the state.
 *
 * There is no URL field and never will be: Studio talks to its own origin and
 * `acker studio` owns the target. A field here would be a second way to point
 * Studio at a server, and the wrong one — it would put an operator's Admin
 * Credential one typo away from an origin nobody chose.
 */
import {
  AlertCircleFreeIcons,
  Key01FreeIcons,
  Loading03FreeIcons,
  UnavailableFreeIcons,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useState, type ReactNode } from "react";
import { useStudioSession } from "../session.ts";
import { Button } from "../ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card.tsx";
import { Input } from "../ui/input.tsx";
import type { StudioConnection } from "./connection.ts";

/** Every state but the one the gate keeps for itself. */
export type UnconnectedStudio = Exclude<StudioConnection, { state: "authenticated" }>;

/**
 * The signal a state carries. Amber is "the world is not ready"; red is "this
 * credential is not the one"; the primary is the ordinary ask.
 */
const TONES = {
  neutral: "bg-muted text-muted-foreground",
  primary: "bg-primary/12 text-primary",
  warning: "bg-signal-orange/12 text-signal-orange",
  danger: "bg-destructive/15 text-signal-red",
} as const;

function Panel({
  state,
  icon,
  tone,
  spin = false,
  title,
  children,
}: {
  readonly state: string;
  readonly icon: IconSvgElement;
  readonly tone: keyof typeof TONES;
  readonly spin?: boolean;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <main
      data-studio-state={state}
      className="flex min-h-full items-center justify-center bg-background p-6"
    >
      <div className="flex w-full max-w-md flex-col gap-6">
        <div className="flex items-center justify-center gap-2.5">
          <span className="size-2.5 rounded-full bg-primary" />
          <h1 className="text-sm font-semibold tracking-tight text-foreground">AckerDB Studio</h1>
        </div>
        <Card>
          <CardHeader className="items-start gap-4">
            <span
              className={`flex size-11 items-center justify-center rounded-lg ${TONES[tone]}`}
            >
              <HugeiconsIcon
                icon={icon}
                size={22}
                strokeWidth={1.8}
                className={spin ? "animate-spin" : undefined}
              />
            </span>
            <CardTitle className="text-lg">{title}</CardTitle>
          </CardHeader>
          {children}
        </Card>
      </div>
    </main>
  );
}

/**
 * The credential field.
 *
 * The submit sits *below* the field at full width rather than beside it. That
 * is a layout choice with a reason: a control that shares a line with the input
 * it submits is a control whose hit target and the field's are one row apart in
 * pixels, and both this screen's states put the same button in the same place,
 * so the target has to be unambiguous at every width.
 */
function CredentialForm({ busy, onSubmit }: {
  readonly busy: boolean;
  readonly onSubmit: (token: string) => void;
}) {
  const [token, setToken] = useState("");
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(token);
        setToken("");
      }}
    >
      <div className="flex flex-col gap-2">
        <label
          htmlFor="studio-credential"
          className="text-xs font-medium tracking-wide text-muted-foreground"
        >
          Admin Credential
        </label>
        <Input
          id="studio-credential"
          name="credential"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="ackerdb_credential…"
          className="font-mono"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
      </div>
      <Button type="submit" className="w-full" disabled={busy || token.trim() === ""}>
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

/** A failure detail from the server or the transport, quoted rather than paraphrased. */
function Detail({ children }: { readonly children: ReactNode }) {
  return (
    <p className="rounded-md border border-border bg-muted/60 px-3 py-2 font-mono text-xs leading-relaxed break-words text-muted-foreground">
      {children}
    </p>
  );
}

export function ConnectScreen({ connection }: { readonly connection: UnconnectedStudio }) {
  const { busy, signIn, forget } = useStudioSession();

  switch (connection.state) {
    case "connecting":
      return (
        <Panel state="connecting" icon={Loading03FreeIcons} tone="neutral" spin title="Connecting">
          <CardContent>
            <CardDescription>Asking the application server.</CardDescription>
          </CardContent>
        </Panel>
      );

    case "unreachable":
      return (
        <Panel
          state="unreachable"
          icon={UnavailableFreeIcons}
          tone="warning"
          title="Application unreachable"
        >
          <CardContent className="flex flex-col gap-3">
            <CardDescription>
              Studio is serving and the application is not answering it. Start it, or check the
              target <code className="font-mono text-foreground">acker studio</code> was pointed at.
            </CardDescription>
            <Detail>{connection.detail}</Detail>
            <p className="text-xs text-muted-foreground/70">
              Studio keeps asking on its own; this screen changes when the application comes up.
            </p>
          </CardContent>
        </Panel>
      );

    case "unconfigured":
      return (
        <Panel state="unconfigured" icon={Key01FreeIcons} tone="primary" title="Sign in">
          <CardContent className="flex flex-col gap-5">
            <CardDescription>
              Studio authenticates with an Admin Credential, not as an application user. A server
              whose vault holds none prints one at startup, once.
            </CardDescription>
            <CredentialForm busy={busy} onSubmit={signIn} />
          </CardContent>
        </Panel>
      );

    case "refused":
      return (
        <Panel
          state="refused"
          icon={AlertCircleFreeIcons}
          tone="danger"
          title="Credential refused"
        >
          <CardContent className="flex flex-col gap-5">
            <CardDescription>
              The application would not open the Admin API with this credential. Another one may.
            </CardDescription>
            <Detail>{connection.detail}</Detail>
            <CredentialForm busy={busy} onSubmit={signIn} />
          </CardContent>
        </Panel>
      );

    case "session-failed":
      return (
        <Panel
          state="session-failed"
          icon={AlertCircleFreeIcons}
          tone="danger"
          title="Signed in, but Studio cannot hold a session"
        >
          <CardContent className="flex flex-col gap-5">
            {/*
              The detail is the whole answer in the case this state reaches in
              practice — it names both protocol versions and the AckerDB release
              whose Studio speaks the application's. It is rendered first and on
              its own, because a screen that leads with "something failed" and
              buries the instruction is a screen that gets a bug report.
            */}
            <Detail>{connection.detail}</Detail>
            <CardDescription>
              This credential opens the Admin API, so another one will not help.
            </CardDescription>
            <Button variant="outline" className="w-full" onClick={forget} disabled={busy}>
              Forget this credential
            </Button>
          </CardContent>
        </Panel>
      );
  }
}
