import { afterEach, describe, expect, test } from "bun:test";
import "ackerdb-test-support/dom";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { STUDIO_PATH_PREFIX } from "../../../src/origin.ts";
import { SCREENS, type ScreenKey } from "../../../src/app/shell/screens.ts";
import { PendingScreen, ScreenFailure } from "../../../src/app/shell/screen.tsx";
import { Navigation } from "../../../src/app/shell/navigation.tsx";
import { mountStudio, type MountedStudio } from "../../support/render.tsx";

let mounted: MountedStudio | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

/**
 * A router carrying the navigation and the screen paths, and nothing else.
 *
 * The real tree hangs the navigation under the connect gate, which needs a
 * live application to open — so mounting it here would test the connect screen
 * instead. What this suite is about is the entries, and the paths they resolve
 * against are the same strings: `screens.check.ts` proves at compile time that
 * the real tree mounts exactly the keys of {@link SCREENS}, which is what makes
 * a router built from those keys equivalent to it by construction.
 */
function withRouter(initial: string) {
  const rootRoute = createRootRoute({ component: Navigation });
  const routeTree = rootRoute.addChildren(
    (Object.keys(SCREENS) as ScreenKey[]).map((key) =>
      createRoute({ getParentRoute: () => rootRoute, path: `/${key}`, component: () => null }),
    ),
  );
  const router = createRouter({
    routeTree,
    basepath: STUDIO_PATH_PREFIX,
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  return <RouterProvider router={router as never} />;
}

describe("the navigation", () => {
  test("every screen the table declares has an entry, and nothing else does", async () => {
    mounted = mountStudio(withRouter(`${STUDIO_PATH_PREFIX}logs`));
    await mounted.settle();
    // The navigation is a promise about what this build becomes. An entry with
    // no screen behind it is a promise nobody made.
    const links = [...mounted.container.querySelectorAll("nav a")].map((a) => a.getAttribute("href"));
    const expected = (Object.keys(SCREENS) as ScreenKey[]).map((key) => `${STUDIO_PATH_PREFIX}${key}`);
    expect(links).toEqual(expected);
  });

  test("entries are links, so the browser's own affordances work on a screen", async () => {
    // Middle-click, copy link, back. A screen reached by a button that pushes
    // history is a screen an operator has to describe instead of sending.
    mounted = mountStudio(withRouter(`${STUDIO_PATH_PREFIX}logs`));
    await mounted.settle();
    for (const anchor of mounted.container.querySelectorAll("nav a")) {
      expect(anchor.tagName).toBe("A");
      expect(anchor.getAttribute("href")?.startsWith(STUDIO_PATH_PREFIX)).toBe(true);
    }
  });

  test("the current screen is the only one marked, and it is marked for a reader too", async () => {
    mounted = mountStudio(withRouter(`${STUDIO_PATH_PREFIX}jobs`));
    await mounted.settle();
    const current = [...mounted.container.querySelectorAll("nav a[aria-current=page]")];
    expect(current.map((a) => a.getAttribute("href"))).toEqual([`${STUDIO_PATH_PREFIX}jobs`]);
  });

  test("the two groups are labelled and hold every screen between them", async () => {
    mounted = mountStudio(withRouter(`${STUDIO_PATH_PREFIX}logs`));
    await mounted.settle();
    const headings = [...mounted.container.querySelectorAll("nav h2")].map((h) => h.textContent);
    expect(headings).toEqual(["Observability", "Administration"]);
    expect(mounted.container.querySelectorAll("nav a").length).toBe(Object.keys(SCREENS).length);
  });
});

describe("a screen with nothing in it yet", () => {
  test("says what the screen is for before admitting it is empty", () => {
    // An empty page reading only "coming soon" teaches an operator that Studio
    // is a promise. Naming what it will hold is the useful thing it can say.
    for (const key of Object.keys(SCREENS) as ScreenKey[]) {
      mounted = mountStudio(<PendingScreen screen={key} />);
      const text = mounted.container.textContent ?? "";
      expect(mounted.container.querySelector("[data-studio-screen]")?.getAttribute("data-studio-screen"))
        .toBe(key);
      expect(text).toContain(SCREENS[key].title);
      expect(text).toContain(SCREENS[key].description);
      expect(text).toContain("empty in this build");
      mounted.unmount();
      mounted = undefined;
    }
  });
});

describe("a screen that threw", () => {
  test("names the failure and says the rest of Studio is still standing", () => {
    mounted = mountStudio(
      <ScreenFailure error={new Error("the read model is not there")} resetErrorBoundary={() => {}} />,
    );
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("the read model is not there");
    expect(text).toContain("Studio is still connected");
  });

  test("a thrown non-error still reads as something", () => {
    mounted = mountStudio(<ScreenFailure error={"a string was thrown"} resetErrorBoundary={() => {}} />);
    expect(mounted.container.textContent).toContain("a string was thrown");
  });
});
