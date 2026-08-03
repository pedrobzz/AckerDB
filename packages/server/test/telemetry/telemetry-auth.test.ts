import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  parseServerMessage,
  parseSseMessage,
  type ServerMessage,
  type SseMessage,
} from "@ackerdb/core";
import {
  Engine,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  v,
  defineServiceLimits,
  defineSchema,
  defineTable,
  procedure,
  reconcile,
  serve,
  sseProcedure,
  type CredentialVerifier,
  type PrincipalInvalidation,
  type TelemetryEventRecord,
  type TelemetryMetricRecord,
  type TelemetryRecord,
  type TelemetrySpanRecord,
  type ServiceLimits,
  type VerifiedCredential,
} from "@ackerdb/server";
import { within } from "ackerdb-test-support/async";

const VALID_PROCEDURE_TOKEN = "valid-procedure-token-canary";
const INVALID_PROCEDURE_TOKEN = "invalid-procedure-token-canary";
const VALID_SSE_TOKEN = "valid-sse-token-canary";
const INVALID_SSE_TOKEN = "invalid-sse-token-canary";
const VALID_WS_TOKEN = "valid-ws-token-canary";
const VALID_REFRESH_TOKEN = "valid-refresh-token-canary";
const INVALID_WS_TOKEN = "invalid-ws-token-canary";
const HANGING_WS_TOKEN = "hanging-ws-token-canary";
const PRIVATE_ARGUMENT = "private-argument-canary";
const PRIVATE_RESULT = "private-result-canary";
const PRIVATE_STREAM_RESULT = "private-stream-result-canary";
const PRIVATE_CLAIM = "private-claim-canary";
const PRIVATE_VERIFIER_ERROR = "private-verifier-error-canary";
const PRIVATE_AUTH_HEADER = "private-auth-header-canary";

const schema = defineSchema({
  notes: defineTable({
    id: v.primaryKey(),
    body: v.string(),
  }),
});

// Transport telemetry owns these tests, not generated application types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const functions = {
  ops: {
    publicEcho: procedure({
      access: "public",
      http: true,
      args: { secret: v.string() },
      handler: () => "public-ok",
    }),
    echo: procedure({
      access: "authenticated",
      http: true,
      args: { secret: v.string() },
      handler: () => PRIVATE_RESULT,
    }),
    stream: sseProcedure({
      access: "authenticated",
      http: true,
      args: { secret: v.string() },
      yields: v.object({ result: v.string() }),
      handler: async function* () {
        yield { result: PRIVATE_STREAM_RESULT };
      },
    }),
  },
};

class AuthTelemetryVerifier implements CredentialVerifier {
  readonly revocationBound = { kind: "token-expiration" } as const;
  readonly verified: string[] = [];

  async verify(token: string): Promise<VerifiedCredential> {
    this.verified.push(token);
    if (token === HANGING_WS_TOKEN) return new Promise<VerifiedCredential>(() => {});
    if (!token.startsWith("valid-")) throw new Error(PRIVATE_VERIFIER_ERROR);
    return {
      kind: "user",
      issuer: "https://issuer.example",
      subject: token,
      expiresAt: Date.now() + 60_000,
      tokenId: `id:${token}`,
      claims: { secret: PRIVATE_CLAIM },
    };
  }

  subscribeInvalidation(_listener: (invalidation: PrincipalInvalidation) => void): () => void {
    return () => {};
  }
}

interface Fixture {
  readonly directory: string;
  readonly engine: Engine;
  readonly exported: TelemetryRecord[];
  readonly runtime: Runtime;
  readonly server: ReturnType<typeof serve>;
  readonly verifier: AuthTelemetryVerifier;
  readonly base: string;
}

