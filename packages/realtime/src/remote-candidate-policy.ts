import { isIP } from "node:net";
import {
  stableEncode,
  type RealtimeIceCandidate,
} from "@ackerdb/core";
import { AckerDBError } from "@ackerdb/server";

const utf8 = new TextEncoder();
const CANDIDATE_TYPES = new Set(["host", "srflx", "prflx", "relay"]);

export const REMOTE_CANDIDATE_POLICY_DEFAULTS = Object.freeze({
  maxCandidates: 256,
  maxBytes: 256 * 1024,
  allowPrivateAddresses: false,
});

export interface RemoteCandidatePolicyOptions {
  readonly maxCandidates: number;
  readonly maxBytes: number;
  /** The one deployment-wide opt-in for classified RFC1918 and IPv6 ULA peers. */
  readonly allowPrivateAddresses: boolean;
}

/**
 * Classifies every remote ICE candidate before a native peer sees it. This
 * class owns generation-wide count/byte accounting and returns only the
 * candidates which may reach libwebrtc. Browser mDNS and local host
 * candidates are charged but safely omitted; malformed and non-host
 * candidates with a prohibited destination remain terminal.
 */
export class RemoteCandidatePolicy {
  private countValue = 0;
  private bytesValue = 0;

  constructor(private readonly options: RemoteCandidatePolicyOptions) {}

  get count(): number {
    return this.countValue;
  }

  get bytes(): number {
    return this.bytesValue;
  }

  acceptSdp(sdp: string): string {
    const lines = sdp.split(/\r\n|\n|\r/);
    const candidates: RealtimeIceCandidate[] = [];
    const candidateLines: number[] = [];
    for (const [index, line] of lines.entries()) {
      if (!line.startsWith("a=candidate")) continue;
      if (!line.startsWith("a=candidate:")) malformed();
      candidates.push(Object.freeze({ candidate: line.slice(2) }));
      candidateLines.push(index);
    }
    if (candidates.length === 0) return sdp;
    const admitted = this.admit(candidates);
    const ignored = new Set<number>();
    for (const [index, allowed] of admitted.entries()) {
      if (!allowed) ignored.add(candidateLines[index]!);
    }
    if (ignored.size === 0) return sdp;
    const lineEnding = sdp.match(/\r\n|\n|\r/)?.[0] ?? "\r\n";
    return lines.filter((_, index) => !ignored.has(index)).join(lineEnding);
  }

  acceptCandidate(
    candidate: RealtimeIceCandidate | null,
  ): RealtimeIceCandidate | null | undefined {
    if (candidate === null) return null;
    return this.admit([candidate])[0] ? candidate : undefined;
  }

  acceptBatch(
    candidates: readonly RealtimeIceCandidate[],
  ): readonly RealtimeIceCandidate[] {
    const admitted = this.admit(candidates);
    return Object.freeze(candidates.filter((_, index) => admitted[index]!));
  }

  private admit(candidates: readonly RealtimeIceCandidate[]): readonly boolean[] {
    const admitted = candidates.map((candidate) =>
      classify(candidate.candidate, this.options.allowPrivateAddresses)
    );
    const bytes = candidates.reduce(
      (total, candidate) => total + utf8.encode(stableEncode(candidate)).byteLength,
      0,
    );
    if (
      this.countValue + candidates.length > this.options.maxCandidates ||
      bytes > this.options.maxBytes - this.bytesValue
    ) {
      throw capacity();
    }
    this.countValue += candidates.length;
    this.bytesValue += bytes;
    return admitted;
  }
}

function malformed(): never {
  throw new AckerDBError(
    "malformed",
    "realtime remote ICE candidate is not a permitted literal address",
  );
}

function capacity(): AckerDBError {
  return new AckerDBError(
    "overloaded",
    "realtime remote ICE candidate capacity is full",
    { resource: "connection", retryable: true, retryAfterMs: 0 },
  );
}

function classify(candidate: string, allowPrivateAddresses: boolean): boolean {
  const fields = candidate.trim().split(/[ \t]+/);
  if (
    fields.length < 8 ||
    !fields[0]!.startsWith("candidate:") ||
    fields[0]!.length === "candidate:".length ||
    fields[6] !== "typ" ||
    !port(fields[5])
  ) {
    malformed();
  }
  const address = fields[4]!;
  const type = fields[7]!;
  if (!CANDIDATE_TYPES.has(type)) malformed();
  const host = type === "host";
  const family = isIP(address);
  // Do not resolve names in TypeScript. A browser mDNS host candidate has no
  // safe native equivalent, so omit it while retaining its budget charge.
  if (family === 0) return rejectAddress(host);
  if (family === 4) {
    return classifyIpv4(address, host, allowPrivateAddresses);
  } else {
    return classifyIpv6(address, host, allowPrivateAddresses);
  }
}

