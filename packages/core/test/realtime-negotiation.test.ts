import { describe, expect, test } from "bun:test";
import {
  PerfectNegotiation,
  REALTIME_PROTOCOL_VERSION,
  type NativeRTCIceCandidateInit,
  type NativeRTCSessionDescriptionInit,
  type NativeRTCSignalingState,
  type PerfectNegotiationFailure,
  type RealtimeSignalFrame,
} from "../src/index.ts";

const CANDIDATE = Object.freeze({
  candidate: "candidate:1 1 UDP 1 127.0.0.1 9 typ host",
});

class FakePeer {
  signalingState: NativeRTCSignalingState = "stable";
  localDescription: NativeRTCSessionDescriptionInit | null = null;
  readonly remoteDescriptions: NativeRTCSessionDescriptionInit[] = [];
  readonly candidates: (NativeRTCIceCandidateInit | null)[] = [];
  readonly operations: string[] = [];
  offers = 0;
  offerCreated?: () => void;

  async createOffer(): Promise<NativeRTCSessionDescriptionInit> {
    this.offers++;
    const offerCreated = this.offerCreated;
    this.offerCreated = undefined;
    offerCreated?.();
    return { type: "offer", sdp: `offer-${this.offers}` };
  }

  async createAnswer(): Promise<NativeRTCSessionDescriptionInit> {
    return { type: "answer", sdp: "answer" };
  }

  async setLocalDescription(
    description: NativeRTCSessionDescriptionInit,
  ): Promise<void> {
    this.operations.push(`local:${description.type}`);
    if (description.type === "rollback") {
      this.localDescription = null;
      this.signalingState = "stable";
      return;
    }
    this.localDescription = description;
    this.signalingState = description.type === "offer"
      ? "have-local-offer"
      : "stable";
  }

  async setRemoteDescription(
    description: NativeRTCSessionDescriptionInit,
  ): Promise<void> {
    this.operations.push(`remote:${description.type}`);
    this.remoteDescriptions.push(description);
    this.signalingState = description.type === "offer"
      ? "have-remote-offer"
      : "stable";
  }

  async addIceCandidate(
    candidate?: NativeRTCIceCandidateInit | null,
  ): Promise<void> {
    this.operations.push("candidate");
    this.candidates.push(candidate ?? null);
  }
}

function fixture(options?: {
  readonly polite?: boolean;
  readonly transportReady?: boolean;
  readonly sendSignal?: (frame: RealtimeSignalFrame) => Promise<void>;
}) {
  const peer = new FakePeer();
  const sent: RealtimeSignalFrame[] = [];
  const failures: unknown[] = [];
  const negotiation = new PerfectNegotiation({
    peerConnection: peer,
    polite: options?.polite ?? true,
    signalingTransportReady: options?.transportReady ?? true,
    sendSignal: options?.sendSignal ?? (async (frame) => {
      sent.push(frame);
    }),
    createError: (failure: PerfectNegotiationFailure) => new Error(failure),
    failed: (error) => failures.push(error),
  });
  return { negotiation, peer, sent, failures };
}

const candidateFrame = (candidate = CANDIDATE): RealtimeSignalFrame => ({
  v: REALTIME_PROTOCOL_VERSION,
  t: "signal_candidate",
  candidate,
});

const offerFrame = (sdp: string): RealtimeSignalFrame => ({
  v: REALTIME_PROTOCOL_VERSION,
  t: "signal_description",
  description: { type: "offer", sdp },
});

const answerFrame = (sdp: string): RealtimeSignalFrame => ({
  v: REALTIME_PROTOCOL_VERSION,
  t: "signal_description",
  description: { type: "answer", sdp },
});

