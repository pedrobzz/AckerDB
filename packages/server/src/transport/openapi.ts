/**
 * The OpenAPI 3.1 document for an application's HTTP surface: one operation per
 * exposed function whose `openapi` is not disabled, and nothing else. A function
 * hidden from the document stays callable, a function that is not exposed
 * appears nowhere, and nothing here is ever on by default — the CLI export and
 * the opt-in runtime endpoint are its only consumers.
 *
 * Every schema comes from `validation/json-schema.ts`, the one contract → JSON
 * Schema emission, and every method and header name from `http-surface.ts`, the
 * one description of what the listener serves. The document is therefore a pure
 * function of the registry: two exports of one application are byte-identical.
 */
import {
  DURABILITY_POLICIES,
  OUTCOME_CODES,
  PROTOCOL_VERSION,
  RESOURCE_CLASSES,
  type SseChunkMessage,
  type SseDoneMessage,
  type SseErrorMessage,
  type SseMessage,
} from "@ackerdb/core";
import type { AnyRegisteredSse, ErrorDeclaration } from "../app/functions.ts";
import type { ExposedFunction, Registry } from "../app/registry.ts";
import {
  DECIMAL_PATTERN,
  argsJsonSchema,
  validatorJsonSchema,
} from "../validation/json-schema.ts";
import type { StandardValidator } from "../validation/validator.ts";
import {
  ACKERDB_HTTP_ROUTES,
  EXPOSED_HTTP_METHODS,
  IDEMPOTENCY_KEY_HEADER,
  RECEIPT_HEADERS,
  SSE_FRAME_TYPES,
  SSE_STREAM_HEADERS,
} from "./http-surface.ts";

const OPENAPI_VERSION = "3.1.1";
const BEARER_SCHEME = "bearerAuth";
const JSON_MEDIA_TYPE = "application/json";
const EVENT_STREAM_MEDIA_TYPE = "text/event-stream";
const utf8 = new TextEncoder();

type JsonObject = Record<string, unknown>;

/**
 * The document's identity. AckerDB has no name for an application, so the
 * exporter supplies one; the version is the application's own, because this
 * document describes that application's API rather than AckerDB's.
 */
export interface OpenApiInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
}

export interface OpenApiDocument extends JsonObject {
  readonly openapi: typeof OPENAPI_VERSION;
  readonly info: OpenApiInfo;
  readonly paths: Readonly<Record<string, Readonly<Record<string, JsonObject>>>>;
}

/**
 * An embedded schema speaks the document's dialect, so the standalone `$schema`
 * declaration each emission carries is dropped exactly here.
 */
function embedded(schema: Record<string, unknown>): JsonObject {
  const { $schema: _dialect, ...rest } = schema;
  return rest;
}

/**
 * Name the function a schema failure came from: a validator kind no JSON
 * boundary can carry reports itself as `$`, which is unactionable in an app
 * with hundreds of functions.
 */
function describing<T>(address: string, what: string, emit: () => T): T {
  try {
    return emit();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new TypeError(
      `function "${address}" ${what} cannot be documented: ${detail}`,
      { cause },
    );
  }
}

const IDEMPOTENCY_KEY_PARAMETER: JsonObject = Object.freeze({
  name: IDEMPOTENCY_KEY_HEADER,
  in: "header",
  required: false,
  description:
    "Optional replay key. Absent, the mutation executes with no replay protection like any REST POST. Present, the same key with the same function and args replays the stored result, and a different function or args is a conflict.",
  schema: { type: "string", format: "uuid" },
});

const RECEIPT_RESPONSE_HEADERS: JsonObject = Object.freeze({
  [RECEIPT_HEADERS.commitVersion]: {
    description: "The version the mutation committed at, as a decimal string.",
    schema: { type: "string", pattern: DECIMAL_PATTERN },
  },
  [RECEIPT_HEADERS.durability]: {
    description: "The durability the commit had reached at response time.",
    schema: { type: "string", enum: [...DURABILITY_POLICIES] },
  },
  [RECEIPT_HEADERS.replay]: {
    description: "`true` when an Idempotency-Key replayed a stored result instead of executing.",
    schema: { type: "string", enum: ["true", "false"] },
  },
  [RECEIPT_HEADERS.obligations]: {
    description:
      "Comma-joined convergence obligations. Always empty on this surface — an HTTP caller holds no subscriptions — and the empty list omits the header, so the absent header is the empty list.",
    schema: { type: "string" },
  },
});

