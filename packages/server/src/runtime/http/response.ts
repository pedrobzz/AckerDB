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
import { utf8ByteLength } from "../../shared/bytes.ts";

export type HttpValueOperation = "query" | "mutation" | "procedure";

export type EncodedHttpBody = Pick<RuntimeHttpResponse, "body" | "bytes">;

export interface CommittedHttpMutation {
  readonly receipt: HttpMutationReceipt;
  /** The success body, proven encodable before COMMIT so the write could roll back. */
  readonly encoded?: EncodedHttpBody;
}

/** Owns bounded HTTP encoding and the one responder handoff. */
export class RuntimeHttpResponses {
  constructor(private readonly maxFrameBytes: number) {}

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
      failure = outcomeFromError(error);
      status = outcomeHttpStatus(failure);
      encoded = this.encodeBody(failure, identityJson, operation, failure);
    }

    return this.handoff(request, Object.freeze({
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
    let bytes: number | undefined;
    try {
      const body = standardJsonText(toJson(value));
      bytes = utf8ByteLength(body);
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
      return encoded;
    } catch (cause) {
      const error = isAckerDBError(cause)
        ? cause
        : new AckerDBError(
            "validation",
            `${operation} result is not wire-representable`,
            { cause },
          );
      throw error;
    }
  }

  private fitOutcome(
    failure: Outcome,
    operation: HttpValueOperation,
  ): EncodedHttpBody {
    const fitted = fitOutcome(failure, this.maxFrameBytes, (outcome) => {
      const value = standardJsonText(outcome);
      return { value, bytes: utf8ByteLength(value) };
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
    response: RuntimeHttpResponse,
  ): Response {
    try {
      const delivered = request.respond(response);
      if (!(delivered instanceof Response)) {
        throw new TypeError("HTTP responder must return a Response");
      }
      return delivered;
    } catch (cause) {
      const error = new AckerDBError(
        "internal",
        "HTTP response handoff failed",
        { cause },
      );
      throw error;
    }
  }
}

/** An Outcome crosses no contract: it is already the standard JSON it publishes. */
function identityJson(value: unknown): unknown {
  return value;
}
