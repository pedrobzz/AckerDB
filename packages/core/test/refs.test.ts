import { describe, expect, test } from "bun:test";
import { anyApi, getRef } from "@ackerdb/core";

describe("function references", () => {
  test("anyApi builds dot-joined addresses", () => {
    expect(anyApi.messages.list.$ref).toBe("messages.list");
    expect(anyApi.admin.users.get.$ref).toBe("admin.users.get");
    expect(anyApi.events.typingEvents.$ref).toBe("events.typingEvents");
  });

  test("getRef accepts references and strings", () => {
    expect(getRef(anyApi.messages.send)).toBe("messages.send");
    expect(getRef("messages.send")).toBe("messages.send");
  });

  test("getRef rejects non-references", () => {
    expect(() => getRef({} as never)).toThrow("not a ackerdb function reference");
  });
});
