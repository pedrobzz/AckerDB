import { describe, expect, test } from "bun:test";
import { ADMIN_SYSTEM_INFO_PATH, probeAdminApi, type StudioFetch } from "../../../src/app/connect/probe.ts";

/** A fetch that records what it was asked and answers what the test says. */
function answering(reply: Response | Error): {
  readonly request: StudioFetch;
  readonly calls: { path: string; authorization: string | null }[];
} {
  const calls: { path: string; authorization: string | null }[] = [];
  const request: StudioFetch = (path, init) => {
    calls.push({ path, authorization: new Headers(init?.headers).get("authorization") });
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply.clone());
  };
  return { request, calls };
}

const APPLICATION = { name: "savoria-eu", version: "2.1.0", ackerdb: "0.17.0", protocol: 6 };

describe("the Admin API probe", () => {
  test("asks the address the reference resolves to, on the page's own origin", async () => {
    expect(ADMIN_SYSTEM_INFO_PATH).toBe("/admin/system/info");
    const { request, calls } = answering(Response.json(APPLICATION));
    await probeAdminApi(request, "ackerdb_credential.a.b");
    expect(calls).toEqual([
      { path: "/admin/system/info", authorization: "Bearer ackerdb_credential.a.b" },
    ]);
  });

  test("carries no authorization header when Studio holds no credential", async () => {
    const { request, calls } = answering(
      Response.json({ code: "unauthenticated", message: "authentication required" }, { status: 401 }),
    );
    expect(await probeAdminApi(request, null))
      .toEqual({ status: "refused", detail: "authentication required" });
    expect(calls[0]!.authorization).toBeNull();
  });

  test("the proxy's 502 is the unreachable answer, carrying its diagnosis", async () => {
    const detail = "AckerDB Studio could not reach the application server at http://127.0.0.1:3211";
    const { request } = answering(new Response(`${detail}\n`, { status: 502 }));
    expect(await probeAdminApi(request, "held"))
      .toEqual({ status: "unreachable", detail });
  });

  test("a request that never completes is unreachable too, not a refusal", async () => {
    // Studio served the page, so the hop that failed is the one to the
    // application — reporting it as a bad credential would misdirect entirely.
    const { request } = answering(new TypeError("Failed to fetch"));
    expect(await probeAdminApi(request, "held"))
      .toEqual({ status: "unreachable", detail: "Failed to fetch" });
  });

  test("an answer names the application, which nothing else through a proxy does", async () => {
    const { request } = answering(Response.json(APPLICATION));
    expect(await probeAdminApi(request, "held"))
      .toEqual({ status: "open", application: APPLICATION });
  });

  test("a refusal reports the framework's own message, and a bodiless one its status", async () => {
    const { request: unauthorized } = answering(
      Response.json({ code: "unauthorized", message: "missing scope _admin:system:read" }, { status: 403 }),
    );
    expect(await probeAdminApi(unauthorized, "held"))
      .toEqual({ status: "refused", detail: "missing scope _admin:system:read" });

    const { request: html } = answering(new Response("<!doctype html>", { status: 500 }));
    expect(await probeAdminApi(html, "held"))
      .toEqual({ status: "refused", detail: "the application answered HTTP 500" });
  });
});
