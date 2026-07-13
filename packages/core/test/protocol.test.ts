import { describe, expect, test } from "bun:test";
import {
  MAX_PROTOCOL_ID,
  MAX_RETRY_AFTER_MS,
  PROTOCOL_VERSION,
  ProtocolError,
  decode,
  encode,
  parseCallRequest,
  parseCallResponse,
  parseClientMessage,
  parseCredential,
  parseMutationReceipt,
  parseOutcome,
  parseServerMessage,
  parseSubscriptionTransition,
  uuidV7Timestamp,
  type SubscriptionCursor,
  type TransitionMessage,
} from "@dbzz/core";

const mutationRequestId = "01890a5d-ac96-774b-b4c0-123456789abc";
const cursor = (commitVersion: bigint): SubscriptionCursor => ({
  generation: "generation-1",
  commitVersion,
  authEpoch: 3,
  identity: "query-fingerprint",
});

function expectProtocolError(run: () => unknown, code: ProtocolError["code"]): void {
  try {
    run();
    throw new Error("expected a ProtocolError");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(code);
  }
}

describe("protocol 2 envelopes", () => {
  test("requires an explicit versioned hello and bounded credential", () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(
      parseClientMessage({
        v: 2,
        t: "hello",
        clientSessionId: "client-1",
        credential: { kind: "anonymous" },
      }),
    ).toEqual({
      v: 2,
      t: "hello",
      clientSessionId: "client-1",
      credential: { kind: "anonymous" },
    });
    expect(parseCredential({ kind: "bearer", token: "header.payload.signature" })).toEqual({
      kind: "bearer",
      token: "header.payload.signature",
    });
    expectProtocolError(
      () => parseCredential({ kind: "bearer", token: "x".repeat(16 * 1024 + 1) }),
      "malformed",
    );
  });

  test("rejects old versions, unknown frame types, unknown fields, and unbounded IDs", () => {
    expectProtocolError(() => parseClientMessage({ v: 1, t: "ping" }), "unsupported_protocol");
    expectProtocolError(() => parseClientMessage({ v: 2, t: "wat" }), "malformed");
    expectProtocolError(() => parseClientMessage({ v: 2, t: "ping", legacy: true }), "malformed");
    expectProtocolError(
      () => parseClientMessage({ v: 2, t: "q", id: MAX_PROTOCOL_ID + 1, ref: "a.b", args: null }),
      "malformed",
    );
  });

  test("parses auth, subscribe, reset, query, mutation, and HTTP call frames", () => {
    expect(uuidV7Timestamp(mutationRequestId)).toBe(1_688_096_058_518);
    expectProtocolError(
      () => uuidV7Timestamp("01890a5d-ac96-474b-b4c0-123456789abc"),
      "malformed",
    );
    expect(
      parseClientMessage({
        v: 2,
        t: "auth",
        attemptId: 2,
        credential: { kind: "bearer", token: "token" },
      }).t,
    ).toBe("auth");
    expect(
      parseClientMessage({ v: 2, t: "sub", id: 1, ref: "messages.list", args: {}, cursor: cursor(2n) }).t,
    ).toBe("sub");
    expect(parseClientMessage({ v: 2, t: "reset", id: 1, cursor: cursor(2n) }).t).toBe("reset");
    expect(parseClientMessage({ v: 2, t: "q", id: 2, ref: "messages.list", args: {} }).t).toBe("q");
    expect(
      parseClientMessage({
        v: 2,
        t: "m",
        id: 3,
        ref: "messages.send",
        args: { body: "hello" },
        mutationRequestId,
        issuedAt: 1_688_000_000_000,
      }).t,
    ).toBe("m");
    expect(parseCallRequest({ v: 2, t: "call", id: 4, ref: "reports.create", args: {} }).t).toBe("call");
  });
});

describe("structured outcomes", () => {
  test("validates stable outcomes, resources, and bounded retry guidance", () => {
    expect(
      parseOutcome({
        code: "overloaded",
        retryable: true,
        retryAfterMs: MAX_RETRY_AFTER_MS,
        resource: "writer",
        message: "writer capacity is full",
      }),
    ).toEqual({
      code: "overloaded",
      retryable: true,
      retryAfterMs: MAX_RETRY_AFTER_MS,
      resource: "writer",
      message: "writer capacity is full",
    });
    expect(
      parseOutcome({
        code: "convergence_unavailable",
        retryable: false,
        committed: true,
        message: "committed state could not converge",
      }).committed,
    ).toBe(true);
  });

  test("rejects unknown vocabulary and retry/commit ambiguity", () => {
    expectProtocolError(
      () => parseOutcome({ code: "busy", retryable: true, message: "busy" }),
      "malformed",
    );
    expectProtocolError(
      () =>
        parseOutcome({
          code: "overloaded",
          retryable: false,
          retryAfterMs: 1,
          message: "full",
        }),
      "malformed",
    );
    expectProtocolError(
      () =>
        parseOutcome({
          code: "convergence_unavailable",
          retryable: true,
          committed: true,
          message: "wrong",
        }),
      "malformed",
    );
  });
});

