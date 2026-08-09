/**
 * What the printed URL opens onto.
 *
 * `acker studio` prints the origin plus the prefix, so this is the first thing
 * an operator sees after signing in, and it is not a screen — it is the shell
 * saying which application it reached and pointing at the screens. It carries
 * no navigation of its own beyond the two groups, because the navigation is two
 * inches to the left and duplicating it here would make one of the two the
 * stale copy.
 *
 * The alternative was redirecting the prefix at the first screen. It reads well
 * until a screen is empty, and then the printed URL opens onto a page that says
 * a feature is missing — which is a poor thing for the URL an operator was
 * handed to be.
 */
import { SCREENS, SCREEN_GROUPS, screensOf } from "./screens.ts";

export function StudioLanding() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8" data-studio-screen="landing">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Connected
        </h1>
        <p className="text-sm text-muted-foreground">
          Studio is signed in with an Admin Credential and reads only the Admin API. Pick a
          screen; the header above names the application it is reading.
        </p>
      </div>
      {SCREEN_GROUPS.map(({ group, label }) => (
        <section key={group} className="flex flex-col gap-3">
          <h2 className="text-[0.6875rem] font-semibold tracking-widest text-muted-foreground uppercase">
            {label}
          </h2>
          <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-[8rem_1fr]">
            {screensOf(group).map(([key]) => (
              <div key={key} className="contents">
                <dt className="text-sm font-medium text-foreground">{SCREENS[key].title}</dt>
                <dd className="text-sm text-muted-foreground">{SCREENS[key].description}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