function fixture(
  telemetryEnabled = true,
  slowOperationMs = 0,
  sampleIntervalMs = 60_000,
  limits?: ServiceLimits,
): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-telemetry-auth-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const exported: TelemetryRecord[] = [];
  const verifier = new AuthTelemetryVerifier();
  const runtime = new Runtime({
    engine,
    registry: new Registry(functions),
    verifier,
    ...(limits === undefined ? {} : { limits }),
    telemetry: telemetryEnabled
      ? {
          enabled: true,
          exporter: {
            export(batch) {
              exported.push(...batch);
            },
          },
          localSink: false,
          operationTraceSampleInterval: 1,
          limits: {
            maxRecords: 512,
            maxBytes: 1_024 * 1_024,
            maxMetricSeries: 128,
            maxBatchRecords: 512,
            batchIntervalMs: 60_000,
            exportTimeoutMs: 100,
            retentionMs: 60_000,
            slowOperationMs,
            sampleIntervalMs,
          },
        }
      : false,
  });
  const server = serve({ runtime, port: 0 });
  return {
    directory,
    engine,
    exported,
    runtime,
    server,
    verifier,
    base: `http://127.0.0.1:${server.port}`,
  };
}

async function cleanup(value: Fixture): Promise<void> {
  await value.server.drain().catch(() => {});
  await value.runtime.drain().catch(() => {});
  value.engine.close("clean");
  rmSync(value.directory, { recursive: true, force: true });
}

function spans(records: readonly TelemetryRecord[]): TelemetrySpanRecord[] {
  return records.filter((record): record is TelemetrySpanRecord => record.kind === "span");
}

function events(records: readonly TelemetryRecord[]): TelemetryEventRecord[] {
  return records.filter((record): record is TelemetryEventRecord => record.kind === "event");
}

function oneSpan(
  records: readonly TelemetrySpanRecord[],
  operation: TelemetrySpanRecord["operation"],
  stage: TelemetrySpanRecord["stage"],
  requestId: string,
  resource?: TelemetrySpanRecord["resource"],
): TelemetrySpanRecord {
  const matches = records.filter((record) =>
    record.operation === operation &&
    record.stage === stage &&
    record.requestId === requestId &&
    (resource === undefined || record.resource === resource)
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function expectTailBaseline(runtime: Runtime): void {
  expect(runtime.status().telemetry).toMatchObject({
    traceRetention: {
      activeTraces: 0,
      completedDecisions: 0,
      stagedRecords: 0,
      stagedBytes: 0,
      dropped: { invalid: 0 },
    },
  });
}

async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await Bun.sleep(5);
  }
}

async function readSseMessage(
  reader: { read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }> },
): Promise<SseMessage> {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const part = await within(reader.read());
    if (part.done || part.value === undefined) {
      throw new Error("SSE response ended before its next frame");
    }
    text += decoder.decode(part.value, { stream: true });
    const boundary = text.indexOf("\n\n");
    if (boundary < 0) continue;
    if (!text.startsWith("data: ") || text.length !== boundary + 2) {
      throw new Error(`invalid receiver-credited SSE frame ${JSON.stringify(text)}`);
    }
    return parseSseMessage(decode(text.slice(6, boundary)));
  }
}

function acknowledgeSse(
  base: string,
  stream: string,
  message: SseMessage,
  authorization?: string,
): Promise<Response> {
  return fetch(`${base}/api/_sse/ack`, {
    method: "POST",
    headers: authorization === undefined ? {} : { authorization },
    body: encode({
      v: PROTOCOL_VERSION,
      t: "sse_ack",
      stream,
      seq: message.seq,
      proof: message.proof,
    }),
  });
}

