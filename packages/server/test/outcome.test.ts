import { describe, expect, test } from "bun:test";
import { ProtocolError } from "@dbzz/core";
import { AdmissionRejected } from "../src/admission.ts";
import { ValidationError } from "../src/dbz.ts";
import { DbzzError } from "../src/errors.ts";
import {
  outcomeFromError,
  outcomeHttpStatus,
  outcomeWebSocketClose,
} from "../src/outcome.ts";

describe("structured transport outcomes", () => {
  test("preserves stable typed details and hides unexpected exceptions", () => {
    expect(
      outcomeFromError(
        new DbzzError("overloaded", "writer full", {
          retryable: true,
          retryAfterMs: 7,
          resource: "writer",
        }),
      ),
    ).toEqual({
      code: "overloaded",
      retryable: true,
      retryAfterMs: 7,
      resource: "writer",
      message: "writer full",
    });
    expect(outcomeFromError(new Error("secret payload"))).toEqual({
      code: "internal",
      retryable: false,
      message: "internal server error",
    });
  });

  test("maps protocol, validation, and admission failures exactly", () => {
    expect(outcomeFromError(new ProtocolError("unsupported_protocol", "version"))).toMatchObject({
      code: "unsupported_protocol",
    });
    expect(outcomeFromError(new ValidationError("args.id: expected bigint"))).toMatchObject({
      code: "validation",
    });
    expect(outcomeFromError(new AdmissionRejected("items", "reader", 12))).toEqual({
      code: "overloaded",
      retryable: true,
      retryAfterMs: 12,
      resource: "reader",
      message: "Admission rejected: items",
    });
  });

  test("uses the fixed HTTP and WebSocket mappings", () => {
    expect(outcomeHttpStatus({ code: "unauthenticated", retryable: false, message: "auth" })).toBe(401);
    expect(outcomeHttpStatus({ code: "unauthorized", retryable: false, message: "policy" })).toBe(403);
    expect(
      outcomeHttpStatus({
        code: "overloaded",
        retryable: true,
        message: "publication",
        resource: "publication",
      }),
    ).toBe(503);
    expect(outcomeWebSocketClose({ code: "malformed", retryable: false, message: "frame" })).toBe(1002);
    expect(outcomeWebSocketClose({ code: "slow_consumer", retryable: false, message: "slow" })).toBe(1013);
    expect(outcomeWebSocketClose({ code: "unauthorized", retryable: false, message: "policy" })).toBe(1008);
  });
});
