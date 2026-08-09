/**
 * What a screen looks like before it has anything to show, and what it looks
 * like when it breaks.
 *
 * **An empty screen states what it is for, not that it is missing.** A build
 * whose features arrive one at a time will show these for a while, and a page
 * reading "coming soon" teaches an operator that Studio is a promise. Naming
 * what the screen will hold — the same sentence the navigation would use — is
 * both honest and the most useful thing an empty page can say. The one line
 * that admits the state is exactly one line, in the muted colour every other
 * secondary fact uses.
 *
 * The failure fallback is deliberately the same shape. A screen that threw and
 * a screen that has nothing are the same size and the same weight on the page,
 * so the layout does not jump and the difference is carried by what it says
 * rather than by how much of the window it takes.
 */
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleFreeIcons } from "@hugeicons/core-free-icons";
import type { FallbackProps } from "react-error-boundary";
import { Card, CardDescription, CardHeader, CardTitle } from "../ui/card.tsx";
import { SCREENS, type ScreenKey } from "./screens.ts";

/** A screen whose feature has not landed in this build. */
export function PendingScreen({ screen }: { readonly screen: ScreenKey }) {
  const { title, description, icon } = SCREENS[screen];
  return (
    <Card className="mx-auto max-w-2xl" data-studio-screen={screen}>
      <CardHeader className="items-start gap-4">
        <span className="flex size-11 items-center justify-center rounded-lg bg-primary/12 text-primary">
          <HugeiconsIcon icon={icon} size={22} strokeWidth={1.8} />
        </span>
        <div className="flex flex-col gap-1.5">
          <CardTitle className="text-lg">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
          <p className="pt-2 text-sm text-muted-foreground/70">
            This screen is empty in this build. Its feature ships in a later release.
          </p>
        </div>
      </CardHeader>
    </Card>
  );
}

/** One screen threw. The shell around it is still standing, which is the point. */
export function ScreenFailure({ error }: FallbackProps) {
  return (
    <Card className="mx-auto max-w-2xl" data-studio-screen="failed">
      <CardHeader className="items-start gap-4">
        <span className="flex size-11 items-center justify-center rounded-lg bg-destructive/15 text-signal-red">
          <HugeiconsIcon icon={AlertCircleFreeIcons} size={22} strokeWidth={1.8} />
        </span>
        <div className="flex flex-col gap-1.5">
          <CardTitle className="text-lg">This screen stopped</CardTitle>
          <CardDescription className="font-mono">
            {error instanceof Error ? error.message : String(error)}
          </CardDescription>
          <p className="pt-2 text-sm text-muted-foreground/70">
            Studio is still connected. Another screen will open normally.
          </p>
        </div>
      </CardHeader>
    </Card>
  );
}
