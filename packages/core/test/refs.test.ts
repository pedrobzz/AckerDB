import { describe, expect, test } from "bun:test";
import { anyApi, apiGroup, EVENTS_ADDRESS_PREFIX, getRef, httpPathForAddress } from "@ackerdb/core";

describe("function references", () => {
  test("anyApi builds dot-joined addresses under the default group", () => {
    expect(anyApi.messages.list.$ref).toBe("api.messages.list");
    expect(anyApi.admin.users.get.$ref).toBe("api.admin.users.get");
    expect(anyApi.events.typingEvents.$ref).toBe("api.events.typingEvents");
  });

  test("a group is the address's first segment, not a field beside it", () => {
    // The whole point of the group: two groups may hold one trailing name and
    // the addresses stay distinct, so neither can squat on the other.
    expect(apiGroup("internal").messages.list.$ref).toBe("internal.messages.list");
    expect(apiGroup("admin").messages.list.$ref).toBe("admin.messages.list");
    expect(anyApi.messages.list.$ref).not.toBe(apiGroup("internal").messages.list.$ref);
    expect(Object.keys(anyApi.messages.list)).toEqual(["$ref"]);
  });

  test("the event namespace is addressed inside the default group like everything else", () => {
    expect(anyApi.events.typingEvents.$ref).toBe(`${EVENTS_ADDRESS_PREFIX}typingEvents`);
  });

  test("an exposed function's URL is its address, segment for segment", () => {
    expect(httpPathForAddress(anyApi.messages.list.$ref)).toBe("/api/messages/list");
    expect(httpPathForAddress(apiGroup("internal").messages.list.$ref))
      .toBe("/internal/messages/list");
  });

  test("getRef accepts references and strings", () => {
    expect(getRef(anyApi.messages.send)).toBe("api.messages.send");
    expect(getRef("api.messages.send")).toBe("api.messages.send");
  });

  test("getRef rejects non-references", () => {
    expect(() => getRef({} as never)).toThrow("not a ackerdb function reference");
  });
});
