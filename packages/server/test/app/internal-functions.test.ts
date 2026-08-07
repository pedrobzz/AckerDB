/**
 * Internal functions (ADR-0021): erased client visibility, orthogonal access.
 * Registration refusals, the transport lookup treating internal names as
 * nonexistent, and composition still validating the callee's policy.
 */
import { describe, expect, test } from "bun:test";
import { ANONYMOUS_PRINCIPAL, SYSTEM_PRINCIPAL } from "../../src/auth/credentials.ts";
import { v } from "../../src/validation/v.ts";
import { mutation, procedure, query, sseProcedure } from "../../src/app/functions.ts";
import { channel } from "../../src/channels/definition.ts";
import { realtime } from "../../src/realtime/definition.ts";
import { mcp, mcpAuth } from "../../src/mcp/index.ts";
import { Registry } from "../../src/app/registry.ts";

describe("internal declarations", () => {
  test("accepts the literal true on query, mutation, and procedure", () => {
    for (const build of [query, mutation, procedure]) {
      const fn = build({
        internal: true,
        access: "public",
        args: {},
        handler: () => null,
      });
      expect(fn.internal).toBe(true);
    }
  });

  test("refuses any internal value other than the literal true", () => {
    expect(() =>
      query({
        internal: false as never,
        access: "public",
        args: {},
        handler: () => null,
      }),
    ).toThrow("internal must be the literal true or absent");
  });

  test("refuses internal combined with HTTP exposure on one declaration", () => {
    expect(() =>
      procedure({
        internal: true,
        http: true,
        access: "public",
        args: {},
        handler: () => null,
      }),
    ).toThrow("internal: true and HTTP exposure");
    // `http: false` is "not exposed" — not a contradiction.
    expect(
      procedure({
        internal: true,
        http: false,
        access: "public",
        args: {},
        handler: () => null,
      }).internal,
    ).toBe(true);
  });

  test("refuses internal on transport-boundary kinds", () => {
    expect(() =>
      sseProcedure({
        internal: true,
        access: "public",
        args: {},
        yields: v.string(),
        handler: async function* () {},
      } as never),
    ).toThrow("cannot declare internal");
    expect(() =>
      channel({
        internal: true,
        access: "public",
        args: {},
        clientEvents: {},
        serverEvents: {},
        authorization: () => true,
      } as never),
    ).toThrow("cannot declare internal");
    expect(() =>
      realtime({
        internal: true,
        access: "public",
        args: {},
        clientEvents: {},
        serverEvents: {},
        clientStreams: {},
        serverStreams: {},
        authorization: () => true,
      } as never),
    ).toThrow("cannot declare internal");
  });
});

describe("the transport lookup", () => {
  const visible = query({
    access: "public",
    args: {},
    handler: () => [],
  });
  const erased = query({
    internal: true,
    description: "List the private index.",
    access: "public",
    args: {},
    returns: v.array(v.string()),
    handler: () => [],
  });

  test("remote() resolves internal addresses exactly as unknown names", () => {
    const registry = new Registry({ messages: { list: visible, index: erased } });
    expect(registry.remote("messages.list")).toBe(visible as never);
    expect(registry.remote("messages.index")).toBeUndefined();
    expect(registry.remote("messages.never-registered")).toBeUndefined();
    // Server-side resolution still sees the function.
    expect(registry.get("messages.index")).toBe(erased as never);
  });

  test("internal functions never claim an HTTP path", () => {
    const registry = new Registry({ messages: { list: visible, index: erased } });
    expect([...registry.exposed.keys()]).toEqual([]);
  });

  test("an MCP tools record may deliberately re-declare an internal function", () => {
    const endpoint = mcp({
      name: "admin",
      auth: mcpAuth({ name: "admin" }),
      path: "/mcp/admin",
      tools: { list_index: { fn: erased, access: "public" } },
    });
    const registry = new Registry({
      messages: { list: visible, index: erased },
      admin: { endpoint },
    });
    // The endpoint's own declaration is the re-exposure; the wire address
    // stays nonexistent.
    expect(registry.mcpTool("admin", "list_index")?.fn).toBe(erased as never);
    expect(registry.remote("messages.index")).toBeUndefined();
  });
});

describe("composition through an internal callee", () => {
  test("still validates args and the callee's access policy", async () => {
    const guarded = mutation({
      internal: true,
      access: "system",
      args: { value: v.string() },
      handler: (_ctx, args) => args.value,
    });

    // The system principal is admitted; the anonymous principal is not —
    // internal changes the address surface, never the admission decision.
    await expect(
      guarded({ auth: SYSTEM_PRINCIPAL } as never, { value: "ok" }),
    ).resolves.toMatchObject({ ok: true, data: "ok" });
    await expect(
      guarded({ auth: ANONYMOUS_PRINCIPAL } as never, { value: "ok" }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(
      guarded({ auth: SYSTEM_PRINCIPAL } as never, { value: 7 as never }),
    ).rejects.toThrow("args.value: expected string, got number");
  });
});
