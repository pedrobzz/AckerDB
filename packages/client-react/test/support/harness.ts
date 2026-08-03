import type { ClientMessage } from "@ackerdb/core";
import type { AckerDBProviderConfig } from "@ackerdb/client-react";
import { FakeSocket, ManualClock } from "ackerdb-test-support/client-transport";

export interface ProviderHarness {
  readonly clock: ManualClock;
  /** Every socket the client opened, in order, including the closed ones. */
  readonly sockets: FakeSocket[];
  /**
   * Builds a provider config. `overrides` apply to this call only, so one
   * harness can mount providers differing in url, credential, or limits while
   * sharing a clock and socket collection. The provider keys lifetimes by
   * config *value*, so calling this inline in a render continues the current
   * lifetime instead of restarting the client.
   */
  config(overrides?: Partial<AckerDBProviderConfig>): AckerDBProviderConfig;
  /** The newest socket still open; throws when the client holds none. */
  live(): FakeSocket;
  /** Every socket still open, for suites mounting more than one provider. */
  open(): FakeSocket[];
  /** Frames of one type across every socket the harness handed out. */
  frames<T extends ClientMessage["t"]>(type: T): Extract<ClientMessage, { t: T }>[];
}

/**
 * The React hook suites all need the same thing: a provider whose client talks
 * to sockets the test writes, on a clock the test advances. Only the identity
 * of the app under test differs, so that is all `defaults` carries.
 */
export function createHarness(defaults: Partial<AckerDBProviderConfig> = {}): ProviderHarness {
  const clock = new ManualClock();
  const sockets: FakeSocket[] = [];
  return {
    clock,
    sockets,
    config(overrides = {}) {
      return {
        url: "http://react.test",
        credential: { kind: "anonymous" },
        clientSessionId: "react-session",
        clock,
        random: () => 0,
        createWebSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        ...defaults,
        ...overrides,
      };
    },
    live() {
      const socket = sockets.findLast((candidate) => !candidate.closed);
      if (!socket) throw new Error("no live socket");
      return socket;
    },
    open() {
      return sockets.filter((socket) => !socket.closed);
    },
    frames(type) {
      return sockets.flatMap((socket) => socket.framesOf(type));
    },
  };
}
