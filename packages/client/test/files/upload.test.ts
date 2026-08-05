import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
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
  $ref: "documents.createUpload",
} as MutationRef<{ readonly folder: string }, UploadSession>;

type UploadDenied = ApplicationError<
  "organization-storage-disabled",
  { readonly organizationId: bigint },
  typeof Status.Forbidden
>;

const createAuthorizedUpload = {
  $ref: "documents.createAuthorizedUpload",
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
): void {
  socket.receive({
    v: PROTOCOL_VERSION,
    t: "ok",
    id: mutation.id,
    kind: "mutation",
    value: { url, expiresAt: 2_000, maxBytes: 1_024 },
    receipt: receipt(mutation),
  });
}

async function eventually(predicate: () => boolean, description: string): Promise<void> {
  for (let turn = 0; turn < 100; turn++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describe("AckerDBClient files", () => {
  test("uploads a browser File through an application-created session", async () => {
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
      ref: "documents.createUpload",
      args: { folder: "contracts" },
    });
    acceptSession(socket, mutation, "https://uploads.ackerdb.test/session-secret");

    expect(mustOk(await uploaded)).toBe(42n as FileId);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    const headers = new Headers(request.init?.headers);
    expect(request.url).toBe("https://uploads.ackerdb.test/session-secret");
    expect(request.init?.method).toBe("PUT");
    expect(request.init?.body).toBe(file);
    expect(headers.get("content-type")).toBe("application/pdf");
    expect(headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%27s%202026.pdf",
    );
    expect(headers.get("authorization")).toBeNull();
    client.close();
  });

  test("retries an ambiguous transport failure against the same upload session", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const fetcher: AckerDBFetch = async (url, init) => {
      requests.push({ url, init });
      if (requests.length === 1) throw new Error("success response was lost");
      return Response.json({ fileId: "43" });
    };
    const { client, sockets } = createHarness({ fetch: fetcher });
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
    acceptSession(socket, mutation, "https://uploads.ackerdb.test/retryable-session");

    expect(mustOk(await uploaded)).toBe(43n as FileId);
    expect(requests.map(({ url }) => url)).toEqual([
      "https://uploads.ackerdb.test/retryable-session",
      "https://uploads.ackerdb.test/retryable-session",
    ]);
    expect(socket.frames().filter((frame) => frame.t === "m")).toHaveLength(1);
    const retryHeaders = new Headers(requests[1]!.init?.headers);
    expect(requests[1]!.init?.body).toBe(bytes);
    expect(retryHeaders.get("content-type")).toBe("application/octet-stream");
    expect(retryHeaders.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''report%20%28final%29.bin",
    );
    client.close();
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
    acceptSession(socket, mutation, "https://uploads.ackerdb.test/closing-session");
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
      acceptSession(socket, mutation, "https://uploads.ackerdb.test/should-not-exist");
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

  test("returns the typed server outcome from a rejected PUT without retrying", async () => {
    let fetches = 0;
    const { client, sockets } = createHarness({
      fetch: async () => {
        fetches++;
        return Response.json(
          {
            code: "overloaded",
            message: "File transfer capacity is full",
            retryable: true,
            retryAfterMs: 250,
            resource: "outbound",
          },
          { status: 503 },
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
    acceptSession(socket, mutation, "https://uploads.ackerdb.test/busy-session");

    const result = await uploaded;
    expect(fetches).toBe(1);
    if (result.ok) throw new Error("the rejected PUT unexpectedly succeeded");
    expect(result.error).toMatchObject({
      code: "overloaded",
      message: "File transfer capacity is full",
      retryable: true,
      retryAfterMs: 250,
      resource: "outbound",
    });
    client.close();
  });

  test("reports a malformed success after the same-session recovery attempt", async () => {
    let fetches = 0;
    const { client, sockets } = createHarness({
      fetch: async () => {
        fetches++;
        return Response.json({ fileId: "not-a-file-id" });
      },
    });
    const uploaded = client.files.upload({
      createSession: createUpload,
      args: { folder: "malformed" },
      file: new Uint8Array([15]),
    });
    const socket = sockets[0]!;
    const mutation = dispatchSession(client, socket);
    acceptSession(socket, mutation, "https://uploads.ackerdb.test/malformed-session");

    const result = await uploaded;
    expect(fetches).toBe(2);
    if (result.ok) throw new Error("the malformed upload response unexpectedly succeeded");
    expect(result.error).toMatchObject({ code: "malformed", resource: "idempotency" });
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
    acceptSession(socket, mutation, "https://uploads.ackerdb.test/suspended-session");
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
      v: PROTOCOL_VERSION,
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