describe("ordered subscription state", () => {
  test("accepts reset, update, checkpoint, resume, and authorization revocation", () => {
    expect(
      parseSubscriptionTransition({ kind: "reset", from: null, to: cursor(1n), value: ["initial"] }).kind,
    ).toBe("reset");
    expect(
      parseSubscriptionTransition({ kind: "update", from: cursor(1n), to: cursor(2n), value: ["next"] }).kind,
    ).toBe("update");
    expect(
      parseSubscriptionTransition({ kind: "checkpoint", from: cursor(2n), to: cursor(3n) }).kind,
    ).toBe("checkpoint");
    expect(
      parseSubscriptionTransition({ kind: "resume", from: cursor(3n), to: cursor(3n) }).kind,
    ).toBe("resume");
    expect(
      parseSubscriptionTransition({
        kind: "revoked",
        from: cursor(3n),
        to: { ...cursor(3n), generation: "generation-2", authEpoch: 4 },
        outcome: { code: "unauthorized", retryable: false, message: "access revoked" },
      }).kind,
    ).toBe("revoked");
  });

  test("rejects a regressing or cross-stream best-effort update", () => {
    expectProtocolError(
      () => parseSubscriptionTransition({ kind: "checkpoint", from: cursor(2n), to: cursor(2n) }),
      "malformed",
    );
    expectProtocolError(
      () =>
        parseSubscriptionTransition({
          kind: "resume",
          from: cursor(2n),
          to: cursor(3n),
        }),
      "malformed",
    );
    expectProtocolError(
      () =>
        parseSubscriptionTransition({
          kind: "update",
          from: cursor(1n),
          to: { ...cursor(2n), generation: "other" },
          value: [],
        }),
      "malformed",
    );
  });

  test("preserves opaque application payloads through wire decode and envelope validation", () => {
    const message: TransitionMessage = {
      v: 2,
      t: "transition",
      id: 8,
      transition: {
        kind: "reset",
        from: null,
        to: cursor(7n),
        value: { id: 9n, bytes: new Uint8Array([1, 2, 3]) },
      },
    };
    expect(parseServerMessage(decode(encode(message)))).toEqual(message);
  });
});

describe("live events and operation results", () => {
  test("validates session acceptance, auth rotation, and structured errors", () => {
    expect(
      parseServerMessage({
        v: 2,
        t: "welcome",
        clientSessionId: "client-1",
        authEpoch: 0,
        principal: "anonymous",
      }).t,
    ).toBe("welcome");
    expect(
      parseServerMessage({ v: 2, t: "auth", attemptId: 2, authEpoch: 1, principal: "user" }).t,
    ).toBe("auth");
    expect(
      parseServerMessage({
        v: 2,
        t: "err",
        id: null,
        outcome: { code: "unauthenticated", retryable: false, message: "authentication required" },
      }).t,
    ).toBe("err");
  });

  test("models live-only rows, gaps, and resets", () => {
    const position = { generation: "process-1", commitVersion: 4n, sequence: 9n };
    for (const event of [
      { kind: "row", cursor: position, row: { id: 1n } },
      { kind: "gap", cursor: position },
      { kind: "reset", cursor: position },
    ]) {
      expect(parseServerMessage({ v: 2, t: "event", id: 4, event }).t).toBe("event");
    }
  });

  test("validates query and mutation ok variants and the exact receipt", () => {
    expect(parseServerMessage({ v: 2, t: "ok", id: 1, kind: "query", value: [1, 2] }).t).toBe("ok");
    const procedure = parseCallResponse({
      v: 2,
      t: "ok",
      id: 9,
      kind: "procedure",
      value: { accepted: true },
    });
    expect(procedure.t).toBe("ok");
    if (procedure.t !== "ok") throw new Error("expected a procedure result");
    expect(procedure.kind).toBe("procedure");
    const receipt = parseMutationReceipt({
      mutationRequestId,
      commitVersion: 12n,
      durability: "production",
      replay: "executed",
      obligations: [3, 5],
    });
    expect(
      parseServerMessage({
        v: 2,
        t: "ok",
        id: 2,
        kind: "mutation",
        value: { created: 1n },
        receipt,
      }),
    ).toEqual({ v: 2, t: "ok", id: 2, kind: "mutation", value: { created: 1n }, receipt });
  });

  test("rejects non-v7 mutation IDs, duplicate obligations, and unknown result variants", () => {
    expectProtocolError(
      () =>
        parseMutationReceipt({
          mutationRequestId: "01890a5d-ac96-474b-b4c0-123456789abc",
          commitVersion: 1n,
          durability: "production",
          replay: "executed",
          obligations: [],
        }),
      "malformed",
    );
    expectProtocolError(
      () =>
        parseMutationReceipt({
          mutationRequestId,
          commitVersion: 1n,
          durability: "balanced",
          replay: "replayed",
          obligations: [1, 1],
        }),
      "malformed",
    );
    expectProtocolError(
      () => parseServerMessage({ v: 2, t: "ok", id: 1, kind: "legacy", value: null }),
      "malformed",
    );
  });
});
