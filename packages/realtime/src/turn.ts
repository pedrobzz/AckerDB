import { createHmac } from "node:crypto";
import type { PortableRTCConfiguration } from "@ackerdb/core";
import type { RealtimeConfigurationSource } from "./engine.ts";

const DEFAULT_TTL_SECONDS = 3_600;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 86_400;
const MIN_SECRET_BYTES = 32;

export interface RealtimeTurnOptions {
  /** coturn `turn:` or `turns:` listener URLs. */
  readonly urls: string | readonly string[];
  /** At least 32 random bytes, matching coturn's `static-auth-secret`. */
  readonly secret: string | Uint8Array;
  /** Credential lifetime. Defaults to one hour. */
  readonly ttlSeconds?: number;
  /** Optional STUN URLs returned before the TURN entry. */
  readonly stunUrls?: string | readonly string[];
  /** Use `relay` to prevent direct host/server-reflexive candidates. */
  readonly iceTransportPolicy?: "all" | "relay";
}

/**
 * Creates coturn REST credentials per authenticated WebRTC configuration
 * request. The secret never leaves the server.
 */
export function createTurnConfiguration(
  options: RealtimeTurnOptions,
  now: () => number = Date.now,
): RealtimeConfigurationSource {
  const urls = urlsOf(options.urls, ["turn:", "turns:"], "TURN");
  const stunUrls = options.stunUrls === undefined
    ? []
    : urlsOf(options.stunUrls, ["stun:", "stuns:"], "STUN");
  const secret = secretOf(options.secret);
  const ttlSeconds = integerBetween(
    options.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    MIN_TTL_SECONDS,
    MAX_TTL_SECONDS,
    "realtime.turn.ttlSeconds",
  );
  const iceTransportPolicy = options.iceTransportPolicy ?? "all";

  return (_principal, _signal, owner): PortableRTCConfiguration => {
    const timestamp = now();
    if (!Number.isFinite(timestamp) || timestamp < 0) {
      throw new TypeError("realtime TURN clock must return Unix milliseconds");
    }
    const expiresAt = Math.floor(timestamp / 1_000) + ttlSeconds;
    const username = `${expiresAt}:${owner}`;
    const credential = createHmac("sha1", secret)
      .update(username)
      .digest("base64");

    return {
      iceServers: [
        ...(stunUrls.length === 0 ? [] : [{ urls: stunUrls }]),
        { urls, username, credential },
      ],
      iceTransportPolicy,
    };
  };
}

function urlsOf(
  input: string | readonly string[],
  protocols: readonly string[],
  kind: string,
): string[] {
  const values = typeof input === "string" ? [input] : [...input];
  if (values.length === 0) {
    throw new TypeError(`realtime ${kind} URLs cannot be empty`);
  }
  for (const value of values) {
    if (!protocols.some((protocol) => value.startsWith(protocol))) {
      throw new TypeError(
        `realtime ${kind} URL must start with ${protocols.join(" or ")}`,
      );
    }
  }
  return values;
}

function secretOf(value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value.slice();
  if (bytes.byteLength === 0) {
    throw new TypeError("realtime.turn.secret cannot be empty");
  }
  if (bytes.byteLength < MIN_SECRET_BYTES) {
    throw new TypeError(
      `realtime.turn.secret must contain at least ${MIN_SECRET_BYTES} bytes`,
    );
  }
  return bytes;
}

function integerBetween(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}
