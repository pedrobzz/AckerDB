import { ValidationError, type Validator } from "@dbzz/server";
import type { UIMessageChunk } from "ai";

/**
 * The fixture's `yields` validator for AI SDK v7 `UIMessageChunk` streams,
 * and why it is a custom `Validator` rather than a `v` composition:
 *
 * - `v.object` validates exact keys, but every chunk variant carries
 *   optional fields (`providerMetadata`, `title`, ...), so a per-variant
 *   shape model rejects real AI SDK chunks.
 * - `v.union` expects dbzz's `{ tag, value }` wire form, not the AI SDK's
 *   `type`-discriminated objects.
 * - The AI SDK's own `uiMessageChunkSchema` validates asynchronously, while
 *   dbzz's boundary check is synchronous by design (it sits in the stream's
 *   pull path).
 *
 * The `Validator` interface is deliberately open, so the fixture checks the
 * v7 discriminant set exhaustively (plus the `data-*` family) and each
 * variant's required primitive fields, leaving fields the SDK itself types
 * as open (`providerMetadata`, `input`, `output`, `data`, metadata) alone.
 * Failures throw `ValidationError` so the runtime surfaces them as the
 * exact `validation` outcome clients observe.
 */
type RequiredFields = Readonly<Record<string, "string" | "boolean">>;

const CHUNK_REQUIRED: Readonly<Record<string, RequiredFields>> = {
  "text-start": { id: "string" },
  "text-delta": { id: "string", delta: "string" },
  "text-end": { id: "string" },
  "reasoning-start": { id: "string" },
  "reasoning-delta": { id: "string", delta: "string" },
  "reasoning-end": { id: "string" },
  custom: { kind: "string" },
  error: { errorText: "string" },
  "tool-input-start": { toolCallId: "string", toolName: "string" },
  "tool-input-delta": { toolCallId: "string", inputTextDelta: "string" },
  "tool-input-available": { toolCallId: "string", toolName: "string" },
  "tool-input-error": { toolCallId: "string", toolName: "string", errorText: "string" },
  "tool-approval-request": { approvalId: "string", toolCallId: "string" },
  "tool-approval-response": { approvalId: "string", approved: "boolean" },
  "tool-output-available": { toolCallId: "string" },
  "tool-output-error": { toolCallId: "string", errorText: "string" },
  "tool-output-denied": { toolCallId: "string" },
  "source-url": { sourceId: "string", url: "string" },
  "source-document": { sourceId: "string", mediaType: "string", title: "string" },
  file: { url: "string", mediaType: "string" },
  "reasoning-file": { url: "string", mediaType: "string" },
  "start-step": {},
  "finish-step": {},
  start: {},
  finish: {},
  abort: {},
  "message-metadata": {},
};

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function uiMessageChunk(): Validator<UIMessageChunk, "uiMessageChunk"> {
  return {
    kind: "uiMessageChunk",
    check(value, path) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new ValidationError(`${path}: expected UIMessageChunk object, got ${describe(value)}`);
      }
      const chunk = value as Record<string, unknown>;
      const type = chunk["type"];
      if (typeof type !== "string") {
        throw new ValidationError(`${path}.type: expected chunk type string, got ${describe(type)}`);
      }
      const required = type.startsWith("data-") ? {} : CHUNK_REQUIRED[type];
      if (required === undefined) {
        throw new ValidationError(
          `${path}.type: ${JSON.stringify(type)} is not an AI SDK v7 chunk type`,
        );
      }
      for (const [field, expected] of Object.entries(required)) {
        if (typeof chunk[field] !== expected) {
          throw new ValidationError(
            `${path}.${field}: expected ${expected}, got ${describe(chunk[field])}`,
          );
        }
      }
      return value as UIMessageChunk;
    },
    tsType: () => "UIMessageChunk",
    descriptor: () => ({ k: "uiMessageChunk" }),
  };
}
