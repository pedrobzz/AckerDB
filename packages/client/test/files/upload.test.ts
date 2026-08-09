import { describe, expect, test } from "bun:test";
import {
  ACKERDB_VERSION,
  Status,
  type ApplicationError,
  type ClientMessage,
  type FileId,
  type MutationReceipt,
  type MutationRef,
} from "@ackerdb/core";
import type { AckerDBClient, AckerDBFetch } from "@ackerdb/client";
import {
  createHarness,
  mustOk,
  type ClientHarness,
} from "../support/harness.ts";

interface UploadSession {
  readonly url: string;
  readonly expiresAt: number;
  readonly maxBytes: number;
}

const createUpload = {
  $ref: "api.documents.createUpload",
} as MutationRef<{ readonly folder: string }, UploadSession>;

type UploadDenied = ApplicationError<
  "organization-storage-disabled",
  { readonly organizationId: bigint },
  typeof Status.Forbidden
>;

const createAuthorizedUpload = {
  $ref: "api.documents.createAuthorizedUpload",
} as MutationRef<
  { readonly organizationId: bigint },
  UploadSession,
  UploadDenied
>;

type ClientSocket = ClientHarness["sockets"][number];
type MutationRequest = Extract<ClientMessage, { readonly t: "m" }>;

function dispatchSession(client: AckerDBClient, socket: ClientSocket): MutationRequest {
  socket.welcome(client.clientSessionId);
  return socket.lastFrame("m");
}

function receipt(mutation: MutationRequest): MutationReceipt {
  return {
    mutationRequestId: mutation.mutationRequestId,
    commitVersion: 1n,
    durability: "production",
    replay: "executed",
    obligations: [],
  };
}

function acceptSession(
  socket: ClientSocket,
  mutation: MutationRequest,
  url: string,
  expiresAt = 60_000,
): void {
  socket.receive({
    v: ACKERDB_VERSION,
    t: "ok",
    id: mutation.id,
    kind: "mutation",
    value: { url, expiresAt, maxBytes: 1_024 },
    receipt: receipt(mutation),
  });
}

function advertisedUploadUrl(secret: string): string {
  return `https://public-files.test/_files/uploads/${secret}`;
}

function clientUploadUrl(secret: string): string {
  return `http://ackerdb.test/_files/uploads/${secret}`;
}