describe("PerfectNegotiation", () => {
  test("queues demand until both readiness gates and can discard initial-answer demand", async () => {
    const queued = fixture({ transportReady: false });
    queued.negotiation.negotiationNeeded();
    queued.negotiation.signalingTransportReady();
    expect(queued.peer.offers).toBe(0);
    queued.negotiation.initialNegotiationComplete();
    await queued.negotiation.receiveSignal(candidateFrame());
    expect(queued.peer.offers).toBe(1);

    const discarded = fixture();
    discarded.negotiation.negotiationNeeded();
    discarded.negotiation.initialNegotiationComplete({
      discardPendingNegotiation: true,
    });
    await discarded.negotiation.receiveSignal(candidateFrame());
    expect(discarded.peer.offers).toBe(0);
  });

  test("the initial offer clears only demand already included in that offer", async () => {
    const { negotiation, peer, sent } = fixture();
    negotiation.negotiationNeeded();
    peer.offerCreated = negotiation.negotiationNeeded;
    expect(await negotiation.createInitialOffer()).toEqual({
      type: "offer",
      sdp: "offer-1",
    });
    negotiation.initialNegotiationComplete();
    await negotiation.receiveSignal(answerFrame("initial-answer"));
    await negotiation.receiveSignal(candidateFrame());
    expect(peer.offers).toBe(2);
    expect(sent).toMatchObject([{
      t: "signal_description",
      description: { type: "offer", sdp: "offer-2" },
    }]);
  });

  test("serialized work continues after rejection and preserves signal order", async () => {
    const sent: RealtimeSignalFrame[] = [];
    let rejectFirst = true;
    const { negotiation, peer, failures } = fixture({
      sendSignal: async (frame) => {
        sent.push(frame);
        if (rejectFirst) {
          rejectFirst = false;
          throw new Error("first send failed");
        }
      },
    });
    negotiation.initialNegotiationComplete();
    expect(negotiation.sendIceCandidate(CANDIDATE)).toBe(true);
    negotiation.negotiationNeeded();
    expect(negotiation.sendIceCandidate(null)).toBe(true);
    await negotiation.receiveSignal(candidateFrame());

    expect(failures).toHaveLength(1);
    expect(peer.candidates).toEqual([CANDIDATE]);
    expect(sent.map((frame) => frame.t)).toEqual([
      "signal_candidate",
      "signal_description",
      "signal_candidate",
    ]);
  });

  test("coalesces negotiation demand and waits for stable signaling", async () => {
    const { negotiation, peer, sent } = fixture();
    negotiation.initialNegotiationComplete();

    negotiation.negotiationNeeded();
    negotiation.negotiationNeeded();
    await negotiation.receiveSignal(candidateFrame());
    expect(peer.offers).toBe(1);
    expect(peer.signalingState).toBe("have-local-offer");

    negotiation.negotiationNeeded();
    await negotiation.receiveSignal(candidateFrame());
    expect(peer.offers).toBe(1);

    await negotiation.receiveSignal(answerFrame("remote-answer"));
    await negotiation.receiveSignal(candidateFrame());
    expect(peer.offers).toBe(2);
    expect(sent.filter((frame) => frame.t === "signal_description"))
      .toHaveLength(2);
  });

  test("the polite peer rolls back a colliding local offer and answers", async () => {
    const { negotiation, peer, sent } = fixture({ polite: true });
    negotiation.initialNegotiationComplete();
    peer.signalingState = "have-local-offer";
    peer.localDescription = { type: "offer", sdp: "local" };

    await negotiation.receiveSignal(offerFrame("remote"));

    expect(peer.operations).toEqual([
      "local:rollback",
      "remote:offer",
      "local:answer",
    ]);
    expect(sent.at(-1)).toMatchObject({
      t: "signal_description",
      description: { type: "answer", sdp: "answer" },
    });
  });

  test("the impolite peer ignores a colliding offer and its candidates", async () => {
    const { negotiation, peer } = fixture({ polite: false });
    negotiation.initialNegotiationComplete();
    peer.signalingState = "have-local-offer";

    await negotiation.receiveSignal(offerFrame("ignored"));
    await negotiation.receiveSignal(candidateFrame());
    expect(peer.remoteDescriptions).toEqual([]);
    expect(peer.candidates).toEqual([]);

    peer.signalingState = "stable";
    await negotiation.receiveSignal(offerFrame("accepted"));
    await negotiation.receiveSignal(candidateFrame());
    expect(peer.remoteDescriptions).toEqual([
      { type: "offer", sdp: "accepted" },
    ]);
    expect(peer.candidates).toEqual([CANDIDATE]);
  });
});
