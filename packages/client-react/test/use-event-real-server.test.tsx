import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NativeWebSocket, mountPoint } from "./support/dom.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, parseClientMessage, type ClientMessage } from "@ackerdb/core";
import {
  AckerDBClient,
  type AckerDBLiveEvent,
  type AckerDBWebSocket,
  type EventRef,
} from "@ackerdb/client";
import {
  Engine,
  PRODUCTION_LIMITS,
  Registry,
  Runtime,
  v,
  defineEventTable,
  defineSchema,
  mutation,
  reconcile,
  serve,
} from "@ackerdb/server";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AckerDBProvider, useConnectionState, useEvent } from "@ackerdb/client-react";
import { until } from "ackerdb-test-support/async";

const schema = defineSchema({
  pings: defineEventTable({
    id: v.primaryKey(),
    n: v.int(),
  }, {
    args: { min: v.int() },
    access: "public",
    // n === 13 fails the match itself: the server marks the listener gapped
    // and the next matched event arrives as an honest gap instead of a row.
    matches: (row, args) => {
      if (row.n === 13) throw new Error("matcher failure for the gap fixture");
      return row.n >= args.min;
    },
  }),
});

// Public integration fixtures intentionally exercise inferred application handlers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

interface App {
  readonly base: string;
  close(): Promise<void>;
}

