import {
  Err,
  Failure,
  Ok,
  Status,
  type ApplicationError,
  type Result,
} from "../src/index.ts";

declare const payment: Result<
  { readonly receiptId: string },
  | ApplicationError<"stripe.card-declined", { readonly declineCode: string }, 402>
  | ApplicationError<"stripe.timeout", { readonly retryAfterMs: number }, 503>
>;

const mapped = payment.mapErr({
  "stripe.card-declined": (error) => {
    const declineCode: string = error.body.declineCode;
    return Err(
      "payment.failed",
      { declineCode },
      Status.PaymentRequired,
    );
  },
});

if (!mapped.ok) {
  if (mapped.error.code === "stripe.timeout") {
    const retryAfterMs: number = mapped.error.body.retryAfterMs;
    void retryAfterMs;
  } else {
    const declineCode: string = mapped.error.body.declineCode;
    void declineCode;
  }
}

payment.mapErr({
  // @ts-expect-error mapErr keys must be reachable from the source Result
  "stripe.unknown": () => Err("payment.failed", {}, Status.PaymentRequired),
});

payment.mapErr({
  // @ts-expect-error a mapper must return an application Err
  "stripe.timeout": () => Ok("not an error"),
});

payment.mapErr({
  // @ts-expect-error a mapper cannot turn a framework/client failure into an application error
  "stripe.timeout": () => Failure(new Error("transport failed")),
});
