import { describe, expect, test } from "bun:test";
import type { PortableRTCStats } from "@ackerdb/core";
import { realtimePeerDiagnostic } from "../../src/realtime/diagnostics.ts";

function report(
  entries: readonly PortableRTCStats[],
): ReadonlyMap<string, PortableRTCStats> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

describe("realtimePeerDiagnostic", () => {
  test("summarizes the selected path and media health without addresses or identifiers", () => {
    const diagnostic = realtimePeerDiagnostic({
      observedAtMs: 12_345,
      connectionState: "connected",
      signalingState: "stable",
      iceGatheringState: "complete",
      report: report([
        {
          id: "transport",
          type: "transport",
          timestamp: 1,
          selectedCandidatePairId: "pair",
        },
        {
          id: "pair",
          type: "candidate-pair",
          timestamp: 1,
          state: "succeeded",
          nominated: true,
          localCandidateId: "local",
          remoteCandidateId: "remote",
          currentRoundTripTime: 0.032,
          availableIncomingBitrate: 640_000,
          availableOutgoingBitrate: 320_000,
        },
        {
          id: "local",
          type: "local-candidate",
          timestamp: 1,
          candidateType: "relay",
          protocol: "udp",
          relayProtocol: "tls",
          address: "10.0.0.1",
          port: 51_234,
        },
        {
          id: "remote",
          type: "remote-candidate",
          timestamp: 1,
          candidateType: "srflx",
          protocol: "udp",
          address: "203.0.113.10",
          port: 44_321,
        },
        {
          id: "in-audio",
          type: "inbound-rtp",
          timestamp: 1,
          kind: "audio",
          bytesReceived: 4_000,
          packetsReceived: 40,
          packetsLost: 2,
          jitter: 0.004,
          concealedSamples: 120,
        },
        {
          id: "out-audio",
          type: "outbound-rtp",
          timestamp: 1,
          kind: "audio",
          bytesSent: 3_000,
          packetsSent: 30,
        },
        {
          id: "in-video",
          type: "inbound-rtp",
          timestamp: 1,
          kind: "video",
          bytesReceived: 10_000,
          packetsReceived: 20,
          packetsLost: 1,
          jitter: 0.006,
          framesDecoded: 12,
          framesDropped: 3,
        },
      ]),
    });

    expect(diagnostic).toEqual({
      observedAtMs: 12_345,
      connectionState: "connected",
      signalingState: "stable",
      iceGatheringState: "complete",
      path: {
        localCandidateType: "relay",
        remoteCandidateType: "srflx",
        protocol: "udp",
        relayProtocol: "tls",
      },
      roundTripTimeMs: 32,
      availableIncomingBitrate: 640_000,
      availableOutgoingBitrate: 320_000,
      inbound: {
        audio: {
          bytes: 4_000,
          packets: 40,
          packetsLost: 2,
          jitterMs: 4,
          concealedSamples: 120,
        },
        video: {
          bytes: 10_000,
          packets: 20,
          packetsLost: 1,
          jitterMs: 6,
          frames: 12,
          framesDropped: 3,
        },
      },
      outbound: {
        audio: {
          bytes: 3_000,
          packets: 30,
        },
      },
    });
    expect(JSON.stringify(diagnostic)).not.toContain("10.0.0.1");
    expect(JSON.stringify(diagnostic)).not.toContain("203.0.113.10");
    expect(JSON.stringify(diagnostic)).not.toContain("transport");
  });

  test("ignores malformed optional stats instead of exposing native values", () => {
    expect(realtimePeerDiagnostic({
      observedAtMs: 1,
      connectionState: "connecting",
      signalingState: "stable",
      iceGatheringState: "gathering",
      report: report([{
        id: "in",
        type: "inbound-rtp",
        timestamp: 1,
        kind: "audio",
        bytesReceived: -1,
        packetsReceived: Number.NaN,
        jitter: "secret",
      }]),
    })).toEqual({
      observedAtMs: 1,
      connectionState: "connecting",
      signalingState: "stable",
      iceGatheringState: "gathering",
    });
  });
});
