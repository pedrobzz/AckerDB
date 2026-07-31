import {
  REALTIME_PROTOCOL_VERSION,
  type RealtimeSignalFrame,
} from "./protocol.ts";
import type {
  RealtimeIceCandidate,
  RealtimeSessionDescription,
} from "./signaling.ts";
import type {
  NativeRTCIceCandidateInit,
  NativeRTCSessionDescriptionInit,
  NativeRTCSignalingState,
} from "./webrtc.ts";

export type PerfectNegotiationFailure =
  | "signal-before-ready"
  | "missing-initial-offer"
  | "missing-offer"
  | "missing-answer";

export interface PerfectNegotiationPeer {
  readonly signalingState: NativeRTCSignalingState;
  readonly localDescription: NativeRTCSessionDescriptionInit | null;
  addIceCandidate(candidate?: NativeRTCIceCandidateInit | null): Promise<void>;
  createAnswer(): Promise<NativeRTCSessionDescriptionInit>;
  createOffer(): Promise<NativeRTCSessionDescriptionInit>;
  setLocalDescription(description: NativeRTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: NativeRTCSessionDescriptionInit): Promise<void>;
}

export interface PerfectNegotiationOptions {
  readonly peerConnection: PerfectNegotiationPeer;
  readonly polite: boolean;
  readonly signalingTransportReady: boolean;
  readonly sendSignal: (frame: RealtimeSignalFrame) => Promise<void>;
  readonly createError: (failure: PerfectNegotiationFailure) => Error;
  readonly failed: (error: unknown) => void;
}

/**
 * Ordered post-connect WebRTC negotiation shared by the polite client and
 * impolite server. Initial HTTP offer/answer and trickle stay with callers.
 */
export class PerfectNegotiation {
  private signalingTail = Promise.resolve();
  private initialNegotiationDone = false;
  private transportReady: boolean;
  private ignoreOffer = false;
  private needsNegotiation = false;
  private negotiationScheduled = false;

  constructor(private readonly options: PerfectNegotiationOptions) {
    this.transportReady = options.signalingTransportReady;
  }

  get ready(): boolean {
    return this.initialNegotiationDone && this.transportReady;
  }

  async createInitialOffer(): Promise<
    RealtimeSessionDescription & { readonly type: "offer" }
  > {
    this.needsNegotiation = false;
    return this.createLocalDescription("offer", "missing-initial-offer");
  }

  initialNegotiationComplete(options?: {
    readonly discardPendingNegotiation?: boolean;
  }): void {
    if (this.initialNegotiationDone) return;
    if (options?.discardPendingNegotiation === true) {
      this.needsNegotiation = false;
    }
    this.initialNegotiationDone = true;
    this.flushPendingNegotiation();
  }

  readonly signalingTransportReady = (): void => {
    if (this.transportReady) return;
    this.transportReady = true;
    this.flushPendingNegotiation();
  };

  readonly negotiationNeeded = (): void => {
    this.needsNegotiation = true;
    this.flushPendingNegotiation();
  };

  sendIceCandidate(candidate: RealtimeIceCandidate | null): boolean {
    if (!this.ready) return false;
    this.run(() =>
      this.options.sendSignal({
        v: REALTIME_PROTOCOL_VERSION,
        t: "signal_candidate",
        candidate,
      })
    );
    return true;
  }

  receiveSignal(frame: RealtimeSignalFrame): Promise<void> {
    return this.sequence(async () => {
      try {
        if (!this.ready) throw this.options.createError("signal-before-ready");
        if (frame.t === "signal_candidate") {
          if (!this.ignoreOffer) {
            await this.options.peerConnection.addIceCandidate(frame.candidate);
          }
          return;
        }

        const { description } = frame;
        // Signaling is serialized, so any prior local description is settled
        // before collision state is observed here.
        const offerCollision = description.type === "offer" &&
          this.options.peerConnection.signalingState !== "stable";
        this.ignoreOffer = !this.options.polite && offerCollision;
        if (this.ignoreOffer) return;
        if (offerCollision) {
          await this.options.peerConnection.setLocalDescription({ type: "rollback" });
        }
        await this.options.peerConnection.setRemoteDescription(description);
        if (description.type === "answer") return;
        const answer = await this.createLocalDescription(
          "answer",
          "missing-answer",
        );
        await this.options.sendSignal({
          v: REALTIME_PROTOCOL_VERSION,
          t: "signal_description",
          description: answer,
        });
      } finally {
        this.flushPendingNegotiation();
      }
    });
  }

  private async createLocalDescription<Type extends "offer" | "answer">(
    type: Type,
    failure: PerfectNegotiationFailure,
  ): Promise<RealtimeSessionDescription & { readonly type: Type }> {
    const description = type === "offer"
      ? await this.options.peerConnection.createOffer()
      : await this.options.peerConnection.createAnswer();
    await this.options.peerConnection.setLocalDescription(description);
    const local = this.options.peerConnection.localDescription;
    if (local === null || local.type !== type || local.sdp === undefined) {
      throw this.options.createError(failure);
    }
    return { type, sdp: local.sdp };
  }

  private flushPendingNegotiation(): void {
    if (
      !this.ready ||
      !this.needsNegotiation ||
      this.negotiationScheduled ||
      this.options.peerConnection.signalingState !== "stable"
    ) {
      return;
    }
    this.needsNegotiation = false;
    this.negotiationScheduled = true;
    this.run(async () => {
      try {
        const description = await this.createLocalDescription(
          "offer",
          "missing-offer",
        );
        await this.options.sendSignal({
          v: REALTIME_PROTOCOL_VERSION,
          t: "signal_description",
          description,
        });
      } finally {
        this.negotiationScheduled = false;
        this.flushPendingNegotiation();
      }
    });
  }

  private run(work: () => void | Promise<void>): void {
    void this.sequence(work).catch(this.options.failed);
  }

  private sequence<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.signalingTail.then(work);
    this.signalingTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
