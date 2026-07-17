import { assertStandardJson } from "./standard-json.ts";

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const ICON_SIZE = /^(?:any|[1-9]\d*x[1-9]\d*)$/;
const MAX_METADATA_BYTES = 64 * 1_024;
const utf8 = new TextEncoder();

export type McpJsonValue =
  | null
  | boolean
  | number
  | string
  | McpJsonValue[]
  | { [key: string]: McpJsonValue };

export type McpMetadata = Record<string, McpJsonValue>;
export type McpContentRole = "user" | "assistant";

export interface McpContentAnnotations {
  readonly audience?: McpContentRole[];
  readonly priority?: number;
  readonly lastModified?: string;
}

interface McpAnnotatedContent {
  readonly annotations?: McpContentAnnotations;
  readonly _meta?: McpMetadata;
}

export interface McpTextContent extends McpAnnotatedContent {
  readonly type: "text";
  readonly text: string;
}

export interface McpImageContent extends McpAnnotatedContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface McpAudioContent extends McpAnnotatedContent {
  readonly type: "audio";
  readonly data: string;
  readonly mimeType: string;
}

interface McpResourceContents {
  readonly uri: string;
  readonly mimeType?: string;
  readonly _meta?: McpMetadata;
}

export interface McpTextResourceContents extends McpResourceContents {
  readonly text: string;
  readonly blob?: never;
}

export interface McpBlobResourceContents extends McpResourceContents {
  readonly blob: string;
  readonly text?: never;
}

export interface McpEmbeddedResourceContent extends McpAnnotatedContent {
  readonly type: "resource";
  readonly resource: McpTextResourceContents | McpBlobResourceContents;
}

export interface McpIcon {
  readonly src: string;
  readonly mimeType?: string;
  readonly sizes?: string[];
  readonly theme?: "light" | "dark";
}

export interface McpResourceLinkContent extends McpAnnotatedContent {
  readonly type: "resource_link";
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly icons?: McpIcon[];
}

export type McpContentBlock =
  | McpTextContent
  | McpImageContent
  | McpAudioContent
  | McpEmbeddedResourceContent
  | McpResourceLinkContent;

/** The only result shape accepted from a tool without a declared output schema. */
export interface McpToolResult {
  readonly content: McpContentBlock[];
  readonly isError?: boolean;
  readonly _meta?: McpMetadata;
}

/** Runtime result after either rich-content or structured-output finalization. */
export interface McpCallToolResult extends McpToolResult {
  readonly structuredContent?: Readonly<Record<string, unknown>>;
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${where} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${where} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function knownFields(value: Record<string, unknown>, fields: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) throw new TypeError(`${where} has unknown field "${key}"`);
  }
}

