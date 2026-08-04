import type { SubscriptionCursor } from "@ackerdb/core";
import {
  AckerDBClient,
  type AckerDBClientOptions,
  type AckerDBLifecyclePort,
} from "@ackerdb/client";
import { FakeSocket, ManualClock } from "ackerdb-test-support/client-transport";

export interface ClientHarness {
  readonly client: AckerDBClient;
  readonly clock: ManualClock;
  /** Every socket the client dialled, in order, including the closed ones. */
  readonly sockets: FakeSocket[];
  /** The live lifecycle port; throws when the suite replaced `lifecycle`. */
  readonly port: AckerDBLifecyclePort;
  /** Connection phases in the order the client published them. */
  readonly phases: string[];
  /** How many times the client stopped observing the lifecycle source. */
  stops(): number;
  /** Makes the next dial throw, standing in for a platform that refuses one. */
  failNextDial(): void;
  /** The newest socket still open; throws when the client holds none. */
  live(): FakeSocket;
}

/**
 * A client wired to doubles for everything it does not own: its clock, its
 * sockets, and its lifecycle source. Suspension, convergence, settlement, and
 * protocol suites all need exactly this, and differ only in the options they
 * override and the frames they then drive through it.
 */
export function createHarness(overrides: Partial<AckerDBClientOptions> = {}): ClientHarness {
  const clock = overrides.clock instanceof ManualClock ? overrides.clock : new ManualClock();
  const sockets: FakeSocket[] = [];
  let port: AckerDBLifecyclePort | undefined;
  let stops = 0;
  let failDials = 0;
  const client = new AckerDBClient({
    url: "http://ackerdb.test",
    credential: { kind: "anonymous" },
    clientSessionId: "test-session",
    clock,
    random: () => 0,
    createWebSocket: () => {
      if (failDials > 0) {
        failDials--;
        throw new Error("dial refused");
      }
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    lifecycle: (livePort) => {
      port = livePort;
      return () => {
        stops++;
      };
    },
    ...overrides,
  });
  const phases: string[] = [];
  client.subscribeConnectionState((state) => phases.push(state.phase));
  return {
    client,
    clock,
    sockets,
    get port(): AckerDBLifecyclePort {
      if (!port) throw new Error("the harness lifecycle source was overridden");
      return port;
    },
    phases,
    stops: () => stops,
    failNextDial: () => {
      failDials++;
    },
    live() {
      const socket = sockets.findLast((candidate) => !candidate.closed);
      if (!socket) throw new Error("no live socket");
      return socket;
    },
  };
}

/** The subscription cursor these suites converge on, at one commit version. */
export function cursor(
  commitVersion: bigint,
  generation = "generation-1",
  authEpoch = 0,
): SubscriptionCursor {
  return { generation, commitVersion, authEpoch, identity: "todos.list:{list:1}" };
}

/** Unwraps a Result the test asserts succeeded, surfacing the error if not. */
export function mustOk<T>(
  result: { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.data;
}

/** Unwraps a Result the test asserts failed. */
export function mustErr<E>(
  result: { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly error: E },
): E {
  if (result.ok) throw new Error("expected a failed Result");
  return result.error;
}
