import { describe, expect, test } from "bun:test";
import { anyApi, EVENTS_ADDRESS_PREFIX, getRef, httpPathForAddress } from "@ackerdb/core";

describe("function references", () => {
  test("anyApi builds dot-joined addresses under the fixed application root", () => {
    expect(anyApi.messages.list.$ref).toBe("api.messages.list");
    expect(anyApi.admin.users.get.$ref).toBe("api.admin.users.get");
    expect(anyApi.events.typingEvents.$ref).toBe("api.events.typingEvents");
    expect(anyApi.events.typingEvents.$ref).toBe(`${EVENTS_ADDRESS_PREFIX}typingEvents`);
  });

  test("a reference carries only its fixed-root address", () => {
    expect(Object.keys(anyApi.messages.list)).toEqual(["$ref"]);
  });

  test("an exposed function's URL is its address, segment for segment", () => {
    expect(httpPathForAddress(anyApi.messages.list.$ref)).toBe("/api/messages/list");
  });

  test("getRef accepts references and strings", () => {
    expect(getRef(anyApi.messages.send)).toBe("api.messages.send");
    expect(getRef("api.messages.send")).toBe("api.messages.send");
  });

  test("getRef rejects non-references", () => {
    expect(() => getRef({} as never)).toThrow("not a ackerdb function reference");
  });
});