test("HTTP procedure and SSE auth share one sanitized Runtime trace and cover pre-Runtime failures", async () => {
  const app = fixture();
  // Path-addressed calls carry no client id: the listener numbers them itself,
  // in arrival order, and telemetry correlates on that request id.
  const receivedBytes = new Map<string, number>();
  const call = async (
    address: string,
    requestId: string,
    token: string,
    padding = 0,
  ): Promise<Response> => {
    const body = `${" ".repeat(padding)}${encode({ secret: PRIVATE_ARGUMENT })}`;
    receivedBytes.set(requestId, Buffer.byteLength(body));
    return fetch(`${app.base}/api/${address.replaceAll(".", "/")}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body,
    });
  };

  try {
    const procedure = await call("ops.echo", "1", VALID_PROCEDURE_TOKEN, 37);
    expect(procedure.status).toBe(200);
    expect(decode(await procedure.text())).toBe(PRIVATE_RESULT);
    expectTailBaseline(app.runtime);

    const deniedProcedure = await call("ops.echo", "2", INVALID_PROCEDURE_TOKEN);
    expect(deniedProcedure.status).toBe(503);
    expect(decode(await deniedProcedure.text())).toMatchObject({ code: "auth_unavailable" });
    expectTailBaseline(app.runtime);

    const stream = await call("ops.stream", "3", VALID_SSE_TOKEN, 53);
    expect(stream.status).toBe(200);
    const streamId = stream.headers.get("x-ackerdb-sse-stream");
    if (streamId === null || stream.body === null) throw new Error("missing SSE response ownership");
    const streamReader = stream.body.getReader();
    const chunk = await readSseMessage(streamReader);
    expect(chunk).toMatchObject({
      t: "sse_chunk",
      value: { result: PRIVATE_STREAM_RESULT },
    });
    const verifiedBeforeCredit = [...app.verifier.verified];
    expect((await acknowledgeSse(
      app.base,
      streamId,
      chunk,
      `Bearer ${PRIVATE_AUTH_HEADER}`,
    )).status).toBe(204);
    expect(app.verifier.verified).toEqual(verifiedBeforeCredit);
    const terminal = await readSseMessage(streamReader);
    expect(terminal.t).toBe("sse_done");
    expect((await acknowledgeSse(app.base, streamId, terminal)).status).toBe(204);
    expect(await within(streamReader.read())).toEqual({ done: true, value: undefined });
    streamReader.releaseLock();
    await eventually(() => app.runtime.status().telemetry.traceRetention.activeTraces === 0);
    expectTailBaseline(app.runtime);

    const deniedStream = await call("ops.stream", "4", INVALID_SSE_TOKEN, 53);
    expect(deniedStream.status).toBe(503);
    expect(decode(await deniedStream.text())).toMatchObject({ code: "auth_unavailable" });
    expectTailBaseline(app.runtime);

    const malformedAuthorization = await fetch(`${app.base}/api/ops/echo`, {
      method: "POST",
      headers: { authorization: `Basic ${PRIVATE_AUTH_HEADER}` },
      body: encode({ secret: PRIVATE_ARGUMENT }),
    });
    expect(malformedAuthorization.status).toBe(401);
    await malformedAuthorization.text();
    expectTailBaseline(app.runtime);

    const anonymous = await fetch(`${app.base}/api/ops/publicEcho`, {
      method: "POST",
      body: encode({ secret: PRIVATE_ARGUMENT }),
    });
    expect(anonymous.status).toBe(200);
    expect(decode(await anonymous.text())).toBe("public-ok");
    expectTailBaseline(app.runtime);

    const malformedBody = await fetch(`${app.base}/api/ops/echo`, {
      method: "POST",
      headers: { authorization: `Bearer ${VALID_PROCEDURE_TOKEN}` },
      body: "{",
    });
    expect(malformedBody.status).toBe(400);
    await malformedBody.text();
    expectTailBaseline(app.runtime);

    await app.runtime.telemetry.flush();
    const retainedSpans = spans(app.exported);
    const retainedEvents = events(app.exported);
    const auth = [
      oneSpan(retainedSpans, "procedure", "auth", "1", "operation"),
      oneSpan(retainedSpans, "procedure", "auth", "2", "operation"),
      oneSpan(retainedSpans, "sse", "auth", "3", "operation"),
      oneSpan(retainedSpans, "sse", "auth", "4", "operation"),
      oneSpan(retainedSpans, "procedure", "auth", "5", "operation"),
      oneSpan(retainedSpans, "procedure", "auth", "6", "operation"),
    ];
    expect(auth.map(({ function: fn, outcome }) => ({ fn, outcome }))).toEqual([
      { fn: "ops.echo", outcome: "ok" },
      { fn: "ops.echo", outcome: "auth_unavailable" },
      { fn: "ops.stream", outcome: "ok" },
      { fn: "ops.stream", outcome: "auth_unavailable" },
      { fn: "ops.echo", outcome: "unauthenticated" },
      { fn: "ops.publicEcho", outcome: "ok" },
    ]);

    const procedureAdmission = oneSpan(retainedSpans, "procedure", "admission", "1");
    const procedureDelivery = oneSpan(retainedSpans, "procedure", "delivery", "1");
    expect(auth[0]!.traceId).toBe(procedureAdmission.traceId);
    expect(auth[0]!.traceId).toBe(procedureDelivery.traceId);
    expect(procedureAdmission.function).toBe("ops.echo");
    expect(procedureAdmission.sizeBytes).toBe(receivedBytes.get("1"));

    const anonymousAdmission = oneSpan(retainedSpans, "procedure", "admission", "6");
    const anonymousDelivery = oneSpan(retainedSpans, "procedure", "delivery", "6");
    expect(auth[5]!.traceId).toBe(anonymousAdmission.traceId);
    expect(auth[5]!.traceId).toBe(anonymousDelivery.traceId);

    const sseAdmission = oneSpan(retainedSpans, "sse", "admission", "3");
    expect(auth[2]!.traceId).toBe(sseAdmission.traceId);
    expect(sseAdmission.sizeBytes).toBe(receivedBytes.get("3"));
    expect(retainedSpans.some((record) =>
      record.operation === "sse" &&
      record.stage === "delivery" &&
      record.traceId === auth[2]!.traceId &&
      record.requestId === "3" &&
      record.function === "ops.stream"
    )).toBe(true);

    for (const failed of [auth[1]!, auth[3]!, auth[4]!]) {
      const failureEvents = retainedEvents.filter((record) =>
        record.name === "failure" &&
        record.stage === "auth" &&
        record.traceId === failed.traceId &&
        record.requestId === failed.requestId &&
        record.function === failed.function &&
        record.outcome === failed.outcome
      );
      expect(failureEvents).toHaveLength(1);
      expect(retainedSpans.some((record) =>
        record.stage === "admission" && record.requestId === failed.requestId
      )).toBe(false);
    }

    // The path names the function before its body is read, so a malformed body
    // still reports the operation it targeted.
    const malformedSpans = retainedSpans.filter((record) =>
      record.operation === "procedure" &&
      record.stage === "admission" &&
      record.outcome === "malformed" &&
      record.function === "ops.echo" &&
      record.requestId === "7"
    );
    expect(malformedSpans).toHaveLength(1);
    expect(retainedEvents.filter((record) =>
      record.name === "failure" &&
      record.stage === "admission" &&
      record.traceId === malformedSpans[0]!.traceId &&
      record.outcome === "malformed"
    )).toHaveLength(1);

    expect(app.verifier.verified).toEqual([
      VALID_PROCEDURE_TOKEN,
      INVALID_PROCEDURE_TOKEN,
      VALID_SSE_TOKEN,
      INVALID_SSE_TOKEN,
    ]);
    const serialized = JSON.stringify(app.exported);
    for (const secret of [
      VALID_PROCEDURE_TOKEN,
      INVALID_PROCEDURE_TOKEN,
      VALID_SSE_TOKEN,
      INVALID_SSE_TOKEN,
      PRIVATE_ARGUMENT,
      PRIVATE_RESULT,
      PRIVATE_STREAM_RESULT,
      PRIVATE_CLAIM,
      PRIVATE_VERIFIER_ERROR,
      PRIVATE_AUTH_HEADER,
    ]) {
      expect(serialized).not.toContain(secret);
    }
  } finally {
    await cleanup(app);
  }
});

interface WsClient {
  readonly socket: WebSocket;
  send(frame: unknown): void;
  next(): Promise<ServerMessage>;
  closed(): Promise<CloseEvent>;
}

function rawWebSocket(url: string): Promise<WsClient> {
  const socket = new WebSocket(url);
  const frames: ServerMessage[] = [];
  const frameWaiters: Array<(frame: ServerMessage) => void> = [];
  let closeEvent: CloseEvent | null = null;
  const closeWaiters: Array<(event: CloseEvent) => void> = [];
  socket.onmessage = (event) => {
    const frame = parseServerMessage(decode(String(event.data)));
    const waiter = frameWaiters.shift();
    if (waiter === undefined) frames.push(frame);
    else waiter(frame);
  };
  socket.onclose = (event) => {
    closeEvent = event;
    for (const waiter of closeWaiters.splice(0)) waiter(event);
  };
  return within(new Promise<WsClient>((resolve, reject) => {
    socket.onopen = () => resolve({
      socket,
      send: (frame) => socket.send(encode(frame)),
      next: () => {
        const frame = frames.shift();
        return frame === undefined
          ? new Promise<ServerMessage>((accept) => frameWaiters.push(accept))
          : Promise.resolve(frame);
      },
      closed: () => closeEvent === null
        ? new Promise<CloseEvent>((accept) => closeWaiters.push(accept))
        : Promise.resolve(closeEvent),
    });
    socket.onerror = () => reject(new Error("WebSocket connection failed"));
  }));
}

test("disabled telemetry adds no HTTP token or WebSocket auth-observer records", async () => {
  const app = fixture(false);
  try {
    const response = await fetch(`${app.base}/api/ops/publicEcho`, {
      method: "POST",
      body: encode({ secret: PRIVATE_ARGUMENT }),
    });
    expect(response.status).toBe(200);
    await response.text();

    const client = await rawWebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
    client.send({
      v: PROTOCOL_VERSION,
      t: "hello",
      clientSessionId: "disabled-telemetry-connection",
      credential: { kind: "anonymous" },
    });
    expect(await within(client.next())).toMatchObject({ t: "welcome", principal: "anonymous" });
    client.socket.close();
    await within(client.closed());

    expect(app.exported).toEqual([]);
    expect(app.verifier.verified).toEqual([]);
    expect(app.runtime.status().telemetry).toMatchObject({
      enabled: false,
      queuedRecords: 0,
      queuedBytes: 0,
      traceRetention: {
        activeTraces: 0,
        completedDecisions: 0,
        stagedRecords: 0,
        stagedBytes: 0,
      },
    });
  } finally {
    await cleanup(app);
  }
});

test("samples bounded Serve pressure during pre-hello and HTTP auth stalls without identities", async () => {
  const app = fixture(true, 0, 5, defineServiceLimits({
    ...PRODUCTION_LIMITS,
    maxOperationsPerCaller: 1,
  }));
  const forwardedCanary = "198.51.100.77-private-forwarded-canary";
  const connectionCanary = "private-pressure-connection-canary";
  const httpCancellation = new AbortController();
  let client: WsClient | undefined;
  let pendingHttp: Promise<Response | undefined> | undefined;

  try {
    client = await rawWebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
    client.send({
      v: PROTOCOL_VERSION,
      t: "hello",
      clientSessionId: connectionCanary,
      credential: { kind: "bearer", token: HANGING_WS_TOKEN },
    });
    await eventually(() => app.verifier.verified.includes(HANGING_WS_TOKEN));

    pendingHttp = fetch(`${app.base}/api/ops/publicEcho`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${HANGING_WS_TOKEN}`,
        "x-forwarded-for": forwardedCanary,
      },
      body: encode({ secret: PRIVATE_ARGUMENT }),
      signal: httpCancellation.signal,
    }).catch(() => undefined);
    await eventually(() => {
      const status = app.server.status();
      return status.preHelloConnections === 1 && status.httpIngress === 1;
    });

    const rejected = await fetch(`${app.base}/api/ops/publicEcho`, {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.88" },
      body: encode({ secret: PRIVATE_ARGUMENT }),
    });
    expect(rejected.status).toBe(503);
    await rejected.text();
    await eventually(() => app.server.status().httpFairShareRejections === 1);
    await Bun.sleep(20);
    await app.runtime.telemetry.flush();

    const status = app.server.status();
    const expected = new Map<string, readonly [number, TelemetryMetricRecord["unit"]]>([
      ["runtime.transport_websocket_connections", [status.connections, "gauge"]],
      ["runtime.transport_websocket_pre_hello", [status.preHelloConnections, "gauge"]],
      ["runtime.transport_websocket_rejections", [status.connectionRejections, "count"]],
      ["runtime.transport_websocket_outbound_bytes", [status.outboundBytes, "bytes"]],
      ["runtime.transport_http_ingress", [status.httpIngress, "gauge"]],
      ["runtime.transport_http_fairness_keys", [status.httpFairnessKeys, "gauge"]],
      ["runtime.transport_http_global_rejections", [status.httpGlobalRejections, "count"]],
      ["runtime.transport_http_fair_share_rejections", [status.httpFairShareRejections, "count"]],
    ]);
    const latest = new Map<string, TelemetryMetricRecord>();
    for (const record of app.exported) {
      if (record.kind === "metric" && expected.has(record.name)) latest.set(record.name, record);
    }
    expect(latest.size).toBe(expected.size);
    for (const [name, [value, unit]] of expected) {
      expect(latest.get(name)).toMatchObject({ name, value, unit });
      expect(Object.values(latest.get(name)!.labels).every((label) => label === undefined)).toBe(true);
    }
    expect(status.preHelloConnections).toBeLessThanOrEqual(status.connections);
    expect(status.connections).toBeLessThanOrEqual(app.runtime.limits.maxConnections);
    expect(status.httpFairnessKeys).toBeLessThanOrEqual(status.httpIngress);
    expect(status.httpIngress).toBeLessThanOrEqual(app.runtime.limits.maxOperations);
    expect(status.outboundBytes).toBeLessThanOrEqual(app.runtime.limits.webSocket.maxBytes);

    const serialized = JSON.stringify(app.exported);
    for (const identity of [HANGING_WS_TOKEN, connectionCanary, forwardedCanary]) {
      expect(serialized).not.toContain(identity);
    }

    httpCancellation.abort("test cancellation");
    await pendingHttp;
    pendingHttp = undefined;
    client.socket.close();
    await within(client.closed());
    client = undefined;
    await eventually(() => {
      const released = app.server.status();
      return released.connections === 0 && released.httpIngress === 0;
    });
    await app.runtime.drain();
    await Bun.sleep(20);
    expect(app.runtime.status().telemetry.queuedRecords).toBe(0);
  } finally {
    httpCancellation.abort("test cleanup");
    client?.socket.close();
    await client?.closed().catch(() => {});
    await pendingHttp?.catch(() => {});
    await cleanup(app);
  }
});