const SSE_RESPONSE_HEADERS: JsonObject = Object.freeze({
  [SSE_STREAM_HEADERS.stream]: {
    description: `The stream id. Acknowledge received chunks at POST ${ACKERDB_HTTP_ROUTES.sseAck} with it.`,
    schema: { type: "string" },
  },
  [SSE_STREAM_HEADERS.maxStallMs]: {
    description: "Milliseconds the stream may wait for the receiver's acknowledgement.",
    schema: { type: "string" },
  },
});

const OUTCOME_SCHEMA: JsonObject = Object.freeze({
  type: "object",
  description: "A transport, admission, or protocol failure, in AckerDB's vocabulary.",
  properties: {
    code: { type: "string", enum: [...OUTCOME_CODES] },
    retryable: { type: "boolean" },
    message: { type: "string" },
    retryAfterMs: { type: "integer", minimum: 0 },
    resource: { type: "string", enum: [...RESOURCE_CLASSES] },
    committed: {
      const: true,
      description: "Present only when convergence failed after a mutation committed.",
    },
  },
  required: ["code", "retryable", "message"],
  additionalProperties: false,
});

const OUTCOME_REFERENCE: JsonObject = Object.freeze({ $ref: "#/components/schemas/Outcome" });

const OUTCOME_RESPONSE: JsonObject = Object.freeze({
  description: "An infrastructure or protocol outcome, answered at the status it maps to.",
  content: { [JSON_MEDIA_TYPE]: { schema: OUTCOME_REFERENCE } },
});

/**
 * One SSE frame envelope. An event's `data` is a whole frame — the `yields`
 * chunk is a chunk frame's `value` alone — so a receiver that decoded the chunk
 * schema directly would misparse every event and never acknowledge one. The
 * payload field is typed against the frame `@ackerdb/core` parses, so a renamed
 * or dropped field fails this build rather than a generated client.
 */