function createApp(): App {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-react-events-"));
  const engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  const registry = new Registry({
    pings: {
      emit: mutation({
        access: "public",
        args: { n: v.int() },
        handler: async (ctx: Ctx, args: Ctx) => {
          await ctx.db.pings.insert({ n: args.n });
          return args.n;
        },
      }),
    },
  });
  const runtime = new Runtime({ engine, registry, limits: PRODUCTION_LIMITS, telemetry: false });
  const server = serve({ runtime, port: 0 });
  return {
    base: `http://127.0.0.1:${server.port}`,
    async close() {
      await server.drain();
      engine.close("clean");
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

type PingRow = { readonly id: bigint; readonly n: number };
const pings = { $ref: "events.pings" } as EventRef<{ min: number }, PingRow>;

interface SocketRecord {
  readonly socket: WebSocket;
  readonly frames: ClientMessage[];
}

function recordingFactory(records: SocketRecord[]): (url: string) => AckerDBWebSocket {
  return (url) => {
    const socket = new NativeWebSocket(url);
    const record: SocketRecord = { socket, frames: [] };
    records.push(record);
    const send = socket.send.bind(socket);
    socket.send = ((data: string) => {
      record.frames.push(parseClientMessage(decode(data)));
      send(data);
    }) as typeof socket.send;
    return socket as unknown as AckerDBWebSocket;
  };
}

function subscriptionFrames(record: SocketRecord): ClientMessage[] {
  return record.frames.filter((frame) => frame.t === "sub" || frame.t === "unsub");
}

interface ProbeProps {
  readonly marker: string;
  readonly onEvent: (event: AckerDBLiveEvent<PingRow>) => void;
}

function Probe({ marker, onEvent }: ProbeProps): ReactNode {
  const state = useConnectionState();
  useEvent(pings, { min: 1 }, onEvent);
  return (
    <span>
      {marker}:{state.phase}
    </span>
  );
}

let app: App;
beforeAll(() => {
  app = createApp();
});
afterAll(() => app.close());

describe("useEvent against a real ackerdb server", () => {
  test("delivers reset/row/gap, survives reconnect with one fresh reset, and never replays", async () => {
    const records: SocketRecord[] = [];
    const events: AckerDBLiveEvent<PingRow>[] = [];
    const kinds = (): string[] => events.map((event) => event.kind);
    const container = mountPoint();
    const root = createRoot(container);
    const emitter = new AckerDBClient({
      url: app.base,
      credential: { kind: "anonymous" },
      createWebSocket: (url) => new NativeWebSocket(url) as unknown as AckerDBWebSocket,
    });
    const emit = async (n: number): Promise<number> => {
      const result = await emitter.mutation<{ n: number }, number, never>(
        "pings.emit",
        { n },
      );
      if (!result.ok) throw result.error;
      return result.data;
    };

    const view = (marker: string): ReactNode => (
      <StrictMode>
        <AckerDBProvider
          config={{
            url: app.base,
            credential: { kind: "anonymous" },
            // A wide reconnect window keeps "emitted while disconnected"
            // deterministic: the mutation lands well before redial.
            reconnect: { baseDelayMs: 400, maxDelayMs: 800, stableOpenMs: 10_000 },
            createWebSocket: recordingFactory(records),
          }}
        >
          <Probe marker={marker} onEvent={(event) => events.push(event)} />
        </AckerDBProvider>
      </StrictMode>
    );

    // Attach: the server's first frame for the subscription is the boundary.
    root.render(view("a"));
    await until(() => container.textContent === "a:ready", "the ready state");
    await until(() => kinds().length === 1, "the initial reset boundary");
    expect(kinds()).toEqual(["reset"]);

    expect(await emit(1)).toBe(1);
    await until(() => kinds().length === 2, "the first row");
    expect(events[1]).toMatchObject({ kind: "row", row: { n: 1 } });

    // Rerenders with fresh callback closures must not churn the subscription.
    root.render(view("b"));
    await until(() => container.textContent === "b:ready", "the rerendered marker");
    root.render(view("c"));
    await until(() => container.textContent === "c:ready", "the second rerendered marker");

    // A failed match drops that event; the next match arrives as a gap.
    expect(await emit(13)).toBe(13);
    expect(await emit(2)).toBe(2);
    await until(() => kinds().length === 3, "the gap marker");
    expect(events[2]!.kind).toBe("gap");
    expect(await emit(3)).toBe(3);
    await until(() => kinds().length === 4, "the row after the gap");
    expect(events[3]).toMatchObject({ kind: "row", row: { n: 3 } });

    // One socket so far, carrying exactly one subscribe frame despite three
    // callback identities and four deliveries.
    const openRecords = records.filter(
      (record) => record.socket.readyState === WebSocket.OPEN,
    );
    expect(openRecords).toHaveLength(1);
    expect(subscriptionFrames(openRecords[0]!)).toMatchObject([{ t: "sub", ref: "events.pings" }]);

    // Disconnect. Events published while offline are gone for good: the hook
    // must surface one fresh reset boundary and only events after it.
    const dropped = openRecords[0]!.socket;
    dropped.close();
    await until(() => container.textContent === "c:reconnecting", "the reconnecting phase");
    expect(await emit(5)).toBe(5);
    await Bun.sleep(100);
    expect(kinds()).toEqual(["reset", "row", "gap", "row"]);

    await until(() => container.textContent === "c:ready", "the reconnected ready state");
    await until(() => kinds().length === 5, "the reconnect reset boundary");
    expect(kinds()).toEqual(["reset", "row", "gap", "row", "reset"]);

    expect(await emit(6)).toBe(6);
    await until(() => kinds().length === 6, "the first live row after reconnect");
    expect(events[5]).toMatchObject({ kind: "row", row: { n: 6 } });

    // The reconnected socket re-sent the same cursor-free subscription once.
    const reconnected = records.find(
      (record) => record.socket !== dropped && record.socket.readyState === WebSocket.OPEN,
    )!;
    const resub = subscriptionFrames(reconnected);
    expect(resub).toMatchObject([{ t: "sub", ref: "events.pings" }]);
    expect((resub[0] as Extract<ClientMessage, { t: "sub" }>).cursor).toBeUndefined();

    // Unmount closes the socket; later publications reach nobody.
    root.unmount();
    await until(
      () => records.every((record) => record.socket.readyState === WebSocket.CLOSED),
      "every provider socket to close",
    );
    expect(await emit(7)).toBe(7);
    await Bun.sleep(100);
    expect(kinds()).toEqual(["reset", "row", "gap", "row", "reset", "row"]);

    emitter.close();
  }, 20_000);
});
