import type { FileStoreRange } from "./store/contract.ts";

export function contentDisposition(type: string, filename: string | null): string {
  const disposition = type === "inline" ? "inline" : "attachment";
  if (filename === null) return disposition;
  const ascii = filename.replace(/[^\x20-\x21\x23-\x5b\x5d-\x7e]|["\\]/g, "_").slice(0, 255);
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function fileEtag(sha256: string): string {
  return `"${sha256}"`;
}

export function fileDigest(sha256: string): string {
  return `sha-256=${Buffer.from(sha256, "hex").toString("base64")}`;
}

export function parseFileRange(
  value: string | null,
  size: number,
): FileStoreRange | null | "invalid" {
  if (value === null) return null;
  if (value.includes(",")) return "invalid";
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (match === null || (match[1] === "" && match[2] === "")) return "invalid";
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return "invalid";
    return { start: Math.max(0, size - suffix), endExclusive: size };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] === "" ? size - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) return "invalid";
  return { start, endExclusive: Math.min(size, requestedEnd + 1) };
}

export interface EntityTag {
  readonly opaque: string;
  readonly weak: boolean;
}

function parseEntityTags(value: string): readonly EntityTag[] | "*" | null {
  if (value.trim() === "*") return "*";
  const tags: EntityTag[] = [];
  let offset = 0;
  while (offset < value.length) {
    while (value[offset] === " " || value[offset] === "\t") offset++;
    const weak = value.slice(offset, offset + 2) === "W/";
    if (weak) offset += 2;
    if (value[offset] !== '"') return null;
    offset++;
    const start = offset;
    while (offset < value.length && value[offset] !== '"') {
      const code = value.charCodeAt(offset);
      if (code === 0x7f || code < 0x21) return null;
      offset++;
    }
    if (offset >= value.length) return null;
    tags.push({ opaque: value.slice(start, offset), weak });
    offset++;
    while (value[offset] === " " || value[offset] === "\t") offset++;
    if (offset === value.length) return tags;
    if (value[offset] !== ",") return null;
    offset++;
  }
  return tags.length === 0 ? null : tags;
}

function strongTagMatches(value: string, expected: EntityTag): boolean {
  const tags = parseEntityTags(value);
  return tags === "*" || tags?.some((tag) => !tag.weak && tag.opaque === expected.opaque) === true;
}

function weakTagMatches(value: string, expected: EntityTag): boolean {
  const tags = parseEntityTags(value);
  return tags === "*" || tags?.some((tag) => tag.opaque === expected.opaque) === true;
}

function httpDate(value: string | null): number | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : Math.floor(timestamp / 1_000) * 1_000;
}

export function preconditionStatus(
  headers: Headers,
  expected: EntityTag,
  lastModified: number,
): 304 | 412 | null {
  const ifMatch = headers.get("if-match");
  if (ifMatch !== null && !strongTagMatches(ifMatch, expected)) return 412;

  const ifUnmodifiedSince = httpDate(headers.get("if-unmodified-since"));
  if (
    ifMatch === null &&
    ifUnmodifiedSince !== null &&
    Math.floor(lastModified / 1_000) * 1_000 > ifUnmodifiedSince
  ) return 412;

  const ifNoneMatch = headers.get("if-none-match");
  if (ifNoneMatch !== null && weakTagMatches(ifNoneMatch, expected)) return 304;

  const ifModifiedSince = httpDate(headers.get("if-modified-since"));
  if (
    ifNoneMatch === null &&
    ifModifiedSince !== null &&
    Math.floor(lastModified / 1_000) * 1_000 <= ifModifiedSince
  ) return 304;
  return null;
}

export function ifRangeMatches(
  value: string | null,
  expected: EntityTag,
  lastModified: number,
): boolean {
  if (value === null) return true;
  const tags = parseEntityTags(value);
  if (tags !== null) {
    return tags !== "*" && tags.length === 1 && !tags[0]!.weak && tags[0]!.opaque === expected.opaque;
  }
  const date = httpDate(value);
  return date !== null && Math.floor(lastModified / 1_000) * 1_000 <= date;
}
