/**
 * The navigation: every screen Studio has, grouped, with the current one marked.
 *
 * The entries are router `Link`s rather than buttons that push history, so the
 * browser's own affordances — middle-click, copy link, back — work on a Studio
 * screen exactly as they work on a page. That is the same reason filters will
 * live in the URL: a screen an operator cannot send to someone else is a screen
 * they have to describe instead.
 */
import { Link } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { SCREENS, SCREEN_GROUPS, screensOf } from "./screens.ts";

export function Navigation() {
  return (
    <nav aria-label="Studio screens" className="flex flex-col gap-6 p-3">
      {SCREEN_GROUPS.map(({ group, label }) => (
        <div key={group} className="flex flex-col gap-1">
          <h2 className="px-3 pb-1 text-[0.6875rem] font-semibold tracking-widest text-muted-foreground uppercase">
            {label}
          </h2>
          {screensOf(group).map(([key]) => (
            <Link
              key={key}
              to={`/${key}`}
              className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              activeProps={{
                className: "bg-primary/12 text-primary hover:bg-primary/12 hover:text-primary",
                "aria-current": "page",
              }}
            >
              <HugeiconsIcon icon={SCREENS[key].icon} size={17} strokeWidth={1.8} />
              {SCREENS[key].title}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
