/**
 * The screens Studio has, and what each one is for.
 *
 * **The table is the shell's whole knowledge of the product.** Navigation
 * renders it, the empty state a screen shows before its feature lands reads its
 * copy from it, and `routes.tsx` mounts one route per key — with a compile-time
 * assertion in `test/app/shell/screens.check.ts` that the two sets are the
 * same, so a screen added here without a route (or the reverse) fails the
 * typecheck rather than becoming a nav entry that leads nowhere.
 *
 * Every entry is a screen the map already decided and scheduled, named by its
 * issue. Nothing here is a placeholder for an idea: a nav entry is a promise
 * about what this build will become, and one that no ticket owns is a promise
 * nobody made. When a feature lands, its route gains a component and its entry
 * loses nothing — the description is what the screen shows, not an apology for
 * what it does not.
 */
import {
  Analytics01FreeIcons,
  Bug01FreeIcons,
  Clock01FreeIcons,
  ComputerTerminal01FreeIcons,
  Database01FreeIcons,
  File01FreeIcons,
  Folder01FreeIcons,
  FlowFreeIcons,
  PulseRectangleFreeIcons,
  Satellite03FreeIcons,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

/**
 * What a group of screens is about. Observability is what the application did;
 * administration is what an operator can change about it. The split is the
 * order the epics ship in, which is not a coincidence — one is read-only and
 * the other is not.
 */
export type ScreenGroup = "observability" | "administration";

export interface Screen {
  /** Shown in the navigation and as the screen's heading. */
  readonly title: string;
  readonly group: ScreenGroup;
  readonly icon: IconSvgElement;
  /** One sentence: what an operator will find here. Present tense, no hedging. */
  readonly description: string;
}

/**
 * Keyed by the path segment beneath `/_studio/`, because a screen's key, its
 * route and its URL are one string in three places and disagreement between
 * them is a nav entry that 404s.
 */
export const SCREENS = {
  logs: {
    title: "Logs",
    group: "observability",
    icon: File01FreeIcons,
    description:
      "One stream of application and framework logs, filtered by chips and read live as it arrives.",
  },
  traces: {
    title: "Traces",
    group: "observability",
    icon: FlowFreeIcons,
    description:
      "Which operations run, how long they take, and the span waterfall behind any one of them.",
  },
  errors: {
    title: "Errors",
    group: "observability",
    icon: Bug01FreeIcons,
    description:
      "Unhandled failures grouped by fingerprint, with occurrence counts and a resolve state.",
  },
  analytics: {
    title: "Analytics",
    group: "observability",
    icon: Analytics01FreeIcons,
    description: "The event stream, trends and funnels, and one identity's timeline through them.",
  },
  health: {
    title: "Health",
    group: "observability",
    icon: PulseRectangleFreeIcons,
    description: "Live runtime vitals, and per-minute history for the metrics worth keeping.",
  },
  data: {
    title: "Data",
    group: "administration",
    icon: Database01FreeIcons,
    description: "Browse and edit the application's tables through the ordinary validated write path.",
  },
  jobs: {
    title: "Jobs",
    group: "administration",
    icon: Clock01FreeIcons,
    description: "Scheduled and queued jobs, every run they produced, and the controls to steer them.",
  },
  files: {
    title: "Files",
    group: "administration",
    icon: Folder01FreeIcons,
    description: "Stored files, who may reach them, and where the storage a bucket reports went.",
  },
  realtime: {
    title: "Realtime",
    group: "administration",
    icon: Satellite03FreeIcons,
    description: "Live connections, subscriptions, channels and media sessions, counted as they are.",
  },
  functions: {
    title: "Functions",
    group: "administration",
    icon: ComputerTerminal01FreeIcons,
    description: "Run any declared function with generated argument forms, optionally as another identity.",
  },
} as const satisfies Record<string, Screen>;

export type ScreenKey = keyof typeof SCREENS;

/** The navigation's order: groups in shipping order, screens in map order. */
export const SCREEN_GROUPS: readonly { readonly group: ScreenGroup; readonly label: string }[] = [
  { group: "observability", label: "Observability" },
  { group: "administration", label: "Administration" },
];

export function screensOf(group: ScreenGroup): readonly (readonly [ScreenKey, Screen])[] {
  return (Object.entries(SCREENS) as [ScreenKey, Screen][]).filter(
    ([, screen]) => screen.group === group,
  );
}
