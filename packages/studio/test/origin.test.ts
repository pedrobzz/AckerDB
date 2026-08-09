import { describe, expect, test } from "bun:test";
import { RESERVED_MARKER } from "@ackerdb/core";
import { STUDIO_PATH_PREFIX, studioRoute } from "../src/origin.ts";

describe("the Studio path prefix", () => {
  test("carries the reserved marker, so no application can ever declare it", () => {
    expect(STUDIO_PATH_PREFIX.startsWith(`/${RESERVED_MARKER}`)).toBe(true);
    expect(STUDIO_PATH_PREFIX.endsWith("/")).toBe(true);
  });
});

describe("studioRoute", () => {
  test("serves the SPA only inside its own prefix", () => {
    expect(studioRoute("GET", "/_studio/")).toEqual({ kind: "studio", path: "" });
    expect(studioRoute("GET", "/_studio/assets/index.js"))
      .toEqual({ kind: "studio", path: "assets/index.js" });
    // A client-side route the bundle has no file for: still the SPA's.
    expect(studioRoute("GET", "/_studio/database/users"))
      .toEqual({ kind: "studio", path: "database/users" });
  });

  test("an unknown path is the application's, whatever the browser asks for", () => {
    // The failure that matters: an application group named after a Studio
    // screen must reach the application, and a path nobody serves must come
    // back as the application's visible 404 rather than a plausible shell.
    expect(studioRoute("GET", "/logs")).toEqual({ kind: "application" });
    expect(studioRoute("GET", "/database/users")).toEqual({ kind: "application" });
    expect(studioRoute("GET", "/_studiofake/x")).toEqual({ kind: "application" });
  });

  test("GET-able application and Admin API addresses are never shadowed", () => {
    expect(studioRoute("GET", "/admin/system/info")).toEqual({ kind: "application" });
    expect(studioRoute("GET", "/api/messages/list")).toEqual({ kind: "application" });
    expect(studioRoute("GET", "/live")).toEqual({ kind: "application" });
    expect(studioRoute("GET", "/_ws")).toEqual({ kind: "application" });
  });

  test("a browser landing on the bare origin is redirected into the prefix", () => {
    expect(studioRoute("GET", "/")).toEqual({ kind: "redirect", location: STUDIO_PATH_PREFIX });
    expect(studioRoute("HEAD", "/")).toEqual({ kind: "redirect", location: STUDIO_PATH_PREFIX });
    expect(studioRoute("GET", "/_studio"))
      .toEqual({ kind: "redirect", location: STUDIO_PATH_PREFIX });
  });

  test("the root redirect is a navigation affordance, so it never claims a method MCP speaks", () => {
    // `/` is a legal MCP endpoint path, and MCP speaks POST and OPTIONS.
    expect(studioRoute("POST", "/")).toEqual({ kind: "application" });
    expect(studioRoute("OPTIONS", "/")).toEqual({ kind: "application" });
  });

  test("a non-navigation inside the prefix is refused rather than proxied", () => {
    expect(studioRoute("POST", "/_studio/anything")).toEqual({ kind: "refused" });
    expect(studioRoute("DELETE", "/_studio/")).toEqual({ kind: "refused" });
  });
});
