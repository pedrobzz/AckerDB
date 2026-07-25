import { describe, expect, test } from "bun:test";
import {
  Err,
  Failure,
  Ok,
  Status,
  type ApplicationError,
  type Result,
} from "../src/index.ts";

describe("Result", () => {
  test("represents immutable success and application-error outcomes", () => {
    const success = Ok({ id: 1n });
    expect(success).toMatchObject({ ok: true, data: { id: 1n } });
    expect(Object.isFrozen(success)).toBe(true);

    const failure = Err("order-not-found", { orderId: "order-1" }, Status.NotFound);
    expect(failure).toMatchObject({
      ok: false,
      error: {
        kind: "application",
        code: "order-not-found",
        body: { orderId: "order-1" },
        status: 404,
      },
    });
    expect(Object.isFrozen(failure)).toBe(true);
    expect(Object.isFrozen(failure.error)).toBe(true);
  });

  test("maps selected errors and preserves unmatched Results", () => {
    const timeout: Result<
      never,
      | ApplicationError<"stripe.timeout", {}, 503>
      | ApplicationError<"stripe.card-declined", {}, 402>
    > = Err("stripe.timeout", {}, Status.ServiceUnavailable);
    const mapped = timeout.mapErr({
      "stripe.card-declined": () =>
        Err("payment-failed", { reason: "declined" }, Status.PaymentRequired),
    });
    expect(mapped === timeout).toBe(true);

    const declined = Err("stripe.card-declined", {}, Status.PaymentRequired);
    expect(declined.mapErr({
      "stripe.card-declined": () =>
        Err("payment-failed", { reason: "declined" }, Status.PaymentRequired),
    })).toMatchObject({
      ok: false,
      error: {
        code: "payment-failed",
        body: { reason: "declined" },
        status: 402,
      },
    });

    const success = Ok("paid");
    expect(success.mapErr({})).toBe(success);
  });

  test("treats prototype-named codes as ordinary own mapping keys", () => {
    const inherited = Err("toString", {}, Status.BadRequest);
    expect(inherited.mapErr({})).toBe(inherited);
    expect(
      inherited.mapErr({
        toString: () => Err("mapped", {}, Status.Conflict),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "mapped", status: 409 },
    });

    expect(() =>
      inherited.mapErr({
        toString: (() => Failure("not an application Err")) as never,
      }),
    ).toThrow("Result.mapErr callbacks must return Err(...)");
  });
});
