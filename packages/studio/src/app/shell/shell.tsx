/**
 * The frame every Studio screen renders inside: navigation on the left, the
 * connected application across the top, the screen itself in the rest.
 *
 * **The screen is the only part that may fail.** Each one gets its own error
 * boundary, keyed by route, so a screen that throws leaves the navigation and
 * the application header standing and an operator can walk out of it. The
 * alternative — one boundary around everything — turns any screen's bug into a
 * blank page, which is the same amount of code and none of the recovery. The
 * key is what makes navigating away a reset: React reuses a boundary that keeps
 * its identity, so without it a screen that failed once stays failed.
 */
import { Outlet, useRouterState } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { Logout01FreeIcons } from "@hugeicons/core-free-icons";
import { ErrorBoundary } from "react-error-boundary";
import { useStudioSession } from "../session.ts";
import { Button } from "../ui/button.tsx";
import { ApplicationIdentity } from "./application.tsx";
import { Navigation } from "./navigation.tsx";
import { ScreenFailure } from "./screen.tsx";

export function Shell() {
  const { busy, forget } = useStudioSession();
  const path = useRouterState({ select: (state) => state.location.pathname });
  return (
    <div className="flex h-full min-h-0 bg-background" data-studio-state="authenticated">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-card">
        <div className="flex h-16 shrink-0 items-center gap-2.5 border-b border-border px-6">
          <span className="size-2.5 rounded-full bg-primary" />
          <span className="text-sm font-semibold tracking-tight text-foreground">
            AckerDB Studio
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Navigation />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between gap-6 border-b border-border px-8">
          <ApplicationIdentity />
          <Button variant="ghost" size="sm" onClick={forget} disabled={busy}>
            <HugeiconsIcon icon={Logout01FreeIcons} size={16} strokeWidth={1.8} />
            Sign out
          </Button>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto p-8">
          <ErrorBoundary key={path} FallbackComponent={ScreenFailure}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
