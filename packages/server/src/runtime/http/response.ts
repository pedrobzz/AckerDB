import {
  isApplicationError,
  isResult,
  type ApplicationError,
  type Outcome,
} from "@ackerdb/core";
import { AckerDBError, isAckerDBError } from "../../shared/errors.ts";
import { standardJsonText } from "../../validation/standard-json.ts";
import type { ExposedHttpCodec } from "../../transport/http-codec.ts";
import { fitOutcome, outcomeFromError, outcomeHttpStatus } from "../outcome.ts";
import type {
  HttpMutationReceipt,
  RuntimeHttpRequest,
  RuntimeHttpResponse,
} from "../contracts/requests.ts";
import type { RuntimeOperationOutcome } from "../execution/operation-runner.ts";
import type { RuntimeTraceSpan } from "../telemetry/trace-bridge.ts";
import type { TelemetryOperation } from "../../telemetry/telemetry.ts";

const utf8 = new TextEncoder();

export type HttpValueOperation = Extract<
  TelemetryOperation,
  "query" | "mutation" | "procedure"
>;

export type EncodedHttpBody = Pick<RuntimeHttpResponse, "body" | "bytes">;

export interface CommittedHttpMutation {
  readonly receipt: HttpMutationReceipt;
  /** The success body, proven encodable before COMMIT so the write could roll back. */
  readonly encoded?: EncodedHttpBody;
}

export interface RuntimeHttpResponseTelemetry {
  readonly enabled: boolean;
  span(input: RuntimeTraceSpan, operation: HttpValueOperation): void;
  failure(
    error: unknown,
    operation: HttpValueOperation,
    stage: "encoding" | "delivery",
  ): void;
}

/** Owns bounded HTTP encoding and the one responder handoff. */
export class RuntimeHttpResponses {
  constructor(
    private readonly maxFrameBytes: number,
    private readonly telemetry: RuntimeHttpResponseTelemetry,
  ) {}

  /**
   * The HTTP body is the plain value the caller asked for: the return value,
   * the declared `ApplicationError`, or the failure outcome—never a protocol
   * frame. Framing belongs to the WebSocket session alone.
   */
  respond(
    request: RuntimeHttpRequest,
    codec: ExposedHttpCodec,
    operation: HttpValueOperation,
    outcome: RuntimeOperationOutcome<unknown>,
    committed?: CommittedHttpMutation,
  ): Response {
    let body: unknown;
    let toJson: (value: unknown) => unknown;
    let status: number;
    let failure: Outcome | null = null;
    let proven: EncodedHttpBody | undefined;
    if (outcome.ok) {
      if (!isResult(outcome.value)) {
        throw new AckerDBError(
          "internal",
          `${operation} boundary returned no Result`,
        );
      }
      if (outcome.value.ok) {
        body = outcome.value.data;
        toJson = codec.encodeValue;
        status = 200;
        proven = committed?.encoded;
      } else {
        if (!isApplicationError(outcome.value.error)) {
          throw new AckerDBError(
            "internal",
            "registered Err contains no application error",
          );
        }
        const error = outcome.value.error;
        body = error;
        toJson = (value) => codec.encodeError(value as ApplicationError);
        status = error.status;
      }
    } else {
      failure = outcomeFromError(outcome.error);
      body = failure;
      toJson = identityJson;
      status = outcomeHttpStatus(failure);
    }

    let encoded: EncodedHttpBody;
    try {
      encoded = proven ?? this.encodeBody(body, toJson, operation, failure);
    } catch (error) {
      if (failure !== null) throw error;
      this.telemetry.failure(error, operation, "encoding");
      failure = outcomeFromError(error);
      status = outcomeHttpStatus(failure);
      encoded = this.encodeBody(failure, identityJson, operation, failure);
    }

    return this.handoff(request, operation, Object.freeze({
      ...encoded,
      status,
      // A committed mutation answers with its receipt even when the application
      // rejected the call, exactly as `ApplicationErrorMessage.receipt` does.
      ...(committed === undefined ? {} : { receipt: committed.receipt }),
    }));
  }

  encodeBody(
    value: unknown,
    toJson: (value: unknown) => unknown,
    operation: HttpValueOperation,
    failure: Outcome | null,
  ): EncodedHttpBody {
    const startedAt = this.telemetry.enabled ? performance.now() : 0;
    let bytes: number | undefined;
    try {
      const body = standardJsonText(toJson(value));
      bytes = utf8.encode(body).byteLength;
      let encoded = { body, bytes };
      if (bytes > this.maxFrameBytes) {
        if (failure === null) {
          throw new AckerDBError(
            "overloaded",
            `${operation} result exceeds maxFrameBytes`,
            { resource: "operation" },
          );
        }
        encoded = this.fitOutcome(failure, operation);
        bytes = encoded.bytes;
      }
      if (this.telemetry.enabled) {
        this.telemetry.span({
          stage: "encoding",
          outcome: "ok",
          resource: "operation",
          durationMs: Math.max(0, performance.now() - startedAt),
          sizeBytes: bytes,
        }, operation);
      }
      return encoded;
    } catch (cause) {
      const error = isAckerDBError(cause)
        ? cause
        : new AckerDBError(
            "validation",
            `${operation} result is not wire-representable`,
            { cause },
          );
      if (this.telemetry.enabled) {
        this.telemetry.span({
          stage: "encoding",
          outcome: error.code,
          resource: "operation",
          durationMs: Math.max(0, performance.now() - startedAt),
          ...(bytes === undefined ? {} : { sizeBytes: bytes }),
        }, operation);
      }
      throw error;
    }
  }

  private fitOutcome(
    failure: Outcome,
    operation: HttpValueOperation,
  ): EncodedHttpBody {
    const fitted = fitOutcome(failure, this.maxFrameBytes, (outcome) => {
      const value = standardJsonText(outcome);
      return { value, bytes: utf8.encode(value).byteLength };
    });
    if (fitted === null) {
      throw new AckerDBError(
        "overloaded",
        `${operation} error response exceeds maxFrameBytes`,
        { resource: "operation" },
      );
    }
    return { body: fitted.value, bytes: fitted.bytes };
  }

  private handoff(
    request: RuntimeHttpRequest,
    operation: HttpValueOperation,
    response: RuntimeHttpResponse,
  ): Response {
    const startedAt = this.telemetry.enabled ? performance.now() : 0;
    try {
      const delivered = request.respond(response);
      if (!(delivered instanceof Response)) {
        throw new TypeError("HTTP responder must return a Response");
      }
      if (this.telemetry.enabled) {
        this.telemetry.span({
          stage: "delivery",
          outcome: "ok",
          resource: "operation",
          durationMs: Math.max(0, performance.now() - startedAt),
          sizeBytes: response.bytes,
        }, operation);
      }
      return delivered;
    } catch (cause) {
      const error = new AckerDBError(
        "internal",
        "HTTP response handoff failed",
        { cause },
      );
      if (this.telemetry.enabled) {
        this.telemetry.span({
          stage: "delivery",
          outcome: error.code,
          resource: "operation",
          durationMs: Math.max(0, performance.now() - startedAt),
          sizeBytes: response.bytes,
        }, operation);
      }
      this.telemetry.failure(error, operation, "delivery");
      throw error;
    }
  }
}

/** An Outcome crosses no contract: it is already the standard JSON it publishes. */
function identityJson(value: unknown): unknown {
  return value;
}
