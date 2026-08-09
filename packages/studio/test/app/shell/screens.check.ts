/**
 * Compile-time assertions binding the screen table to the route tree. Never
 * executed — `bun run typecheck` failing is the test.
 *
 * The navigation renders `SCREENS` and the router mounts `routes.tsx`, and the
 * two are written by hand because a route built in a loop loses the literal
 * path type that makes `<Link to>` a checked fact at all. That leaves exactly
 * one way for them to drift, and this closes it in both directions: a screen
 * with no route is a nav entry that 404s, and a route with no screen is a page
 * an operator can only reach by typing.
 */
import type { RouteIds } from "@tanstack/react-router";
import type { routeTree } from "../../../src/app/routes.tsx";
import type { ScreenKey } from "../../../src/app/shell/screens.ts";

/**
 * The paths the router answers. Two are not screens and never will be: the
 * landing route the shell owns, and the root the tree is hung from.
 */
type MountedScreenPath = Exclude<RouteIds<typeof routeTree>, "/" | "__root__">;

/** The paths the screen table claims exist. */
type ScreenPath = `/${ScreenKey}`;

/** Every screen is mounted: a screen added without a route fails here. */
const everyScreenHasARoute: MountedScreenPath = null as unknown as ScreenPath;

/** Every mounted screen route is a screen: a route added without an entry fails here. */
const everyRouteIsAScreen: ScreenPath = null as unknown as MountedScreenPath;

// @ts-expect-error "settings" is not a screen, so it is not a Studio path
const settingsIsNotAScreen: ScreenPath = "/settings";

export type { MountedScreenPath, ScreenPath };
export { everyRouteIsAScreen, everyScreenHasARoute, settingsIsNotAScreen };
