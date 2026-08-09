import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { actEnvironment, mountPoint } from "ackerdb-test-support/dom";
import { createBoundary } from "./support/boundary.tsx";
import { createHarness } from "./support/harness.ts";
import type { FakeSocket } from "ackerdb-test-support/client-transport";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type FileId,
  type FileUploadSession,
  type MutationRef,
} from "@ackerdb/core";
import {
  AckerDBClientError,
  type AckerDBFetch,
  type ClientResult,
} from "@ackerdb/client";
import {
  act,
  useCallback,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AckerDBProvider,
  useConnectionState,
  useFileUpload,
  type AckerDBFileUpload,
} from "@ackerdb/client-react";

const SESSION = "react-file-session";
const createUpload = {
  $ref: "api.documents.createUpload",
} as MutationRef<{ readonly folder: string }, FileUploadSession>;

type MutationRequest = Extract<ClientMessage, { readonly t: "m" }>;

function lastMutation(socket: { frames(): ClientMessage[] }): MutationRequest {
  const frame = socket.frames().findLast(
    (candidate): candidate is MutationRequest => candidate.t === "m",
  );
  if (!frame) throw new Error("No upload-session mutation frame");
  return frame;
}

function acceptSession(
  socket: FakeSocket,
  mutation: MutationRequest,
  url: string,
): void {
  socket.receive({
    v: PROTOCOL_VERSION,
    t: "ok",
    id: mutation.id,
    kind: "mutation",
    value: { url, expiresAt: 60_000, maxBytes: 1_024 },
    receipt: {
      mutationRequestId: mutation.mutationRequestId,
      commitVersion: 1n,
      durability: "production",
      replay: "executed",
      obligations: [],
    },
  });
}

function mustOk(result: ClientResult<FileId>): FileId {
  if (!result.ok) throw result.error;
  return result.data;
}

async function render(root: Root, element: ReactNode): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

beforeAll(() => actEnvironment(true));
afterAll(() => actEnvironment(false));

describe("useFileUpload", () => {
  test("keeps one callable across renders and dispatches through the current provider client", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const fetcher: AckerDBFetch = async (url, init) => {
      requests.push({ url, init });
      return Response.json({ fileId: "71" });
    };
    const harness = createHarness({ clientSessionId: SESSION, fetch: fetcher });
    const callables: AckerDBFileUpload[] = [];
    function Probe({ tick }: { readonly tick: number }): ReactNode {
      const upload = useFileUpload();
      const state = useConnectionState();
      callables.push(upload);
      return <span>{state.phase}:{tick}</span>;
    }
    const container = mountPoint();
    const root = createRoot(container);
    const app = (url: string, tick: number): ReactNode => (
      <AckerDBProvider config={harness.config({ url })}>
        <Probe tick={tick} />
      </AckerDBProvider>
    );

    await render(root, app("http://one.test", 0));
    await act(async () => harness.live().welcome(SESSION));
    await render(root, app("http://one.test", 1));
    await render(root, app("http://two.test", 2));
    await act(async () => harness.live().welcome(SESSION));

    expect(container.textContent).toBe("ready:2");
    expect(new Set(callables).size).toBe(1);
    expect(harness.sockets[0]!.closed).toBe(true);

    const result = callables[0]!({
      createSession: createUpload,
      args: { folder: "current" },
      file: new Blob(["body"]),
    });
    const current = harness.live();
    const mutation = lastMutation(current);
    expect(mutation.args).toEqual({ folder: "current" });
    acceptSession(
      current,
      mutation,
      "https://public-files.test/_files/uploads/31.current-session",
    );

    expect(mustOk(await result)).toBe(71n as FileId);
    expect(requests.map(({ url }) => url)).toEqual([
      "http://two.test/_files/uploads/31.current-session",
    ]);
    expect(harness.sockets[0]!.framesOf("m")).toHaveLength(0);

    await act(async () => root.unmount());
  });

  test("copies queued arguments and mutable bytes before the provider client arrives", async () => {
    let sentBody: BodyInit | null | undefined;
    const fetcher: AckerDBFetch = async (_url, init) => {
      sentBody = init?.body;
      return Response.json({ fileId: "72" });
    };
    const harness = createHarness({ clientSessionId: SESSION, fetch: fetcher });
    let result: Promise<ClientResult<FileId>> | undefined;
    function EarlyUpload(): ReactNode {
      const upload = useFileUpload();
      useLayoutEffect(() => {
        const args = { folder: "call-time" };
        const bytes = new Uint8Array([1, 2, 3]);
        result = upload({ createSession: createUpload, args, file: bytes });
        args.folder = "mutated";
        bytes[0] = 9;
      }, [upload]);
      return null;
    }
    const root = createRoot(mountPoint());
    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <EarlyUpload />
      </AckerDBProvider>,
    );

    const socket = harness.live();
    await act(async () => socket.welcome(SESSION));
    const mutation = lastMutation(socket);
    expect(mutation.args).toEqual({ folder: "call-time" });
    acceptSession(
      socket,
      mutation,
      "https://public-files.test/_files/uploads/32.queued-session",
    );

    expect(mustOk(await result!)).toBe(72n as FileId);
    expect(sentBody).toBeInstanceOf(Uint8Array);
    expect([...sentBody as Uint8Array]).toEqual([1, 2, 3]);

    await act(async () => root.unmount());
  });

  test("unmount settles an upload queued before client arrival without dispatching it", async () => {
    let fetches = 0;
    const harness = createHarness({
      clientSessionId: SESSION,
      fetch: async () => {
        fetches++;
        return Response.json({ fileId: "73" });
      },
    });
    let result: Promise<ClientResult<FileId>> | undefined;
    function UploadAndVanish({ vanish }: { readonly vanish: () => void }): ReactNode {
      const upload = useFileUpload();
      useLayoutEffect(() => {
        result = upload({
          createSession: createUpload,
          args: { folder: "never" },
          file: new Uint8Array([1]),
        });
        vanish();
      }, [upload, vanish]);
      return null;
    }
    function Gate(): ReactNode {
      const [mounted, setMounted] = useState(true);
      const vanish = useCallback(() => setMounted(false), []);
      return mounted ? <UploadAndVanish vanish={vanish} /> : null;
    }
    const root = createRoot(mountPoint());
    await render(
      root,
      <AckerDBProvider config={harness.config()}>
        <Gate />
      </AckerDBProvider>,
    );

    const settled = await result!;
    if (settled.ok) throw new Error("discarded upload unexpectedly succeeded");
    expect(settled.error).toBeInstanceOf(AckerDBClientError);
    expect(settled.error).toMatchObject({
      code: "unavailable",
      message: "client closed",
      retryable: false,
      resource: "operation",
    });
    await act(async () => harness.live().welcome(SESSION));
    expect(harness.frames("m")).toHaveLength(0);
    expect(fetches).toBe(0);

    await act(async () => root.unmount());
  });

  test("fails loudly outside AckerDBProvider", async () => {
    const container = mountPoint();
    const root = createRoot(container);
    const { Boundary, caught } = createBoundary();
    function Naked(): ReactNode {
      useFileUpload();
      return null;
    }

    await render(root, <Boundary><Naked /></Boundary>);
    expect(container.textContent).toBe("failed");
    expect(String(caught())).toContain(
      "useFileUpload requires a <AckerDBProvider> ancestor",
    );
    await act(async () => root.unmount());
  });
});
