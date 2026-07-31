import { describe, expect, test } from "bun:test";
import { stableEncode } from "@ackerdb/core";
import { RemoteCandidatePolicy } from "../src/remote-candidate-policy.ts";

const utf8 = new TextEncoder();

function candidate(address: string, type = "host") {
  return Object.freeze({
    candidate: `candidate:1 1 UDP 2122260223 ${address} 3478 typ ${type}`,
  });
}

describe("realtime remote candidate policy", () => {
  test("accepts classified public literals and charges their canonical wire bytes", () => {
    const policy = new RemoteCandidatePolicy({
      maxCandidates: 8,
      maxBytes: 8 * 1024,
      allowPrivateAddresses: false,
    });
    const first = candidate("8.8.8.8");
    const second = candidate("2001:4860:4860::8888");

    policy.acceptSdp([
      "v=0",
      `a=${first.candidate}`,
      `a=${second.candidate}`,
      "",
    ].join("\r\n"));

    expect(policy.count).toBe(2);
    expect(policy.bytes).toBe(
      utf8.encode(stableEncode(first)).byteLength +
        utf8.encode(stableEncode(second)).byteLength,
    );
  });

  test("charges and ignores browser host candidates without resolving them", () => {
    const policy = new RemoteCandidatePolicy({
      maxCandidates: 8,
      maxBytes: 8 * 1024,
      allowPrivateAddresses: false,
    });
    const mdns = candidate("browser-opaque-id.local");
    const loopback = candidate("127.0.0.1");
    const relay = candidate("8.8.8.8", "relay");

    expect(policy.acceptBatch([mdns, loopback, relay])).toEqual([relay]);
    expect(policy.count).toBe(3);
    expect(policy.bytes).toBe(
      utf8.encode(stableEncode(mdns)).byteLength +
        utf8.encode(stableEncode(loopback)).byteLength +
        utf8.encode(stableEncode(relay)).byteLength,
    );
    expect(policy.acceptSdp([
      "v=0",
      `a=${mdns.candidate}`,
      `a=${relay.candidate}`,
      "",
    ].join("\r\n"))).toBe([
      "v=0",
      `a=${relay.candidate}`,
      "",
    ].join("\r\n"));
  });

  test("rejects malformed candidates and prohibited non-host destinations", () => {
    const values = [
      { candidate: "candidate:missing-fields" },
      candidate("8.8.8.8", "garbage"),
      candidate("relay.example.test", "relay"),
      candidate("127.0.0.1", "srflx"),
      candidate("169.254.1.1", "relay"),
      candidate("169.254.169.254", "srflx"),
      candidate("::1", "relay"),
      candidate("::ffff:169.254.169.254", "relay"),
      candidate("2002:a9fe:a9fe::1", "relay"),
      candidate("2001:0:a9fe:a9fe:0:0:f7f7:f7f7", "relay"),
    ];

    for (const value of values) {
      const policy = new RemoteCandidatePolicy({
        maxCandidates: 4,
        maxBytes: 8 * 1024,
        allowPrivateAddresses: false,
      });
      expect(() => policy.acceptBatch([value])).toThrow();
      expect(policy.count).toBe(0);
      expect(policy.bytes).toBe(0);
    }
  });

  test("allows standard IPv4-embedded transition literals only when their target is public", () => {
    const policy = new RemoteCandidatePolicy({
      maxCandidates: 8,
      maxBytes: 8 * 1024,
      allowPrivateAddresses: false,
    });

    policy.acceptBatch([
      candidate("::8.8.8.8"),
      candidate("::ffff:8.8.8.8"),
      candidate("64:ff9b::808:808"),
      candidate("2002:0808:0808::1"),
      candidate("2001:0:0808:0808:0:0:f7f7:f7f7"),
    ]);

    expect(policy.count).toBe(5);
  });

  test("ignores React Native private host candidates by default and admits them through the LAN opt-in", () => {
    const privateV4 = candidate("10.1.2.3");
    const privateV6 = candidate("fd42::123");
    const privateRelay = candidate("10.1.2.3", "relay");
    const defaultPolicy = new RemoteCandidatePolicy({
      maxCandidates: 4,
      maxBytes: 8 * 1024,
      allowPrivateAddresses: false,
    });
    expect(defaultPolicy.acceptBatch([privateV4, privateV6])).toEqual([]);
    expect(defaultPolicy.count).toBe(2);

    const permitted = new RemoteCandidatePolicy({
      maxCandidates: 4,
      maxBytes: 8 * 1024,
      allowPrivateAddresses: true,
    });
    expect(permitted.acceptBatch([privateV4, privateV6, privateRelay])).toEqual([
      privateV4,
      privateV6,
      privateRelay,
    ]);
    expect(permitted.count).toBe(3);
    expect(permitted.acceptBatch([candidate("fd00:ec2::254")])).toEqual([]);
  });

  test("fails closed and does not partially charge split batches that cross either limit", () => {
    const first = candidate("8.8.8.8");
    const second = candidate("1.1.1.1");
    const countBound = new RemoteCandidatePolicy({
      maxCandidates: 2,
      maxBytes: 8 * 1024,
      allowPrivateAddresses: false,
    });
    countBound.acceptBatch([first]);
    expect(() => countBound.acceptBatch([second, first])).toThrow(
      "candidate capacity",
    );
    expect(countBound.count).toBe(1);

    const bytes = utf8.encode(stableEncode(first)).byteLength;
    const byteBound = new RemoteCandidatePolicy({
      maxCandidates: 4,
      maxBytes: bytes * 2 - 1,
      allowPrivateAddresses: false,
    });
    byteBound.acceptBatch([first]);
    expect(() => byteBound.acceptBatch([second])).toThrow(
      "candidate capacity",
    );
    expect(byteBound.count).toBe(1);
    expect(byteBound.bytes).toBe(bytes);
  });

  test("shares one budget across initial SDP, HTTP trickle, and data-channel signaling", () => {
    const policy = new RemoteCandidatePolicy({
      maxCandidates: 2,
      maxBytes: 8 * 1024,
      allowPrivateAddresses: false,
    });
    const first = candidate("8.8.8.8");
    const second = candidate("1.1.1.1");

    policy.acceptSdp(`v=0\r\na=${first.candidate}\r\n`);
    policy.acceptBatch([second]);
    expect(() => policy.acceptCandidate(candidate("9.9.9.9"))).toThrow(
      "candidate capacity",
    );
    expect(policy.count).toBe(2);
  });

  test("rejects a mixed batch without charging its earlier valid candidate", () => {
    const policy = new RemoteCandidatePolicy({
      maxCandidates: 4,
      maxBytes: 8 * 1024,
      allowPrivateAddresses: false,
    });

    expect(() => policy.acceptBatch([
      candidate("8.8.8.8"),
      candidate("127.0.0.1", "srflx"),
    ])).toThrow("not a permitted literal address");
    expect(policy.count).toBe(0);
    expect(policy.bytes).toBe(0);
  });
});