function string(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${where} must be a non-empty string`);
  }
  return value;
}

function uri(value: unknown, where: string): string {
  const result = string(value, where);
  try {
    new URL(result);
  } catch {
    throw new TypeError(`${where} must be an absolute URI`);
  }
  return result;
}

function base64(value: unknown, where: string): string {
  if (typeof value !== "string" || !BASE64.test(value) || value.length % 4 === 1) {
    throw new TypeError(`${where} must be base64-encoded data`);
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (padding > 0 && value.length % 4 !== 0) {
    throw new TypeError(`${where} must be base64-encoded data`);
  }
  return value;
}

function isoDateTime(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = ISO_DATE_TIME.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1]! &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

function metadata(value: unknown, where: string): void {
  record(value, where);
  assertStandardJson(value, where);
  const encoded = JSON.stringify(value);
  if (utf8.encode(encoded).byteLength > MAX_METADATA_BYTES) {
    throw new TypeError(`${where} must be at most ${MAX_METADATA_BYTES} UTF-8 bytes`);
  }
}

function annotations(value: unknown, where: string): void {
  const input = record(value, where);
  knownFields(input, ["audience", "priority", "lastModified"], where);
  if (input.audience !== undefined) {
    if (
      !Array.isArray(input.audience) ||
      input.audience.some((role) => role !== "user" && role !== "assistant")
    ) {
      throw new TypeError(`${where}.audience must contain only user or assistant`);
    }
  }
  if (
    input.priority !== undefined &&
    (typeof input.priority !== "number" ||
      !Number.isFinite(input.priority) ||
      input.priority < 0 ||
      input.priority > 1)
  ) {
    throw new TypeError(`${where}.priority must be between 0 and 1`);
  }
  if (
    input.lastModified !== undefined &&
    !isoDateTime(input.lastModified)
  ) {
    throw new TypeError(`${where}.lastModified must be an ISO 8601 date-time with an offset`);
  }
}

function commonContent(input: Record<string, unknown>, where: string): void {
  if (input.annotations !== undefined) annotations(input.annotations, `${where}.annotations`);
  if (input._meta !== undefined) metadata(input._meta, `${where}._meta`);
}

function icon(value: unknown, where: string): void {
  const input = record(value, where);
  knownFields(input, ["src", "mimeType", "sizes", "theme"], where);
  uri(input.src, `${where}.src`);
  if (input.mimeType !== undefined) string(input.mimeType, `${where}.mimeType`);
  if (input.sizes !== undefined) {
    if (
      !Array.isArray(input.sizes) ||
      input.sizes.some((size) => typeof size !== "string" || !ICON_SIZE.test(size))
    ) {
      throw new TypeError(`${where}.sizes must contain pixel sizes or "any"`);
    }
  }
  if (input.theme !== undefined && input.theme !== "light" && input.theme !== "dark") {
    throw new TypeError(`${where}.theme must be light or dark`);
  }
}

function resourceContents(value: unknown, where: string): void {
  const input = record(value, where);
  knownFields(input, ["uri", "mimeType", "text", "blob", "_meta"], where);
  uri(input.uri, `${where}.uri`);
  if (input.mimeType !== undefined) string(input.mimeType, `${where}.mimeType`);
  if (input._meta !== undefined) metadata(input._meta, `${where}._meta`);
  const hasText = Object.hasOwn(input, "text");
  const hasBlob = Object.hasOwn(input, "blob");
  if (hasText === hasBlob) throw new TypeError(`${where} must contain exactly one of text or blob`);
  if (hasText && typeof input.text !== "string") {
    throw new TypeError(`${where}.text must be a string`);
  }
  if (hasBlob) base64(input.blob, `${where}.blob`);
}

function contentBlock(value: unknown, index: number): void {
  const where = `MCP tool result content[${index}]`;
  const input = record(value, where);
  switch (input.type) {
    case "text":
      knownFields(input, ["type", "text", "annotations", "_meta"], where);
      if (typeof input.text !== "string") throw new TypeError(`${where}.text must be a string`);
      commonContent(input, where);
      return;
    case "image":
    case "audio":
      knownFields(input, ["type", "data", "mimeType", "annotations", "_meta"], where);
      base64(input.data, `${where}.data`);
      string(input.mimeType, `${where}.mimeType`);
      commonContent(input, where);
      return;
    case "resource":
      knownFields(input, ["type", "resource", "annotations", "_meta"], where);
      resourceContents(input.resource, `${where}.resource`);
      commonContent(input, where);
      return;
    case "resource_link":
      knownFields(
        input,
        [
          "type",
          "uri",
          "name",
          "title",
          "description",
          "mimeType",
          "size",
          "icons",
          "annotations",
          "_meta",
        ],
        where,
      );
      uri(input.uri, `${where}.uri`);
      string(input.name, `${where}.name`);
      for (const field of ["title", "description", "mimeType"] as const) {
        if (input[field] !== undefined) string(input[field], `${where}.${field}`);
      }
      if (
        input.size !== undefined &&
        (!Number.isSafeInteger(input.size) || (input.size as number) < 0)
      ) {
        throw new TypeError(`${where}.size must be a non-negative safe integer`);
      }
      if (input.icons !== undefined) {
        if (!Array.isArray(input.icons)) throw new TypeError(`${where}.icons must be an array`);
        input.icons.forEach((value, iconIndex) => icon(value, `${where}.icons[${iconIndex}]`));
      }
      commonContent(input, where);
      return;
    default:
      throw new TypeError(`${where}.type is not a supported MCP content type`);
  }
}

export function validateMcpContentResult(value: unknown): McpToolResult {
  const result = record(value, "MCP tool result");
  knownFields(result, ["content", "isError", "_meta"], "MCP tool result");
  if (!Array.isArray(result.content)) {
    throw new TypeError("MCP tool result content must be an array");
  }
  result.content.forEach(contentBlock);
  if (result.isError !== undefined && typeof result.isError !== "boolean") {
    throw new TypeError("MCP tool result isError must be a boolean");
  }
  if (result._meta !== undefined) metadata(result._meta, "MCP tool result._meta");
  return value as McpToolResult;
}
