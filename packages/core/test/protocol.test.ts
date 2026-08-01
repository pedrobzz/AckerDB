import { describe, expect, test } from "bun:test";
import {
  MAX_PROTOCOL_ID,
  MAX_RETRY_AFTER_MS,
  PROTOCOL_VERSION,
  ProtocolError,
  decode,
  encode,
  parseClientMessage,
  parseCredential,
  parseMutationReceipt,
  parseOutcome,
  parseServerMessage,
  parseSseAckRequest,
  parseSseMessage,
  parseSubscriptionTransition,
  Status,
  uuidV7Timestamp,
  type AuthenticatedMessage,
  type Identity,
  type SubscriptionCursor,
  type TransitionMessage,
} from "@ackerdb/core";

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

describe("protocol 5 envelopes", () => {
  test("requires an explicit versioned hello and bounded credential", () => {
    expect(PROTOCOL_VERSION).toBe(5);
    expect(
      parseClientMessage({
        v: PROTOCOL_VERSION,
        t: "hello",
        clientSessionId: "client-1",
        credential: { kind: "anonymous" },
      }),
    ).toEqual({
      v: PROTOCOL_VERSION,
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

  test("parses exact channel join, leave, send, ready, event, and rejection frames", () => {
    expect(parseClientMessage({
      v: PROTOCOL_VERSION,
      t: "channel_join",
      id: 7,
      ref: "chat.room",
      args: { thread: 1n },
      room: "support",
    }).t).toBe("channel_join");
    expect(parseClientMessage({
      v: PROTOCOL_VERSION,
      t: "channel_leave",
      id: 7,
    }).t).toBe("channel_leave");
    expect(parseClientMessage({
      v: PROTOCOL_VERSION,
      t: "channel_send",
      id: 7,
      event: "message",
      payload: { body: "hello" },
    }).t).toBe("channel_send");
    expect(parseServerMessage({
      v: PROTOCOL_VERSION,
      t: "channel_ready",
      id: 7,
      authEpoch: 2,
    }).t).toBe("channel_ready");
    expect(parseServerMessage({
      v: PROTOCOL_VERSION,
      t: "channel_event",
      id: 7,
      event: "message",
      payload: { body: "hello" },
    }).t).toBe("channel_event");
    expect(parseServerMessage({
      v: PROTOCOL_VERSION,
      t: "channel_rejected",
      id: 7,
      authEpoch: 2,
      error: {
        kind: "application",
        code: "room.closed",
        body: { room: "support" },
        status: Status.Forbidden,
      },
    }).t).toBe("channel_rejected");

    for (const value of [
      { v: PROTOCOL_VERSION, t: "channel_join", id: 7, ref: "chat.room", args: {}, room: undefined },
      { v: PROTOCOL_VERSION, t: "channel_send", id: 7, event: "", payload: null },
      { v: PROTOCOL_VERSION, t: "channel_event", id: 7, event: "message" },
    ]) {
      expectProtocolError(
        () => value.t.startsWith("channel_") && value.t === "channel_event"
          ? parseServerMessage(value)
          : parseClientMessage(value),
        "malformed",
      );
    }
  });

  test("rejects old versions, unknown frame types, unknown fields, and unbounded IDs", () => {
    expectProtocolError(() => parseClientMessage({ v: 1, t: "ping" }), "unsupported_protocol");
    expectProtocolError(() => parseClientMessage({ v: PROTOCOL_VERSION, t: "wat" }), "malformed");
    expectProtocolError(() => parseClientMessage({ v: PROTOCOL_VERSION, t: "ping", legacy: true }), "malformed");
    expectProtocolError(
      () => parseClientMessage({ v: PROTOCOL_VERSION, t: "q", id: MAX_PROTOCOL_ID + 1, ref: "a.b", args: null }),
      "malformed",
    );
  });

  test("parses auth, subscribe, reset, query, procedure, cancel, mutation, and HTTP call frames", () => {
    expect(uuidV7Timestamp(mutationRequestId)).toBe(1_688_096_058_518);
    expectProtocolError(
      () => uuidV7Timestamp("01890a5d-ac96-474b-b4c0-123456789abc"),
      "malformed",
    );
    expect(
      parseClientMessage({
        v: PROTOCOL_VERSION,
        t: "auth",
        attemptId: 2,
        credential: { kind: "bearer", token: "token" },
      }).t,
    ).toBe("auth");
    expect(
      parseClientMessage({ v: PROTOCOL_VERSION, t: "sub", id: 1, ref: "messages.list", args: {}, cursor: cursor(2n) }).t,
    ).toBe("sub");
    expect(parseClientMessage({ v: PROTOCOL_VERSION, t: "reset", id: 1, cursor: cursor(2n) }).t).toBe("reset");
    expect(parseClientMessage({ v: PROTOCOL_VERSION, t: "q", id: 2, ref: "messages.list", args: {} }).t).toBe("q");
    expect(
      parseClientMessage({ v: PROTOCOL_VERSION, t: "p", id: 3, ref: "reports.create", args: {} }).t,
    ).toBe("p");
    expect(parseClientMessage({ v: PROTOCOL_VERSION, t: "cancel", id: 3 }).t).toBe("cancel");
    expect(
      parseClientMessage({
        v: PROTOCOL_VERSION,
        t: "m",
        id: 4,
        ref: "messages.send",
        args: { body: "hello" },
        mutationRequestId,
        issuedAt: 1_688_000_000_000,
      }).t,
    ).toBe("m");
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

describe("SSE receiver acknowledgments", () => {
  test("parses exact chunk, completion, error, and cumulative acknowledgment envelopes", () => {
    expect(parseSseMessage({
      v: PROTOCOL_VERSION,
      t: "sse_chunk",
      seq: 1,
      proof: "proof-1",
      value: { id: 1n },
    })).toEqual({ v: PROTOCOL_VERSION, t: "sse_chunk", seq: 1, proof: "proof-1", value: { id: 1n } });
    expect(parseSseMessage({ v: PROTOCOL_VERSION, t: "sse_done", seq: 2, proof: "proof-2" })).toEqual({
      v: PROTOCOL_VERSION,
      t: "sse_done",
      seq: 2,
      proof: "proof-2",
    });
    expect(parseSseMessage({
      v: PROTOCOL_VERSION,
      t: "sse_error",
      seq: 3,
      proof: "proof-3",
      outcome: { code: "slow_consumer", retryable: false, message: "stalled", resource: "sse" },
    }).t).toBe("sse_error");
    expect(parseSseAckRequest({
      v: PROTOCOL_VERSION,
      t: "sse_ack",
      stream: "stream-1",
      seq: 3,
      proof: "proof-3",
    })).toEqual({ v: PROTOCOL_VERSION, t: "sse_ack", stream: "stream-1", seq: 3, proof: "proof-3" });
  });

  test("rejects unknown fields, unsafe sequences, empty tokens, and the wrong envelope kind", () => {
    for (const value of [
      { v: PROTOCOL_VERSION, t: "sse_chunk", seq: 0, proof: "proof", value: null },
      { v: PROTOCOL_VERSION, t: "sse_done", seq: Number.MAX_SAFE_INTEGER + 1, proof: "proof" },
      { v: PROTOCOL_VERSION, t: "sse_done", seq: 1, proof: "" },
      { v: PROTOCOL_VERSION, t: "sse_done", seq: 1, proof: "proof", legacy: true },
      { v: PROTOCOL_VERSION, t: "sse_error", seq: 1, proof: "proof", outcome: { code: "wat" } },
    ]) {
      expectProtocolError(() => parseSseMessage(value), "malformed");
    }
    for (const value of [
      { v: PROTOCOL_VERSION, t: "call", stream: "stream", seq: 1, proof: "proof" },
      { v: PROTOCOL_VERSION, t: "sse_ack", stream: "", seq: 1, proof: "proof" },
      { v: PROTOCOL_VERSION, t: "sse_ack", stream: "stream", seq: -1, proof: "proof" },
      { v: PROTOCOL_VERSION, t: "sse_ack", stream: "stream", seq: 1, proof: "x".repeat(129) },
    ]) {
      expectProtocolError(() => parseSseAckRequest(value), "malformed");
    }
  });
});

describe("ordered subscription state", () => {
  test("accepts success, application errors, checkpoints, resume, and authorization revocation", () => {
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
    expect(
      parseSubscriptionTransition({
        kind: "application-error",
        from: cursor(3n),
        to: cursor(4n),
        error: {
          kind: "application",
          code: "message-not-found",
          body: { id: 7n },
          status: Status.NotFound,
        },
      }).kind,
    ).toBe("application-error");
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
      v: PROTOCOL_VERSION,
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
        v: PROTOCOL_VERSION,
        t: "welcome",
        clientSessionId: "client-1",
        authEpoch: 0,
        principal: "anonymous",
      }).t,
    ).toBe("welcome");
    const userAuthentication = {
      v: PROTOCOL_VERSION,
      t: "auth",
      attemptId: 2,
      authEpoch: 1,
      principal: "user",
      identity: 7n as Identity,
      provenance: { issuer: "https://issuer.example", subject: "user-7" },
    } satisfies AuthenticatedMessage;
    expect(parseServerMessage(decode(encode(userAuthentication)))).toEqual(userAuthentication);
    expect(
      parseServerMessage({
        v: PROTOCOL_VERSION,
        t: "err",
        id: null,
        outcome: { code: "unauthenticated", retryable: false, message: "authentication required" },
      }).t,
    ).toBe("err");
  });

  test("validates the exact secret-free authentication descriptor union", () => {
    expect(
      parseServerMessage({
        v: PROTOCOL_VERSION,
        t: "welcome",
        clientSessionId: "client-1",
        authEpoch: 0,
        principal: "workload",
        provenance: { issuer: "https://issuer.example", subject: "worker-1" },
      }),
    ).toMatchObject({ principal: "workload" });

    for (const descriptor of [
      { principal: "user" },
      {
        principal: "user",
        identity: 0n,
        provenance: { issuer: "https://issuer.example", subject: "user-1" },
      },
      {
        principal: "user",
        identity: 1n,
        provenance: { issuer: "https://issuer.example", subject: "user-1" },
        claims: { role: "admin" },
      },
      {
        principal: "workload",
        identity: 1n,
        provenance: { issuer: "https://issuer.example", subject: "worker-1" },
      },
      { principal: "anonymous", provenance: { issuer: "x", subject: "y" } },
      { principal: "system" },
    ]) {
      expectProtocolError(
        () =>
          parseServerMessage({
            v: PROTOCOL_VERSION,
            t: "auth",
            attemptId: 1,
            authEpoch: 1,
            ...descriptor,
          }),
        "malformed",
      );
    }
  });

  test("models live-only rows, gaps, and resets", () => {
    const position = { generation: "process-1", commitVersion: 4n, sequence: 9n };
    for (const event of [
      { kind: "row", cursor: position, row: { id: 1n } },
      { kind: "gap", cursor: position },
      { kind: "reset", cursor: position },
    ]) {
      expect(parseServerMessage({ v: PROTOCOL_VERSION, t: "event", id: 4, event }).t).toBe("event");
    }
  });

  test("validates query and mutation ok variants and the exact receipt", () => {
    expect(parseServerMessage({ v: PROTOCOL_VERSION, t: "ok", id: 1, kind: "query", value: [1, 2] }).t).toBe("ok");
    const procedure = parseServerMessage({
      v: PROTOCOL_VERSION,
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
        v: PROTOCOL_VERSION,
        t: "ok",
        id: 2,
        kind: "mutation",
        value: { created: 1n },
        receipt,
      }),
    ).toEqual({ v: PROTOCOL_VERSION, t: "ok", id: 2, kind: "mutation", value: { created: 1n }, receipt });
  });

  test("validates application-error frames and preserves procedure status metadata", () => {
    const error = {
      kind: "application" as const,
      code: "order-not-found",
      body: { orderId: "order-1" },
      status: Status.NotFound,
    };
    const procedure = parseServerMessage({
      v: PROTOCOL_VERSION,
      t: "app_err",
      id: 9,
      kind: "procedure",
      error,
    });
    expect(procedure).toEqual({
      v: PROTOCOL_VERSION,
      t: "app_err",
      id: 9,
      kind: "procedure",
      error,
    });
    expectProtocolError(
      () => parseServerMessage({
        v: PROTOCOL_VERSION,
        t: "app_err",
        id: 9,
        kind: "query",
        error: { ...error, status: 200 },
      }),
      "malformed",
    );
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
      () => parseServerMessage({ v: PROTOCOL_VERSION, t: "ok", id: 1, kind: "legacy", value: null }),
      "malformed",
    );
  });
});
