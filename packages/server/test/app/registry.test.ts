import { describe, expect, test } from "bun:test";
import { procedure } from "../../src/app/functions.ts";
import { Registry } from "../../src/app/registry.ts";
import { http, type Http } from "../../src/transport/routing/route.ts";

const fn = procedure({
  access: "public",
  args: {},
  handler: () => null,
});

describe("the application Registry", () => {
  test("rejects an unknown definition kind at the module boundary", () => {
    const unknown = { ...fn, kind: "queryy" } as never;
    expect(() => new Registry({ notes: { unknown } })).toThrow(
      'function module export "notes.unknown" has unknown definition kind "queryy"',
    );
  });

  test("contributes a raw route directly without manufacturing an address", () => {
    const route = http("/webhooks/:provider/callback", {
      POST: () => new Response(null),
    });
    const routes: Http[] = [];
    const registry = new Registry(
      { hooks: { callback: route } },
      (http) => routes.push(http),
    );

    expect(routes).toEqual([route]);
    expect(registry.get("api.hooks.callback")).toBeUndefined();
    expect(registry.kindOf("api.hooks.callback")).toBeUndefined();
    expect(registry.addressOf(route)).toBeUndefined();
  });
});