function sseFrameSchema<F extends SseMessage>(
  tag: F["t"],
  description: string,
  payload: Readonly<Record<Exclude<keyof F, keyof SseDoneMessage>, JsonObject>>,
): JsonObject {
  const properties: JsonObject = {
    v: { const: PROTOCOL_VERSION },
    t: { const: tag },
    seq: { type: "integer", minimum: 1, description: "The frame's place in the stream, from 1." },
    proof: {
      type: "string",
      description: "The frame's credit token; its acknowledgement echoes it back.",
    },
    ...payload,
  };
  return {
    type: "object",
    title: tag,
    description,
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/** The body of an event stream: every frame the surface writes, and nothing else. */
function sseStreamSchema(chunk: JsonObject): JsonObject {
  return {
    oneOf: [
      sseFrameSchema<SseChunkMessage>(SSE_FRAME_TYPES.chunk, "One `yields` chunk.", {
        value: chunk,
      }),
      sseFrameSchema<SseDoneMessage>(
        SSE_FRAME_TYPES.done,
        "The stream ended normally; no frame follows.",
        {},
      ),
      sseFrameSchema<SseErrorMessage>(
        SSE_FRAME_TYPES.error,
        "The stream ended in a failure; no frame follows.",
        { outcome: OUTCOME_REFERENCE },
      ),
    ],
  };
}

/**
 * Acknowledgement is the contract, not an optimization: the producer holds the
 * next frame until the receiver credits the last one, so a client that ignores
 * this reads exactly one event and then stalls out.
 */
const SSE_STREAM_DESCRIPTION = [
  "The stream. Every event's `data` is one whole frame below, never a bare chunk.",
  "It is credited one frame at a time: for each frame the receiver must POST",
  `\`{"v":${PROTOCOL_VERSION},"t":"${SSE_FRAME_TYPES.ack}","stream":"<${SSE_STREAM_HEADERS.stream}>","seq":<seq>,"proof":"<proof>"}\``,
  `to ${ACKERDB_HTTP_ROUTES.sseAck} — acknowledging a \`seq\` acknowledges every frame through it —`,
  `or the producer writes nothing further and the stream fails after \`${SSE_STREAM_HEADERS.maxStallMs}\`.`,
].join(" ");

/**
 * POST is the form every kind answers, so it owns the address; a kind's other
 * methods suffix theirs, because two operations cannot share an operationId.
 */
function operationId(address: string, method: string): string {
  return method === "POST" ? address : `${address}.${method.toLowerCase()}`;
}

/**
 * The tag an operation carries: its address's top-level module, which is the
 * segment after the group. Tagging by the group instead would put every
 * operation of a single-group application under one tag, which is no grouping
 * at all — the module is what the document has always sorted operations by.
 */
function topLevelModule(address: string): string {
  const afterGroup = address.indexOf(".") + 1;
  return address.slice(afterGroup, address.indexOf(".", afterGroup));
}

function applicationErrorSchema(
  address: string,
  code: string,
  declaration: ErrorDeclaration,
): JsonObject {
  return {
    type: "object",
    title: code,
    properties: {
      kind: { const: "application" },
      code: { const: code },
      status: { const: declaration.status },
      // Declarations type their validators as the erased `Validator` face;
      // registration already refuses anything `v` did not build.
      body: embedded(describing(address, `errors.${code}.body`, () =>
        validatorJsonSchema(declaration.body as StandardValidator, { mode: "output" }))),
    },
    required: ["kind", "code", "status", "body"],
    additionalProperties: false,
  };
}

/** Declared errors, one response per declared status; a shared status is a union. */
function applicationErrorResponses(
  exposed: ExposedFunction,
  receipt: JsonObject,
): readonly (readonly [string, JsonObject])[] {
  const byStatus = new Map<number, { codes: string[]; schemas: JsonObject[] }>();
  for (
    const [code, declaration] of Object.entries(exposed.fn.errors ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
  ) {
    let entry = byStatus.get(declaration.status);
    if (entry === undefined) byStatus.set(declaration.status, (entry = { codes: [], schemas: [] }));
    entry.codes.push(code);
    entry.schemas.push(applicationErrorSchema(exposed.address, code, declaration));
  }
  return [...byStatus.entries()]
    .sort(([a], [b]) => a - b)
    .map(([status, { codes, schemas }]) => [
      String(status),
      {
        description: `Application error: ${codes.join(", ")}.`,
        ...receipt,
        content: {
          [JSON_MEDIA_TYPE]: {
            schema: schemas.length === 1 ? schemas[0]! : { oneOf: schemas },
          },
        },
      },
    ] as const);
}

function successResponse(exposed: ExposedFunction, receipt: JsonObject): JsonObject {
  if (exposed.kind === "sse") {
    const { yields } = exposed.fn as AnyRegisteredSse;
    return {
      description: SSE_STREAM_DESCRIPTION,
      headers: SSE_RESPONSE_HEADERS,
      content: {
        [EVENT_STREAM_MEDIA_TYPE]: {
          schema: sseStreamSchema(embedded(describing(exposed.address, "yields", () =>
            validatorJsonSchema(yields as StandardValidator, { mode: "output" })))),
        },
      },
    };
  }
  const returns = exposed.fn.returns;
  // A function without a `returns` validator is documented as an untyped value
  // and flagged as one. Hiding the operation would misreport the surface.
  if (returns === undefined) {
    return {
      description:
        "The return value. Untyped: this function declares no `returns` validator, so its body is undescribed.",
      "x-ackerdb-untyped": true,
      ...receipt,
      content: { [JSON_MEDIA_TYPE]: { schema: {} } },
    };
  }
  return {
    description: "The return value.",
    ...receipt,
    content: {
      [JSON_MEDIA_TYPE]: {
        schema: embedded(describing(exposed.address, "returns", () =>
          validatorJsonSchema(returns as StandardValidator, { mode: "output" }))),
      },
    },
  };
}

function responses(exposed: ExposedFunction): JsonObject {
  // A committed mutation answers with its receipt even when the application
  // rejected the call, exactly as the served surface does.
  const receipt = exposed.kind === "mutation" ? { headers: RECEIPT_RESPONSE_HEADERS } : {};
  const documented: JsonObject = { "200": successResponse(exposed, receipt) };
  for (const [status, response] of applicationErrorResponses(exposed, receipt)) {
    documented[status] = response;
  }
  documented["default"] = OUTCOME_RESPONSE;
  return documented;
}

function operation(
  exposed: ExposedFunction,
  method: string,
  id: string,
  args: JsonObject,
  argsRequired: boolean,
): JsonObject {
  const { fn, address } = exposed;
  return {
    operationId: id,
    tags: [topLevelModule(address)],
    ...(fn.title === undefined ? {} : { summary: fn.title }),
    ...(fn.description === undefined ? {} : { description: fn.description }),
    ...(method === "GET"
      ? {
          parameters: [{
            name: "args",
            in: "query",
            required: argsRequired,
            description:
              "The whole args object as url-encoded JSON. Omitted or empty means `{}`; per-field parameters are deliberately unsupported.",
            content: { [JSON_MEDIA_TYPE]: { schema: args } },
          }],
        }
      : {
          ...(exposed.kind === "mutation" ? { parameters: [IDEMPOTENCY_KEY_PARAMETER] } : {}),
          requestBody: {
            required: argsRequired,
            content: { [JSON_MEDIA_TYPE]: { schema: args } },
          },
        }),
    responses: responses(exposed),
  };
}

function pathItem(
  exposed: ExposedFunction,
  /** Every operationId already claimed, mapped to the address that claimed it. */
  claimed: Map<string, string>,
): Record<string, JsonObject> {
  const args = embedded(describing(exposed.address, "args", () =>
    argsJsonSchema(exposed.fn.args)));
  const required = Array.isArray(args["required"]) && args["required"].length > 0;
  const item: Record<string, JsonObject> = {};
  for (const method of EXPOSED_HTTP_METHODS[exposed.kind]) {
    // Distinct paths can still name one operation — a query at "notes.list" and
    // a function at "notes.list.get" both own "notes.list.get" — and the walk
    // refuses to emit a document codegen would reject or silently dedupe.
    const id = operationId(exposed.address, method);
    const owner = claimed.get(id);
    if (owner !== undefined) {
      throw new TypeError(
        `functions "${owner}" and "${exposed.address}" both document operationId "${id}"; rename one address`,
      );
    }
    claimed.set(id, exposed.address);
    item[method.toLowerCase()] = operation(exposed, method, id, args, required);
  }
  return item;
}

/** Walk the registry: one operation per exposed, documented function, in path order. */
export function openApiDocument(registry: Registry, info: OpenApiInfo): OpenApiDocument {
  const paths: Record<string, Record<string, JsonObject>> = {};
  const tags = new Set<string>();
  const claimed = new Map<string, string>();
  for (
    const exposed of [...registry.exposed.values()].sort((a, b) => a.path.localeCompare(b.path))
  ) {
    if (!exposed.openapi) continue;
    paths[exposed.path] = pathItem(exposed, claimed);
    tags.add(topLevelModule(exposed.address));
  }
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: info.title,
      version: info.version,
      ...(info.description === undefined ? {} : { description: info.description }),
    },
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        [BEARER_SCHEME]: {
          type: "http",
          scheme: "bearer",
          description:
            "The credential the verifier resolves into an auth lease. Anonymous callers are admitted wherever a function's policy allows one.",
        },
      },
      schemas: { Outcome: OUTCOME_SCHEMA },
    },
    // Bearer authentication is accepted everywhere and required by the
    // function's own access policy, never by the transport.
    security: [{}, { [BEARER_SCHEME]: [] }],
  };
}

/**
 * The one encoding this document is ever published in: the CLI export writes
 * exactly these bytes and the runtime endpoint serves exactly these bytes, so a
 * served document is byte-identical to an exported one. It is indented because
 * an exported file lives in diffs, and newline-terminated because it is a file.
 */
export function openApiBytes(document: OpenApiDocument): Uint8Array<ArrayBuffer> {
  // `TextEncoder` is declared over `ArrayBufferLike` because a caller may supply
  // the target buffer; the bytes it allocates itself are always `ArrayBuffer`
  // backed, which is what a response body requires under DOM-typed consumers.
  return utf8.encode(`${JSON.stringify(document, null, 2)}\n`) as Uint8Array<ArrayBuffer>;
}
