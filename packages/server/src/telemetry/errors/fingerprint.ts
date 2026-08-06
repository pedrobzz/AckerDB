import { createHash } from "node:crypto";

/** Stored beside every hash; bumping it splits every existing group on purpose. */
export const ERROR_FINGERPRINT_ALGO_VERSION = 1;

export interface FingerprintedError {
  readonly hash: string;
  readonly algoVersion: number;
  readonly name: string;
  /** Parameterized message — volatile values replaced by placeholders. */
  readonly message: string;
  /** Sanitized sample stack: relative paths, bounded frames, cause chain. */
  readonly stack: string;
}

const MAX_NAME_LENGTH = 128;
const MAX_MESSAGE_LENGTH = 512;
const MAX_FRAMES = 50;
const MAX_CAUSE_DEPTH = 5;
const MAX_CUSTOM_PARTS = 32;
const MAX_CUSTOM_PART_LENGTH = 512;
const DEFAULT_PLACEHOLDER = "{{ default }}";

interface StackFrame {
  readonly functionName: string;
  readonly path: string;
  readonly position: string;
}

/**
 * The ~8 parameterization regexes: volatile values collapse to placeholders
 * so "user 4211 not found" and "user 87 not found" share one group. Order
 * matters — uuid before hex before number, date before number.
 */
const MESSAGE_PARAMETERS: readonly (readonly [RegExp, string])[] = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>"],
  [/\bhttps?:\/\/[^\s"']+/gi, "<url>"],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "<email>"],
  [/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, "<date>"],
  [/\b[0-9a-f]{8,}\b/gi, "<hex>"],
  [/"[^"]*"/g, "<str>"],
  [/'[^']*'/g, "<str>"],
  [/\b\d+(?:\.\d+)?\b/g, "<num>"],
];

export function parameterizeErrorMessage(message: string): string {
  let parameterized = message.length > MAX_MESSAGE_LENGTH
    ? message.slice(0, MAX_MESSAGE_LENGTH)
    : message;
  for (const [pattern, placeholder] of MESSAGE_PARAMETERS) {
    parameterized = parameterized.replace(pattern, placeholder);
  }
  return parameterized;
}

const FRAME_WITH_LOCATION = /^\s*at\s+(?:async\s+)?(?:new\s+)?(.+?)\s+\((.*)\)\s*$/;
const FRAME_BARE = /^\s*at\s+(?:async\s+)?(.*?)\s*$/;
const POSITION = /:(\d+)(?::(\d+))?$/;

function parseFrame(line: string): StackFrame | undefined {
  const withLocation = FRAME_WITH_LOCATION.exec(line);
  const functionName = withLocation === null ? "" : withLocation[1]!;
  const location = withLocation === null ? FRAME_BARE.exec(line)?.[1] : withLocation[2];
  if (location === undefined || location.length === 0) return undefined;
  const position = POSITION.exec(location);
  return {
    functionName,
    path: position === null ? location : location.slice(0, position.index),
    position: position === null ? "" : position[0],
  };
}

function relativePath(path: string, root: string): string {
  const withoutScheme = path.startsWith("file://") ? path.slice("file://".length) : path;
  return withoutScheme.startsWith(`${root}/`)
    ? withoutScheme.slice(root.length + 1)
    : withoutScheme;
}

/**
 * In-app frames only: dependency, Bun/Node-internal, native, and framework
 * frames never define a group — an application error groups by where the
 * application's own code was, not by the library path it crossed.
 */
function isInApp(path: string): boolean {
  return !(
    path.includes("node_modules") ||
    path.startsWith("bun:") ||
    path.startsWith("node:") ||
    path === "native" ||
    path === "<anonymous>" ||
    path.includes("@ackerdb/")
  );
}

interface ParsedStack {
  readonly frames: readonly StackFrame[];
  readonly sample: readonly string[];
}

function parseStack(stack: string, root: string): ParsedStack {
  const frames: StackFrame[] = [];
  const sample: string[] = [];
  for (const line of stack.split("\n")) {
    if (frames.length >= MAX_FRAMES) break;
    const frame = parseFrame(line);
    if (frame === undefined) continue;
    const path = relativePath(frame.path, root);
    frames.push({ ...frame, path });
    sample.push(
      frame.functionName.length === 0
        ? `    at ${path}${frame.position}`
        : `    at ${frame.functionName} (${path}${frame.position})`,
    );
  }
  return { frames, sample };
}

function boundedName(error: unknown): string {
  const name = error instanceof Error && error.name.length > 0 ? error.name : "UnknownError";
  return name.length > MAX_NAME_LENGTH ? name.slice(0, MAX_NAME_LENGTH) : name;
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_MESSAGE_LENGTH ? message.slice(0, MAX_MESSAGE_LENGTH) : message;
}

function customFingerprint(error: unknown): readonly string[] | undefined {
  if (!(error instanceof Error)) return undefined;
  const declared = (error as { readonly fingerprint?: unknown }).fingerprint;
  if (!Array.isArray(declared) || declared.length === 0) return undefined;
  const parts: string[] = [];
  for (const part of declared.slice(0, MAX_CUSTOM_PARTS)) {
    if (typeof part !== "string") return undefined;
    parts.push(part.length > MAX_CUSTOM_PART_LENGTH ? part.slice(0, MAX_CUSTOM_PART_LENGTH) : part);
  }
  return parts;
}

/**
 * The #211 minimum subset: hash `error.name` + in-app (relative path,
 * function) frame pairs — never line/column numbers — with consecutive
 * recursion collapsed and `Error.cause` walked; fall back to name +
 * parameterized message when no in-app frame survives; honor a
 * `fingerprint: string[]` escape hatch where `{{ default }}` salts the
 * computed default instead of replacing it.
 */
export function fingerprintError(error: unknown, root = process.cwd()): FingerprintedError {
  const name = boundedName(error);
  const message = parameterizeErrorMessage(boundedMessage(error));

  const defaultParts: string[] = [];
  const sampleLines: string[] = [];
  let inAppFrames = 0;
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    if (depth > 0) {
      sampleLines.push(`Caused by: ${boundedName(current)}: ${boundedMessage(current)}`);
      defaultParts.push(`cause:${boundedName(current)}`);
    } else {
      sampleLines.push(`${name}: ${boundedMessage(current)}`);
      defaultParts.push(name);
    }
    const parsed = parseStack(current.stack ?? "", root);
    sampleLines.push(...parsed.sample);
    let previous: string | undefined;
    for (const frame of parsed.frames) {
      if (!isInApp(frame.path)) continue;
      const pair = `${frame.path}|${frame.functionName}`;
      // Consecutive identical frames are recursion; one level defines the group.
      if (pair === previous) continue;
      previous = pair;
      defaultParts.push(pair);
      inAppFrames++;
    }
    current = current.cause;
  }
  const computed = inAppFrames > 0 ? defaultParts : [name, message];

  const custom = customFingerprint(error);
  const parts = custom === undefined
    ? computed
    : custom.flatMap((part) => (part === DEFAULT_PLACEHOLDER ? computed : [part]));

  return Object.freeze({
    hash: createHash("sha256").update(parts.join("\n")).digest("hex"),
    algoVersion: ERROR_FINGERPRINT_ALGO_VERSION,
    name,
    message,
    stack: sampleLines.length === 0 ? `${name}: ${message}` : sampleLines.join("\n"),
  });
}