function port(value: string | undefined): boolean {
  if (value === undefined || !/^[0-9]+$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 65_535;
}

function classifyIpv4(
  address: string,
  host: boolean,
  allowPrivateAddresses: boolean,
): boolean {
  const octets = address.split(".").map(Number);
  const [first, second, third, fourth] = octets;
  if (
    octets.length !== 4 ||
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255) ||
    (first === 100 && second === 100 && third === 100 && fourth === 200) ||
    (first === 168 && second === 63 && third === 129 && fourth === 16) ||
    first === 0 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127)
  ) {
    return rejectAddress(host);
  }
  const privateAddress =
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
  if (!privateAddress) return true;
  return allowPrivateAddresses ? true : rejectAddress(host);
}

function classifyIpv6(
  address: string,
  host: boolean,
  allowPrivateAddresses: boolean,
): boolean {
  const words = ipv6Words(address);
  const embedded = classifyEmbeddedIpv4(words, host, allowPrivateAddresses);
  if (embedded !== undefined) return embedded;
  const allZero = words.every((word) => word === 0);
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const first = words[0]!;
  const metadata =
    words[0] === 0xfd00 &&
    words[1] === 0x0ec2 &&
    words.slice(2, 7).every((word) => word === 0) &&
    words[7] === 0x0254;
  if (
    allZero ||
    loopback ||
    metadata ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    (first & 0xffc0) === 0xfec0
  ) {
    return rejectAddress(host);
  }
  if ((first & 0xfe00) !== 0xfc00) return true;
  return allowPrivateAddresses ? true : rejectAddress(host);
}

/**
 * A literal IPv6 address can still direct native networking through an IPv4
 * transition endpoint. Every standardized encoding below is reduced to its
 * target IPv4 literal and subjected to exactly the same policy.
 */
function classifyEmbeddedIpv4(
  words: readonly number[],
  host: boolean,
  allowPrivateAddresses: boolean,
): boolean | undefined {
  if (isIpv4Compatible(words) || isIpv4Mapped(words) || isNat64WellKnown(words)) {
    return classifyIpv4(ipv4FromWords(words, 6), host, allowPrivateAddresses);
  }
  if (words[0] === 0x2002) {
    // 6to4 sends an IPv4 protocol-41 packet to its embedded gateway.
    return classifyIpv4(ipv4FromWords(words, 1), host, allowPrivateAddresses);
  }
  if (words[0] === 0x2001 && words[1] === 0) {
    // Teredo embeds both its service server and the obfuscated UDP client.
    return classifyIpv4(ipv4FromWords(words, 2), host, allowPrivateAddresses) &&
      classifyIpv4(ipv4FromWords(words, 6, true), host, allowPrivateAddresses);
  }
  return undefined;
}

function rejectAddress(host: boolean): false {
  if (!host) malformed();
  return false;
}

function isIpv4Compatible(words: readonly number[]): boolean {
  return words.slice(0, 6).every((word) => word === 0);
}

function isIpv4Mapped(words: readonly number[]): boolean {
  return words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
}

function isNat64WellKnown(words: readonly number[]): boolean {
  return words[0] === 0x0064 &&
    words[1] === 0xff9b &&
    words.slice(2, 6).every((word) => word === 0);
}

function ipv4FromWords(
  words: readonly number[],
  index: number,
  inverted = false,
): string {
  const first = (inverted ? words[index]! ^ 0xffff : words[index]!) & 0xffff;
  const second = (inverted ? words[index + 1]! ^ 0xffff : words[index + 1]!) &
    0xffff;
  return [
    String(first >> 8),
    String(first & 0xff),
    String(second >> 8),
    String(second & 0xff),
  ].join(".");
}

function ipv6Words(address: string): number[] {
  let source = address.toLowerCase();
  if (source.includes(".")) {
    const separator = source.lastIndexOf(":");
    if (separator === -1) malformed();
    const ipv4 = source.slice(separator + 1).split(".").map(Number);
    if (
      ipv4.length !== 4 ||
      ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
      malformed();
    }
    source = `${source.slice(0, separator)}:${
      ((ipv4[0]! << 8) | ipv4[1]!).toString(16)
    }:${((ipv4[2]! << 8) | ipv4[3]!).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) malformed();
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 1 || halves[1] === ""
    ? []
    : halves[1]!.split(":");
  const zeroes = 8 - left.length - right.length;
  if ((halves.length === 1 && zeroes !== 0) || (halves.length === 2 && zeroes < 1)) {
    malformed();
  }
  const values = [...left, ...new Array(zeroes).fill("0"), ...right];
  if (values.length !== 8) malformed();
  return values.map((value) => {
    if (!/^[0-9a-f]{1,4}$/.test(value)) malformed();
    return Number.parseInt(value, 16);
  });
}
