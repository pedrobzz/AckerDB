import { describe, expect, test } from "bun:test";
import {
  contentDisposition,
  fileDigest,
  fileEtag,
  ifRangeMatches,
  parseFileRange,
  preconditionStatus,
} from "../../src/files/http-headers.ts";

describe("File HTTP headers", () => {
  const sha256 = "00".repeat(32);
  const tag = { opaque: sha256, weak: false } as const;
  const modified = Date.parse("2026-08-05T12:00:00.000Z");

  test("encodes safe attachment fallbacks and UTF-8 filenames", () => {
    expect(contentDisposition("attachment", "résumé.pdf")).toBe(
      "attachment; filename=\"r_sum_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
    );
    expect(contentDisposition("inline", null)).toBe("inline");
    expect(fileEtag(sha256)).toBe(`\"${sha256}\"`);
    expect(fileDigest(sha256)).toBe(`sha-256=${Buffer.alloc(32).toString("base64")}`);
  });

  test("parses one bounded byte range", () => {
    expect(parseFileRange(null, 10)).toBeNull();
    expect(parseFileRange("bytes=2-5", 10)).toEqual({ start: 2, endExclusive: 6 });
    expect(parseFileRange("bytes=-3", 10)).toEqual({ start: 7, endExclusive: 10 });
    expect(parseFileRange("bytes=7-99", 10)).toEqual({ start: 7, endExclusive: 10 });
    expect(parseFileRange("bytes=10-", 10)).toBe("invalid");
    expect(parseFileRange("bytes=0-1,3-4", 10)).toBe("invalid");
  });

  test("applies validators and If-Range precedence", () => {
    expect(preconditionStatus(new Headers({ "if-match": `\"${sha256}\"` }), tag, modified)).toBeNull();
    expect(preconditionStatus(new Headers({ "if-match": "\"other\"" }), tag, modified)).toBe(412);
    expect(preconditionStatus(new Headers({ "if-none-match": `W/\"${sha256}\"` }), tag, modified)).toBe(304);
    expect(ifRangeMatches(`\"${sha256}\"`, tag, modified)).toBe(true);
    expect(ifRangeMatches(`W/\"${sha256}\"`, tag, modified)).toBe(false);
    expect(ifRangeMatches("Wed, 05 Aug 2026 12:00:00 GMT", tag, modified)).toBe(true);
  });
});
