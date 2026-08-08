import { describe, expect, test } from "bun:test";
import {
  documentationLocation,
  documentationUrl,
  resolveVersionSwitch,
  versionedDocumentationHref,
  versionedDocumentationMarkdown,
} from "../../src/lib/documentation/identity";

describe("Documentation version routing", () => {
  test("keeps Latest, Canary, and exact stable versions as distinct identities", () => {
    expect(documentationLocation([])).toMatchObject({
      identity: { kind: "latest", basePath: "/docs" },
      slugs: [],
    });
    expect(documentationLocation(["canary", "functions", "queries"])).toMatchObject({
      identity: { kind: "canary", basePath: "/docs/canary" },
      slugs: ["functions", "queries"],
    });
    expect(documentationLocation(["0.18.1", "functions", "queries"])).toMatchObject({
      identity: { kind: "stable", version: "0.18.1", basePath: "/docs/0.18.1" },
      slugs: ["functions", "queries"],
    });
  });

  test("builds channel-aware page URLs from one content route", () => {
    expect(documentationUrl(documentationLocation([]).identity, ["installation"])).toBe(
      "/docs/installation",
    );
    expect(
      documentationUrl(documentationLocation(["canary"]).identity, ["installation"]),
    ).toBe("/docs/canary/installation");
  });

  test("keeps the same page when the target version contains it", () => {
    expect(
      resolveVersionSwitch(
        "/docs/queries",
        { kind: "canary", label: "Canary", basePath: "/docs/canary" },
        {
          routes: ["/", "/queries"],
          entries: [
            { route: "/", ancestry: ["get-started"] },
            { route: "/queries", ancestry: ["functions"] },
          ],
        },
        ["functions"],
      ),
    ).toEqual({ url: "/docs/canary/queries", unavailable: false });
  });

  test("falls back through page-tree ancestry even though public routes are flat", () => {
    expect(
      resolveVersionSwitch(
        "/docs/canary/external-cache-adapters",
        { kind: "latest", label: "Latest", basePath: "/docs" },
        {
          routes: ["/", "/installing-plugins", "/cache-plugin"],
          entries: [
            { route: "/", ancestry: ["get-started"] },
            { route: "/installing-plugins", ancestry: ["plugins"] },
            { route: "/cache-plugin", ancestry: ["plugins", "cache"] },
          ],
        },
        ["plugins", "cache"],
      ),
    ).toEqual({
      url: "/docs/cache-plugin?unavailable=%2Fexternal-cache-adapters",
      unavailable: true,
    });
  });

  test("keeps authored Product documentation links inside the active version", () => {
    expect(
      versionedDocumentationHref("/docs/basic-usage#connect-react", {
        kind: "canary",
        label: "Canary",
        basePath: "/docs/canary",
      }),
    ).toBe("/docs/canary/basic-usage#connect-react");

    expect(
      versionedDocumentationHref("/docs/installation", {
        kind: "stable",
        label: "v0.18.0",
        basePath: "/docs/0.18.0",
        version: "0.18.0",
      }),
    ).toBe("/docs/0.18.0/installation");

    expect(
      versionedDocumentationHref("https://bun.sh/docs", {
        kind: "canary",
        label: "Canary",
        basePath: "/docs/canary",
      }),
    ).toBe("https://bun.sh/docs");
  });

  test("keeps Markdown representations inside the selected version", () => {
    const markdown = [
      "Read [Basic Usage](/docs/basic-usage#connect-react).",
      "Keep [Bun](https://bun.sh/docs) external.",
      "Keep `fetch('/docs/basic-usage')` code unchanged.",
    ].join("\n");

    expect(
      versionedDocumentationMarkdown(markdown, {
        kind: "canary",
        label: "Canary",
        basePath: "/docs/canary",
      }),
    ).toBe(
      [
        "Read [Basic Usage](/docs/canary/basic-usage#connect-react).",
        "Keep [Bun](https://bun.sh/docs) external.",
        "Keep `fetch('/docs/basic-usage')` code unchanged.",
      ].join("\n"),
    );
  });
});