async function eventually(predicate: () => boolean, description: string): Promise<void> {
  for (let turn = 0; turn < 100; turn++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function advanceClock(
  harness: Pick<ClientHarness, "clock">,
  delayMs: number,
): Promise<void> {
  // Fetch rejection and response parsing cross several promise turns before
  // arming the retry. Drain them before moving the deterministic clock.
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  harness.clock.advance(delayMs);
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
}

describe("AckerDBClient files", () => {
  test("uploads through the client origin when the session advertises server-localhost", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const fetcher: AckerDBFetch = async (url, init) => {
      requests.push({ url, init });
      return Response.json({ fileId: "42" });
    };
    const { client, sockets } = createHarness({
      credential: { kind: "bearer", token: "application-secret" },
      fetch: fetcher,
    });
    const file = new File([new Uint8Array([1, 2, 3])], "résumé's 2026.pdf", {
      type: "application/pdf",
    });

    const uploaded = client.files.upload({
      createSession: createUpload,
      args: { folder: "contracts" },
      file,
    });
    const socket = sockets[0]!;
    const mutation = dispatchSession(client, socket);
    expect(mutation).toMatchObject({
      ref: "api.documents.createUpload",
      args: { folder: "contracts" },
    });
    acceptSession(
      socket,
      mutation,
      "http://127.0.0.1:3000/_files/uploads/17.session-secret",
    );

    expect(mustOk(await uploaded)).toBe(42n as FileId);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    const headers = new Headers(request.init?.headers);
    expect(request.url).toBe("http://ackerdb.test/_files/uploads/17.session-secret");
    expect(request.init?.method).toBe("PUT");
    expect(request.init?.body).toBe(file);
    expect(headers.get("content-type")).toBe("application/pdf");
    expect(headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%27s%202026.pdf",
    );
    expect(headers.get("authorization")).toBeNull();
    client.close();
  });

  test("rejects a malformed Upload Session route before sending bytes", async () => {
    let fetches = 0;
    const { client, sockets } = createHarness({
      fetch: async () => {
        fetches++;
        return Response.json({ fileId: "42" });
      },
    });
    const uploaded = client.files.upload({
      createSession: createUpload,
      args: { folder: "contracts" },
      file: new Uint8Array([1, 2, 3]),
    });
    const socket = sockets[0]!;
    const mutation = dispatchSession(client, socket);
    acceptSession(socket, mutation, "https://attacker.test/not-an-upload-route");

    const result = await uploaded;
    expect(fetches).toBe(0);
    if (result.ok) throw new Error("a malformed Upload Session unexpectedly uploaded bytes");
    expect(result.error).toMatchObject({
      code: "malformed",
      retryable: false,
      resource: "operation",
    });
    client.close();
  });

  test("streams GET and HEAD grants with caller headers and authoritative current credentials", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const { client, sockets } = createHarness({
      credential: { kind: "bearer", token: "token-a" },
      fetch: async (url, init) => {
        requests.push({ url, init });
        if (init?.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": "6", "x-file": "yes" },
          });
        }
        return new Response(new Blob([`body-${requests.length}`]).stream(), {
          status: 206,
          headers: { "content-type": "application/octet-stream", "x-file": "yes" },
        });
      },
    });
    const socket = sockets[0]!;
    socket.welcome(client.clientSessionId, {
      principal: "workload",
      provenance: { issuer: "https://issuer.test", subject: "worker" },
      credentialTtlMs: 60_000,
    });

    const first = await client.files.fetch(
      "http://ackerdb.test/_files/grants/grant-a",
      {
        headers: {
          authorization: "Bearer caller-spoof",
          range: "bytes=0-5",
          "if-none-match": '"sha256"',
        },
      },
    );
    expect(first).toBeInstanceOf(Response);
    expect(first.status).toBe(206);
    expect(first.headers.get("x-file")).toBe("yes");
    expect(await first.text()).toBe("body-1");

    const refresh = client.refreshCredential({ kind: "anonymous" });
    const authentication = socket.lastFrame("auth");
    socket.receive({
      v: ACKERDB_VERSION,
      t: "auth",
      attemptId: authentication.attemptId,
      authEpoch: 1,
      principal: "anonymous",
    });
    await refresh;
    const second = await client.files.fetch(
      "http://ackerdb.test/_files/grants/grant-b",
      {
        method: "HEAD",
        headers: { authorization: "Bearer caller-spoof" },
      },
    );
    expect(second.status).toBe(200);
    expect(second.body).toBeNull();

    expect(requests.map((request) => request.url)).toEqual([
      "http://ackerdb.test/_files/grants/grant-a",
      "http://ackerdb.test/_files/grants/grant-b",
    ]);
    expect(new Headers(requests[0]!.init?.headers).get("authorization")).toBe("Bearer token-a");
    expect(new Headers(requests[1]!.init?.headers).get("authorization")).toBeNull();
    expect(new Headers(requests[0]!.init?.headers).get("range")).toBe("bytes=0-5");
    expect(new Headers(requests[0]!.init?.headers).get("if-none-match")).toBe('"sha256"');
    expect(requests.map((request) => request.init?.method)).toEqual(["GET", "HEAD"]);
    expect(requests.every((request) => request.init?.credentials === "omit")).toBe(true);
    expect(requests.every((request) => request.init?.redirect === "error")).toBe(true);
    client.close();
  });

  test("rewrites a public grant origin and rejects unsafe URL shapes before fetching", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const { client } = createHarness({
      credential: { kind: "bearer", token: "must-not-leak" },
      fetch: async (url, init) => {
        requests.push({ url, init });
        return new Response();
      },
    });

    await (await client.files.fetch(
      "https://public-files.test/_files/grants/17.secret",
    )).text();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("http://ackerdb.test/_files/grants/17.secret");
    expect(new Headers(requests[0]!.init?.headers).get("authorization")).toBe(
      "Bearer must-not-leak",
    );

    for (const unsafe of [
      "http://ackerdb.test/api/private-data",
      "https://user:password@public-files.test/_files/grants/17.secret",
      "https://public-files.test/_files/grants/17.secret?redirect=https://attacker.test",
      "https://public-files.test/_files/grants/17.secret#fragment",
    ]) {
      await expect(client.files.fetch(unsafe)).rejects.toThrow(
        "File grant URL has an invalid AckerDB grant shape",
      );
    }
    expect(requests).toHaveLength(1);
    client.close();
  });

  test("fetch returns before the body completes and caller cancellation reaches its source", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    let sourceCanceled: unknown;
    let requestSignal: AbortSignal | undefined;
    const { client, sockets } = createHarness({
      fetch: async (_url, init) => {
        requestSignal = init?.signal ?? undefined;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller;
          },
          cancel(reason) {
            sourceCanceled = reason;
          },
        }));
      },
    });
    sockets[0]!.welcome(client.clientSessionId);
    const abort = new AbortController();

    const response = await client.files.fetch(
      "http://ackerdb.test/_files/grants/streaming-grant",
      { signal: abort.signal },
    );
    expect(response.bodyUsed).toBe(false);
    expect(requestSignal?.aborted).toBe(false);
    const reader = response.body!.getReader();
    const first = reader.read();
    source.enqueue(new Uint8Array([1, 2, 3]));
    expect(await first).toEqual({ done: false, value: new Uint8Array([1, 2, 3]) });

    const pending = reader.read();
    abort.abort("caller stopped download");
    await expect(pending).rejects.toBe("caller stopped download");
    expect(requestSignal?.aborted).toBe(true);
    expect(sourceCanceled).toBe("caller stopped download");
    client.close();
  });

  test("recovers several lost success responses against the same upload session", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const fetcher: AckerDBFetch = async (url, init) => {
      requests.push({ url, init });
      if (requests.length < 4) throw new Error("success response was lost");
      return Response.json({ fileId: "43" });
    };
    const harness = createHarness({ fetch: fetcher });
    const { client, sockets } = harness;
    const bytes = new Uint8Array([4, 5, 6]);

    const uploaded = client.files.upload({
      createSession: createUpload,
      args: { folder: "reports" },
      file: bytes,
      name: "report (final).bin",
      contentType: "application/octet-stream",
    });
    const socket = sockets[0]!;
    const mutation = dispatchSession(client, socket);
    acceptSession(socket, mutation, advertisedUploadUrl("18.retryable-session"));

    await eventually(() => requests.length === 1, "the first upload attempt");
    for (const [index, delay] of [250, 500, 1_000].entries()) {
      const requestCount = index + 2;
      await advanceClock(harness, delay);
      await eventually(() => requests.length === requestCount, `upload attempt ${requestCount}`);
    }

    expect(mustOk(await uploaded)).toBe(43n as FileId);
    expect(requests.map(({ url }) => url)).toEqual(Array(4).fill(
      clientUploadUrl("18.retryable-session"),
    ));
    expect(socket.frames().filter((frame) => frame.t === "m")).toHaveLength(1);
    const retryHeaders = new Headers(requests.at(-1)!.init?.headers);
    expect(requests.every((request) => request.init?.body === bytes)).toBe(true);
    expect(retryHeaders.get("content-type")).toBe("application/octet-stream");
    expect(retryHeaders.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''report%20%28final%29.bin",
    );
    client.close();
  });

  test("uses bounded backoff through a longer transient upload outage", async () => {
    const attempts: number[] = [];
    let harness!: ClientHarness;
    harness = createHarness({
      fetch: async () => {
        attempts.push(harness.clock.now());
        if (attempts.length < 8) throw new Error("upload network remains unavailable");
        return Response.json({ fileId: "44" });
      },
    });
    const body = new Blob([new Uint8Array([7, 8, 9])]);
    const uploaded = harness.client.files.upload({
      createSession: createUpload,
      args: { folder: "outage" },
      file: body,
    });
    const mutation = dispatchSession(harness.client, harness.sockets[0]!);
    acceptSession(
      harness.sockets[0]!,
      mutation,
      advertisedUploadUrl("19.outage-session"),
    );

    await eventually(() => attempts.length === 1, "the initial outage attempt");
    for (const [index, delay] of [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000].entries()) {
      const requestCount = index + 2;
      await advanceClock(harness, delay);
      await eventually(() => attempts.length === requestCount, `outage attempt ${requestCount}`);
    }

    expect(mustOk(await uploaded)).toBe(44n as FileId);
    expect(attempts).toEqual([0, 250, 750, 1_750, 3_750, 7_750, 12_750, 17_750]);
    expect(harness.sockets[0]!.frames().filter((frame) => frame.t === "m")).toHaveLength(1);
    harness.client.close();
  });

  test("allows an admitted PUT to finish after its session expires", async () => {
    let resolveUpload!: (response: Response) => void;
    let uploadSignal: AbortSignal | undefined;
    const harness = createHarness({
      fetch: (_url, init) => {
        uploadSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          resolveUpload = resolve;
        });
      },
    });
    const uploaded = harness.client.files.upload({
      createSession: createUpload,
      args: { folder: "slow" },
      file: new Uint8Array([9, 8, 7]),
    });
    const mutation = dispatchSession(harness.client, harness.sockets[0]!);
    acceptSession(
      harness.sockets[0]!,
      mutation,
      advertisedUploadUrl("20.slow-session"),
      1_000,
    );
    await eventually(() => uploadSignal !== undefined, "the admitted slow PUT");

    harness.clock.advance(2_000);
    expect(uploadSignal?.aborted).toBe(false);
    resolveUpload(Response.json({ fileId: "48" }));

    expect(mustOk(await uploaded)).toBe(48n as FileId);
    harness.client.close();
  });

  test("close promptly settles an in-flight PUT whose completion is unknown", async () => {
    let uploadSignal: AbortSignal | undefined;
    const fetcher: AckerDBFetch = (_url, init) => {
      uploadSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    };
    const { client, sockets } = createHarness({ fetch: fetcher });
    const uploaded = client.files.upload({
      createSession: createUpload,
      args: { folder: "archive" },
      file: new Uint8Array([7, 8, 9]),
    });
    const socket = sockets[0]!;
    const mutation = dispatchSession(client, socket);
    acceptSession(socket, mutation, advertisedUploadUrl("21.closing-session"));
    await eventually(() => uploadSignal !== undefined, "the upload PUT");
    expect(uploadSignal?.aborted).toBe(false);

    let result: Awaited<typeof uploaded> | undefined;
    void uploaded.then((value) => {
      result = value;
    });
    client.close();
    await eventually(() => result !== undefined, "close to settle the upload");

    expect(uploadSignal?.aborted).toBe(true);
    if (result === undefined) throw new Error("close did not settle the File upload");
    if (result.ok) throw new Error("close unexpectedly completed the File upload");
    expect(result.error).toMatchObject({
      code: "indeterminate",
      resource: "idempotency",
    });
  });

  test("a pre-aborted upload creates neither a session nor a PUT", async () => {
    let fetches = 0;
    const { client, sockets } = createHarness({
      fetch: async () => {
        fetches++;
        return Response.json({ fileId: "44" });
      },
    });
    const abort = new AbortController();
    abort.abort();

    const uploaded = client.files.upload({
      createSession: createUpload,
      args: { folder: "discarded" },
      file: new Uint8Array([10]),
      signal: abort.signal,
    });
    const socket = sockets[0]!;
    socket.welcome(client.clientSessionId);
    const mutations = socket.frames().filter((frame) => frame.t === "m");
    // Complete an incorrectly dispatched mutation so a red implementation
    // still settles and leaves no pending test work behind.
    const mutation = mutations[0];
    if (mutation?.t === "m") {
      acceptSession(socket, mutation, advertisedUploadUrl("22.should-not-exist"));
    }

    const result = await uploaded;
    expect(mutations).toHaveLength(0);
    expect(fetches).toBe(0);
    if (result.ok) throw new Error("a pre-aborted upload unexpectedly succeeded");
    expect(result.error).toMatchObject({ code: "unavailable", resource: "operation" });
    client.close();
  });

  test("an abort promptly settles while the session mutation remains pending", async () => {
    let fetches = 0;
    const { client, sockets } = createHarness({
      fetch: async () => {
        fetches++;
        return Response.json({ fileId: "45" });
      },
    });
    const abort = new AbortController();
    const uploaded = client.files.upload({
      createSession: createUpload,
      args: { folder: "canceled" },
      file: new Uint8Array([11]),
      signal: abort.signal,
    });
    const socket = sockets[0]!;
    dispatchSession(client, socket);
    abort.abort();

    let result: Awaited<typeof uploaded> | undefined;
    void uploaded.then((value) => {
      result = value;
    });
    await eventually(() => result !== undefined, "the pending session upload to abort");
    expect(fetches).toBe(0);
    if (result === undefined) throw new Error("the canceled upload did not settle");
    if (result.ok) throw new Error("the canceled upload unexpectedly succeeded");
    expect(result.error).toMatchObject({ code: "unavailable", resource: "operation" });
    client.close();
  });

  test("returns a determinate non-retryable PUT outcome without retrying", async () => {
    let fetches = 0;
    const { client, sockets } = createHarness({
      fetch: async () => {
        fetches++;
        return Response.json(
          {
            code: "validation",
            message: "File content is not accepted",
            retryable: false,
            resource: "idempotency",
          },
          { status: 422 },
        );
      },
    });
    const uploaded = client.files.upload({
      createSession: createUpload,
      args: { folder: "busy" },
      file: new Uint8Array([12]),
    });
    const socket = sockets[0]!;
    const mutation = dispatchSession(client, socket);
    acceptSession(socket, mutation, advertisedUploadUrl("23.busy-session"));

    const result = await uploaded;
    expect(fetches).toBe(1);
    if (result.ok) throw new Error("the rejected PUT unexpectedly succeeded");
    expect(result.error).toMatchObject({
      code: "validation",
      message: "File content is not accepted",
      retryable: false,
      resource: "idempotency",
    });
    client.close();
  });

  test("retries 503 and 409 outcomes on the same session and honors Retry-After", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const harness = createHarness({
      fetch: async (url, init) => {
        requests.push({ url, init });
        if (requests.length === 1) {
          return Response.json(
            {
              code: "unavailable",
              message: "File storage is temporarily unavailable",
              retryable: true,
              retryAfterMs: 750,
              resource: "idempotency",
            },
            { status: 503, headers: { "retry-after": "2" } },
          );
        }
        if (requests.length === 2) {
          return Response.json(
            {
              code: "conflict",
              message: "File upload is still completing",
              retryable: true,
              resource: "idempotency",
            },
            { status: 409, headers: { "retry-after": "1" } },
          );
        }
        return Response.json({ fileId: "47" });
      },
    });
    const body = new Uint8Array([16, 17]);
    const uploaded = harness.client.files.upload({
      createSession: createUpload,
      args: { folder: "retryable-outcomes" },
      file: body,
    });
    const socket = harness.sockets[0]!;
    const mutation = dispatchSession(harness.client, socket);
    acceptSession(socket, mutation, advertisedUploadUrl("24.outcome-session"));

    await eventually(() => requests.length === 1, "the initial 503 response");
    await eventually(
      () => harness.clock.nextDueIn() === 2_000,
      "the Retry-After delay after the 503 response",
    );
    harness.clock.advance(1_999);
    expect(requests).toHaveLength(1);
    harness.clock.advance(1);
    await eventually(() => requests.length === 2, "the 409 response");
    await eventually(
      () => harness.clock.nextDueIn() === 1_000,
      "the Retry-After delay after the 409 response",
    );
    harness.clock.advance(999);
    expect(requests).toHaveLength(2);
    harness.clock.advance(1);
    await eventually(() => requests.length === 3, "the recovered upload");

    expect(mustOk(await uploaded)).toBe(47n as FileId);
    expect(requests.map(({ url }) => url)).toEqual(Array(3).fill(
      clientUploadUrl("24.outcome-session"),
    ));
    expect(requests.every(({ init }) => init?.body === body)).toBe(true);
    expect(socket.frames().filter((frame) => frame.t === "m")).toHaveLength(1);
    harness.client.close();
  });

  test("keeps recovering malformed success responses until the session expires", async () => {
    let fetches = 0;
    const harness = createHarness({
      fetch: async () => {
        fetches++;
        return Response.json({ fileId: "not-a-file-id" });
      },
    });
    const { client, sockets } = harness;
    const uploaded = client.files.upload({
      createSession: createUpload,
      args: { folder: "malformed" },
      file: new Uint8Array([15]),
    });
    const socket = sockets[0]!;
    const mutation = dispatchSession(client, socket);
    acceptSession(
      socket,
      mutation,
      advertisedUploadUrl("25.malformed-session"),
      1_000,
    );

    await eventually(() => fetches === 1, "the first malformed upload response");
    for (const delay of [250, 500, 250]) await advanceClock(harness, delay);
    const result = await uploaded;
    expect(fetches).toBeGreaterThan(1);
    if (result.ok) throw new Error("the malformed upload response unexpectedly succeeded");
    expect(result.error).toMatchObject({ code: "indeterminate", resource: "idempotency" });
    client.close();
  });

  test("suspension marks an in-flight PUT as an indeterminate lifecycle interruption", async () => {
    let uploadSignal: AbortSignal | undefined;
    const { client, sockets, port } = createHarness({
      fetch: (_url, init) => {
        uploadSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      },
    });
    const uploaded = client.files.upload({
      createSession: createUpload,
      args: { folder: "backgrounded" },
      file: new Uint8Array([13]),
    });
    const socket = sockets[0]!;
    const mutation = dispatchSession(client, socket);
    acceptSession(socket, mutation, advertisedUploadUrl("26.suspended-session"));
    await eventually(() => uploadSignal !== undefined, "the upload PUT");
    expect(uploadSignal?.aborted).toBe(false);

    port.suspend();
    const result = await uploaded;
    if (result.ok) throw new Error("suspension unexpectedly completed the File upload");
    expect(result.error).toMatchObject({
      code: "indeterminate",
      resource: "idempotency",
      interruption: "suspension",
    });
    client.close();
  });

  test("preserves the session mutation's application error and sends no PUT", async () => {
    let fetches = 0;
    const { client, sockets } = createHarness({
      fetch: async () => {
        fetches++;
        return Response.json({ fileId: "46" });
      },
    });
    const uploaded = client.files.upload({
      createSession: createAuthorizedUpload,
      args: { organizationId: 82n },
      file: new Uint8Array([14]),
    });
    const socket = sockets[0]!;
    const mutation = dispatchSession(client, socket);
    socket.receive({
      v: ACKERDB_VERSION,
      t: "app_err",
      id: mutation.id,
      kind: "mutation",
      error: {
        kind: "application",
        code: "organization-storage-disabled",
        body: { organizationId: 82n },
        status: Status.Forbidden,
      },
      receipt: receipt(mutation),
    });

    const result = await uploaded;
    expect(fetches).toBe(0);
    if (result.ok) throw new Error("a rejected session mutation unexpectedly uploaded bytes");
    expect(result.error).toEqual({
      kind: "application",
      code: "organization-storage-disabled",
      body: { organizationId: 82n },
      status: Status.Forbidden,
    });
    client.close();
  });
});
