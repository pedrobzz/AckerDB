import { describe, expect, test } from "bun:test";
import { ProtocolError, decode, encode, parseOutcome } from "@ackerdb/core";
import { AdmissionRejected } from "../../src/runtime/admission.ts";
import { ValidationError } from "../../src/validation/v.ts";
import { AckerDBError } from "../../src/shared/errors.ts";
import {
  fitOutcome,
  outcomeFromError,
  outcomeHttpStatus,
  outcomeWebSocketClose,
} from "../../src/runtime/outcome.ts";

describe("structured transport outcomes", () => {
  test("preserves stable typed details and hides unexpected exceptions", () => {
    expect(
      outcomeFromError(
        new AckerDBError("overloaded", "writer full", {
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
    expect(outcomeFromError(new AckerDBError("unavailable", ""))).toEqual({
      code: "unavailable",
      retryable: false,
      message: "err",
    });
    expect(outcomeFromError(new ProtocolError("malformed", ""))).toEqual({
      code: "malformed",
      retryable: false,
      message: "err",
    });
    expect(outcomeFromError(new ValidationError(""))).toEqual({
      code: "validation",
      retryable: false,
      message: "err",
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

  test("bounds long emoji messages without splitting a public parser code point", () => {
    const outcome = outcomeFromError(new AckerDBError("unavailable", "💥".repeat(300)));
    expect(outcome.message.length).toBeLessThanOrEqual(512);
    expect(outcome.message).not.toContain("�");
    expect([...outcome.message].some((character) => {
      const point = character.codePointAt(0)!;
      return point >= 0xd800 && point <= 0xdfff;
    })).toBe(false);
    expect(parseOutcome(decode(encode(outcome)))).toEqual(outcome);
  });

  test("fits an intrinsically nonempty public outcome", () => {
    const fitted = fitOutcome(
      { code: "unavailable", retryable: false, message: "" },
      Number.MAX_SAFE_INTEGER,
      (outcome) => {
        const value = encode(outcome);
        return { value, bytes: Buffer.byteLength(value) };
      },
    );
    expect(parseOutcome(decode(fitted!.value)).message).toBe("err");
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