test("HTTP handoff and terminated WebSocket auth each close one retained tail lifecycle", async () => {
  const app = fixture(true, 60_000);

  try {
    const response = await fetch(`${app.base}/api/ops/publicEcho`, {
      method: "POST",
      body: encode({ secret: PRIVATE_ARGUMENT }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(app.runtime.status().telemetry.traceRetention).toMatchObject({
      activeTraces: 0,
      completedDecisions: 1,
      dropped: { invalid: 0 },
    });
    expect(app.runtime.status().telemetry.queuedRecords).toBeGreaterThan(0);

    const denied = await fetch(`${app.base}/api/ops/echo`, {
      method: "POST",
      headers: { authorization: `Bearer ${INVALID_PROCEDURE_TOKEN}` },
      body: encode({ secret: PRIVATE_ARGUMENT }),
    });
    expect(denied.status).toBe(503);
    await denied.text();
    expect(app.runtime.status().telemetry.traceRetention).toMatchObject({
      activeTraces: 0,
      completedDecisions: 2,
      promotedTraces: 2,
      dropped: { invalid: 0 },
    });

    const malformed = await fetch(`${app.base}/api/ops/publicEcho`, {
      method: "POST",
      body: "{",
    });
    expect(malformed.status).toBe(400);
    await malformed.text();
    expect(app.runtime.status().telemetry.traceRetention).toMatchObject({
      activeTraces: 0,
      completedDecisions: 3,
      promotedTraces: 3,
      dropped: { invalid: 0 },
    });

    const hanging = await rawWebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
    hanging.send({
      v: PROTOCOL_VERSION,
      t: "hello",
      clientSessionId: "private-retained-tail-connection-canary",
      credential: { kind: "bearer", token: HANGING_WS_TOKEN },
    });
    await eventually(() => app.verifier.verified.includes(HANGING_WS_TOKEN));
    expect(app.runtime.status().telemetry.traceRetention).toMatchObject({
      activeTraces: 1,
      completedDecisions: 3,
      dropped: { invalid: 0 },
    });

    hanging.socket.close();
    await within(hanging.closed());
    await eventually(() => {
      const tail = app.runtime.status().telemetry.traceRetention;
      return tail.activeTraces === 0 && tail.completedDecisions === 4;
    });
    expect(app.runtime.status().telemetry.traceRetention).toMatchObject({
      activeTraces: 0,
      completedDecisions: 4,
      promotedTraces: 4,
      dropped: { invalid: 0 },
    });

    await app.server.drain();
    expectTailBaseline(app.runtime);
  } finally {
    await cleanup(app);
  }
});

async function hello(
  app: Fixture,
  clientSessionId: string,
  token: string,
): Promise<WsClient> {
  const client = await rawWebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  client.send({
    v: PROTOCOL_VERSION,
    t: "hello",
    clientSessionId,
    credential: { kind: "bearer", token },
  });
  expect(await within(client.next())).toMatchObject({
    t: "welcome",
    clientSessionId,
    authEpoch: 0,
    principal: "user",
  });
  return client;
}

test("real WebSocket auth traces hello, refresh, sign-out, failures, supersession, and close", async () => {
  const app = fixture();
  const primaryConnection = "private-primary-connection-canary";
  const failedHelloConnection = "private-failed-hello-connection-canary";
  const failedRefreshConnection = "private-failed-refresh-connection-canary";
  const supersededConnection = "private-superseded-connection-canary";
  const closedConnection = "private-closed-connection-canary";
  const closedHelloConnection = "private-closed-hello-connection-canary";

  try {
    const primary = await hello(app, primaryConnection, VALID_WS_TOKEN);
    primary.send({
      v: PROTOCOL_VERSION,
      t: "auth",
      attemptId: 1,
      credential: { kind: "bearer", token: VALID_REFRESH_TOKEN },
    });
    expect(await within(primary.next())).toMatchObject({
      t: "auth",
      attemptId: 1,
      authEpoch: 1,
      principal: "user",
    });
    primary.send({
      v: PROTOCOL_VERSION,
      t: "auth",
      attemptId: 2,
      credential: { kind: "anonymous" },
    });
    expect(await within(primary.next())).toMatchObject({
      t: "auth",
      attemptId: 2,
      authEpoch: 2,
      principal: "anonymous",
    });
    primary.socket.close();
    await within(primary.closed());
    expectTailBaseline(app.runtime);

    const failedHello = await rawWebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
    failedHello.send({
      v: PROTOCOL_VERSION,
      t: "hello",
      clientSessionId: failedHelloConnection,
      credential: { kind: "bearer", token: INVALID_WS_TOKEN },
    });
    expect(await within(failedHello.next())).toMatchObject({
      t: "err",
      id: null,
      outcome: { code: "auth_unavailable" },
    });
    await within(failedHello.closed());
    expectTailBaseline(app.runtime);

    const failedRefresh = await hello(app, failedRefreshConnection, VALID_WS_TOKEN);
    failedRefresh.send({
      v: PROTOCOL_VERSION,
      t: "auth",
      attemptId: 3,
      credential: { kind: "bearer", token: INVALID_WS_TOKEN },
    });
    expect(await within(failedRefresh.next())).toMatchObject({
      t: "err",
      id: null,
      outcome: { code: "auth_unavailable" },
    });
    await within(failedRefresh.closed());
    expectTailBaseline(app.runtime);

    const superseded = await hello(app, supersededConnection, VALID_WS_TOKEN);
    superseded.send({
      v: PROTOCOL_VERSION,
      t: "auth",
      attemptId: 4,
      credential: { kind: "bearer", token: HANGING_WS_TOKEN },
    });
    await eventually(() => app.verifier.verified.filter((token) => token === HANGING_WS_TOKEN).length >= 1);
    superseded.send({
      v: PROTOCOL_VERSION,
      t: "auth",
      attemptId: 5,
      credential: { kind: "anonymous" },
    });
    expect(await within(superseded.next())).toMatchObject({
      t: "auth",
      attemptId: 5,
      principal: "anonymous",
    });
    superseded.socket.close();
    await within(superseded.closed());
    expectTailBaseline(app.runtime);

    const closed = await hello(app, closedConnection, VALID_WS_TOKEN);
    closed.send({
      v: PROTOCOL_VERSION,
      t: "auth",
      attemptId: 6,
      credential: { kind: "bearer", token: HANGING_WS_TOKEN },
    });
    await eventually(() => app.verifier.verified.filter((token) => token === HANGING_WS_TOKEN).length >= 2);
    closed.socket.close();
    await within(closed.closed());
    await eventually(() => app.server.status().connections === 0);
    expectTailBaseline(app.runtime);

    const closedHello = await rawWebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
    closedHello.send({
      v: PROTOCOL_VERSION,
      t: "hello",
      clientSessionId: closedHelloConnection,
      credential: { kind: "bearer", token: HANGING_WS_TOKEN },
    });
    await eventually(() =>
      app.verifier.verified.filter((token) => token === HANGING_WS_TOKEN).length >= 3
    );
    closedHello.socket.close();
    await within(closedHello.closed());
    await eventually(() => app.server.status().connections === 0);
    expectTailBaseline(app.runtime);

    await app.runtime.telemetry.flush();
    const retainedSpans = spans(app.exported);
    const retainedEvents = events(app.exported);
    const authSpans = retainedSpans.filter((record) =>
      record.operation === "lifecycle" && record.stage === "auth"
    );
    const expected = [
      ["ws.hello", "hello", "ok"],
      ["ws.refresh", "1", "ok"],
      ["ws.sign-out", "2", "ok"],
      ["ws.hello", "hello", "auth_unavailable"],
      ["ws.hello", "hello", "ok"],
      ["ws.refresh", "3", "auth_unavailable"],
      ["ws.hello", "hello", "ok"],
      ["ws.refresh", "4", "auth_stale"],
      ["ws.sign-out", "5", "ok"],
      ["ws.hello", "hello", "ok"],
      ["ws.refresh", "6", "unavailable"],
      ["ws.hello", "hello", "unavailable"],
    ];
    expect(authSpans.map(({ function: fn, requestId, outcome }) => [fn, requestId, outcome]))
      .toEqual(expected);
    expect(new Set(authSpans.map((record) => record.traceId)).size).toBe(authSpans.length);

    const primaryHash = createHash("sha256").update(primaryConnection).digest("base64url");
    const primarySpans = authSpans.filter((record) => record.connectionId === primaryHash);
    expect(primarySpans.map((record) => record.requestId)).toEqual(["hello", "1", "2"]);
    expect(primarySpans.every((record) => record.connectionId !== primaryConnection)).toBe(true);
    for (const failed of authSpans.filter((record) => record.outcome !== "ok")) {
      expect(retainedEvents.filter((record) =>
        record.name === "failure" &&
        record.stage === "auth" &&
        record.traceId === failed.traceId &&
        record.connectionId === failed.connectionId &&
        record.requestId === failed.requestId &&
        record.function === failed.function &&
        record.outcome === failed.outcome
      )).toHaveLength(1);
    }

    const serialized = JSON.stringify(app.exported);
    for (const secret of [
      VALID_WS_TOKEN,
      VALID_REFRESH_TOKEN,
      INVALID_WS_TOKEN,
      HANGING_WS_TOKEN,
      PRIVATE_CLAIM,
      PRIVATE_VERIFIER_ERROR,
      primaryConnection,
      failedHelloConnection,
      failedRefreshConnection,
      supersededConnection,
      closedConnection,
      closedHelloConnection,
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expectTailBaseline(app.runtime);
  } finally {
    await cleanup(app);
  }
});
