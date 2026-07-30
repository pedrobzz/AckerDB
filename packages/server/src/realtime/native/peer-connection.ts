import type {
  NativeRTCDataChannelInit,
  NativeRTCDataChannelState,
  NativeRTCIceCandidate,
  NativeRTCIceCandidateInit,
  NativeRTCPeerConnectionState,
  NativeRTCSessionDescriptionInit,
  NativeRTCSignalingState,
  PortableMediaStream,
  PortableMediaStreamTrack,
  PortableRTCConfiguration,
  PortableRTCDataChannel,
  PortableRTCPeerConnection,
  PortableRTCRtpTransceiverDirection,
  PortableRTCRtpTransceiverInit,
  PortableRTCRtpReceiver,
  PortableRTCRtpCapabilities,
  PortableRTCRtpCodecCapability,
  PortableRTCRtpReceiveParameters,
  PortableRTCRtpSendParameters,
  PortableRTCRtpSender,
  PortableRTCRtpTransceiver,
  PortableRTCStats,
  PortableRTCStatsReport,
} from "@ackerdb/core";
import type { RealtimePeerLimits } from "../engine.ts";
import type { RealtimeAddressMapping } from "../network.ts";
import type { RealtimeGlobalResourceBudget } from "../resources.ts";
import type {
  NativeDataChannelBinding,
  NativeDataChannelEventBinding,
  NativeIceCandidateBinding,
  NativeMediaStreamBinding,
  NativeMediaStreamTrackBinding,
  NativePeerConnectionBinding,
  NativeRtcConfigurationBinding,
  NativeRtcEngineBinding,
  NativeRtpReceiverBinding,
  NativeRtpSenderBinding,
  NativeRtpTransceiverBinding,
  NativeTrackEventBinding,
} from "./binding.ts";

const encoder = new TextEncoder();

type NativeRTCIceGatheringState = "new" | "gathering" | "complete";
type NativeRTCIceTransportPolicy = NonNullable<
  PortableRTCConfiguration["iceTransportPolicy"]
>;

interface NativeRTCOfferOptions {
  readonly iceRestart?: boolean;
  readonly offerToReceiveAudio?: boolean;
  readonly offerToReceiveVideo?: boolean;
}

export interface RealtimeNativePeerPressure {
  readonly peerEventDrops: number;
  readonly dataChannelEventDrops: number;
}

export class NativeTrackOwner {
  private readonly tracks = new Map<bigint, ServerMediaStreamTrack>();
  private readonly releases = new Map<ServerMediaStreamTrack, () => void>();

  constructor(
    private readonly native: NativeRtcEngineBinding,
    private readonly resources: RealtimeGlobalResourceBudget,
  ) {}

  createScope(): NativeTrackScope {
    return new NativeTrackScope(this);
  }

  wrapTrack(
    track: NativeMediaStreamTrackBinding,
    scope: NativeTrackScope,
  ): ServerMediaStreamTrack {
    const key = track.identity;
    let wrapped = this.tracks.get(key);
    if (wrapped === undefined) {
      let release: () => void;
      try {
        release = this.resources.claim("tracks");
      } catch {
        throw capacityError("media track");
      }
      wrapped = new ServerMediaStreamTrack(track, this, scope);
      this.tracks.set(key, wrapped);
      this.releases.set(wrapped, release);
      try {
        scope.retain(wrapped);
      } catch (error) {
        this.tracks.delete(key);
        this.releases.delete(wrapped);
        release();
        track.stop();
        throw error;
      }
    }
    return wrapped;
  }

  senderCapabilities(
    kind: "audio" | "video",
  ): PortableRTCRtpCapabilities {
    return this.native.getRtpSenderCapabilities(kind);
  }

  receiverCapabilities(
    kind: "audio" | "video",
  ): PortableRTCRtpCapabilities {
    return this.native.getRtpReceiverCapabilities(kind);
  }

  clone(
    track: NativeMediaStreamTrackBinding,
    scope: NativeTrackScope,
  ): ServerMediaStreamTrack {
    const cloned = this.native.cloneTrack(track);
    try {
      return this.wrapTrack(cloned, scope);
    } catch (error) {
      cloned.stop();
      throw error;
    }
  }

  release(track: ServerMediaStreamTrack, scope: NativeTrackScope): void {
    const key = track.native.identity;
    if (this.tracks.get(key) === track) this.tracks.delete(key);
    scope.release(track);
    const release = this.releases.get(track);
    if (release === undefined) return;
    this.releases.delete(track);
    release();
  }
}

export class NativeTrackScope {
  private readonly tracks = new Set<ServerMediaStreamTrack>();
  private closed = false;

  constructor(private readonly owner: NativeTrackOwner) {}

  retain(track: ServerMediaStreamTrack): void {
    if (this.closed) {
      throw new DOMException("native track owner is closed", "InvalidStateError");
    }
    this.tracks.add(track);
  }

  release(track: ServerMediaStreamTrack): void {
    this.tracks.delete(track);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const track of [...this.tracks]) track.stop();
  }
}

class ServerIceCandidate {
  readonly candidate: string;
  readonly sdpMid: string;
  readonly sdpMLineIndex: number;
  readonly usernameFragment = null;

  constructor(
    candidate: NativeIceCandidateBinding,
    mappings: readonly RealtimeAddressMapping[],
  ) {
    this.candidate = rewriteCandidate(candidate.candidate, mappings);
    this.sdpMid = candidate.sdpMid;
    this.sdpMLineIndex = candidate.sdpMLineIndex;
  }

  toJSON(): NativeRTCIceCandidateInit {
    return {
      candidate: this.candidate,
      sdpMid: this.sdpMid,
      sdpMLineIndex: this.sdpMLineIndex,
      usernameFragment: null,
    };
  }
}

export class ServerMediaStreamTrack {
  private stopped = false;

  constructor(
    readonly native: NativeMediaStreamTrackBinding,
    private readonly owner: NativeTrackOwner,
    private readonly scope: NativeTrackScope,
  ) {}

  get id(): string {
    return this.native.id;
  }

  get kind(): string {
    return this.native.kind;
  }

  get label(): string {
    return this.native.id;
  }

  get muted(): boolean {
    return false;
  }

  get readyState(): "live" | "ended" {
    return this.stopped || this.native.readyState === "ended" ? "ended" : "live";
  }

  get enabled(): boolean {
    return this.native.enabled;
  }

  set enabled(value: boolean) {
    this.native.enabled = value;
  }

  clone(): PortableMediaStreamTrack {
    return this.owner.clone(this.native, this.scope);
  }

  belongsTo(owner: NativeTrackOwner): boolean {
    return this.owner === owner;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.native.stop();
    this.owner.release(this, this.scope);
  }
}

class ServerMediaStream {
  private readonly tracks: ServerMediaStreamTrack[];

  constructor(
    private readonly native: NativeMediaStreamBinding,
    private readonly owner: NativeTrackOwner,
    scope: NativeTrackScope,
  ) {
    this.tracks = [
      ...native.getAudioTracks().map((track) => owner.wrapTrack(track, scope)),
      ...native.getVideoTracks().map((track) => owner.wrapTrack(track, scope)),
    ];
  }

  get id(): string {
    return this.native.id;
  }

  get active(): boolean {
    return this.tracks.some((track) => track.readyState === "live");
  }

  addTrack(track: PortableMediaStreamTrack): void {
    const wrapped = serverTrack(track, this.owner);
    if (!this.tracks.includes(wrapped)) this.tracks.push(wrapped);
  }

  removeTrack(track: PortableMediaStreamTrack): void {
    const wrapped = serverTrack(track, this.owner);
    const index = this.tracks.indexOf(wrapped);
    if (index !== -1) this.tracks.splice(index, 1);
  }

  getTracks(): PortableMediaStreamTrack[] {
    return [...this.tracks];
  }

  getAudioTracks(): PortableMediaStreamTrack[] {
    return this.tracks.filter(
      (track) => track.kind === "audio",
    );
  }

  getVideoTracks(): PortableMediaStreamTrack[] {
    return this.tracks.filter(
      (track) => track.kind === "video",
    );
  }
}

class NativeRtpOwner {
  private readonly senders = new Map<bigint, ServerRtpSender>();
  private readonly receivers = new Map<bigint, ServerRtpReceiver>();
  private readonly transceivers = new Map<bigint, ServerRtpTransceiver>();

  constructor(
    readonly tracks: NativeTrackOwner,
    readonly scope: NativeTrackScope,
  ) {}

  sender(native: NativeRtpSenderBinding): ServerRtpSender {
    let sender = this.senders.get(native.identity);
    if (sender === undefined) {
      sender = new ServerRtpSender(native, this);
      this.senders.set(native.identity, sender);
    }
    return sender;
  }

  receiver(native: NativeRtpReceiverBinding): ServerRtpReceiver {
    let receiver = this.receivers.get(native.identity);
    if (receiver === undefined) {
      receiver = new ServerRtpReceiver(native, this);
      this.receivers.set(native.identity, receiver);
    }
    return receiver;
  }

  transceiver(native: NativeRtpTransceiverBinding): ServerRtpTransceiver {
    let transceiver = this.transceivers.get(native.identity);
    if (transceiver === undefined) {
      transceiver = new ServerRtpTransceiver(native, this);
      this.transceivers.set(native.identity, transceiver);
    }
    return transceiver;
  }

  clear(): void {
    this.senders.clear();
    this.receivers.clear();
    this.transceivers.clear();
  }
}

class ServerRtpSender {
  constructor(
    readonly native: NativeRtpSenderBinding,
    private readonly owner: NativeRtpOwner,
  ) {}

  get track(): PortableMediaStreamTrack | null {
    return this.native.track == null
      ? null
      : this.owner.tracks.wrapTrack(this.native.track, this.owner.scope);
  }

  getCapabilities(
    kind: "audio" | "video",
  ): PortableRTCRtpCapabilities {
    return this.owner.tracks.senderCapabilities(kind);
  }

  getParameters(): PortableRTCRtpSendParameters {
    return this.native.getParameters() as PortableRTCRtpSendParameters;
  }

  async getStats(): Promise<PortableRTCStatsReport> {
    return statsReport(await this.native.getStats());
  }

  async replaceTrack(track: PortableMediaStreamTrack | null): Promise<void> {
    try {
      if (track === null) {
        this.native.replaceTrack();
        return;
      }
      const wrapped = serverTrack(track, this.owner.tracks);
      this.native.replaceTrack(wrapped.native);
    } catch (cause) {
      throw nativeOperationError("RTP sender track replacement failed", cause);
    }
  }

  belongsTo(owner: NativeRtpOwner): boolean {
    return this.owner === owner;
  }

  async setParameters(
    parameters: PortableRTCRtpSendParameters,
  ): Promise<void> {
    try {
      this.native.setParameters({
        transactionId: parameters.transactionId,
        codecs: parameters.codecs.map((codec) => ({ ...codec })),
        headerExtensions: parameters.headerExtensions.map((extension) => ({
          ...extension,
        })),
        encodings: parameters.encodings.map((encoding) => ({ ...encoding })),
        rtcp: { ...parameters.rtcp },
        ...(parameters.degradationPreference === undefined
          ? {}
          : { degradationPreference: parameters.degradationPreference }),
      });
    } catch (cause) {
      const message = errorMessage(cause);
      const invalidModification = message.startsWith(
        "InvalidModificationError:",
      );
      throw new DOMException(
        `RTP sender parameters were rejected: ${message}`,
        invalidModification ? "InvalidModificationError" : "OperationError",
      );
    }
  }
}

class ServerRtpReceiver {
  constructor(
    readonly native: NativeRtpReceiverBinding,
    private readonly owner: NativeRtpOwner,
  ) {}

  get track(): PortableMediaStreamTrack {
    if (this.native.track == null) {
      throw new DOMException("RTP receiver has no track", "InvalidStateError");
    }
    return this.owner.tracks.wrapTrack(this.native.track, this.owner.scope);
  }

  getCapabilities(
    kind: "audio" | "video",
  ): PortableRTCRtpCapabilities {
    return this.owner.tracks.receiverCapabilities(kind);
  }

  getParameters(): PortableRTCRtpReceiveParameters {
    return this.native.getParameters() as PortableRTCRtpReceiveParameters;
  }

  async getStats(): Promise<PortableRTCStatsReport> {
    return statsReport(await this.native.getStats());
  }
}

class ServerRtpTransceiver {
  constructor(
    readonly native: NativeRtpTransceiverBinding,
    private readonly owner: NativeRtpOwner,
  ) {}

  get mid(): string | null {
    return this.native.mid ?? null;
  }

  get direction(): PortableRTCRtpTransceiverDirection {
    return this.native.direction as PortableRTCRtpTransceiverDirection;
  }

  set direction(value: PortableRTCRtpTransceiverDirection) {
    this.native.direction = value;
  }

  get currentDirection(): PortableRTCRtpTransceiverDirection | null {
    const direction = this.native.currentDirection;
    return direction == null
      ? null
      : direction as PortableRTCRtpTransceiverDirection;
  }

  get sender(): PortableRTCRtpSender {
    return this.owner.sender(this.native.sender);
  }

  get receiver(): PortableRTCRtpReceiver {
    return this.owner.receiver(this.native.receiver);
  }

  setCodecPreferences(
    codecs: readonly PortableRTCRtpCodecCapability[],
  ): void {
    try {
      this.native.setCodecPreferences(codecs.map((codec) => ({ ...codec })));
    } catch (cause) {
      throw nativeOperationError("RTP codec preferences were rejected", cause);
    }
  }

  stop(): void {
    this.native.stop();
  }
}

class ServerDataChannel extends EventTarget {
  binaryType = "arraybuffer";
  bufferedAmountLowThreshold = 0;
  private closeDispatched = false;

  constructor(
    private readonly native: NativeDataChannelBinding,
    private readonly options: NativeRTCDataChannelInit = {},
  ) {
    super();
    void this.pump();
  }

  get id(): number | null {
    return this.native.id < 0 ? null : this.native.id;
  }

  get label(): string {
    return this.native.label;
  }

  get ordered(): boolean {
    return this.native.ordered;
  }

  get negotiated(): boolean {
    return this.native.negotiated;
  }

  get protocol(): string {
    return this.native.protocol;
  }

  get maxPacketLifeTime(): number | null {
    return this.options.maxPacketLifeTime ?? null;
  }

  get maxRetransmits(): number | null {
    return this.options.maxRetransmits ?? null;
  }

  get readyState(): NativeRTCDataChannelState {
    return this.native.readyState as NativeRTCDataChannelState;
  }

  get bufferedAmount(): number {
    return this.native.bufferedAmount;
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof data === "string") {
      this.native.send(encoder.encode(data), false);
      return;
    }
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.native.send(bytes, true);
  }

  close(): void {
    this.native.close();
    this.dispatchClose();
  }

  private async pump(): Promise<void> {
    try {
      let event: NativeDataChannelEventBinding | null | undefined;
      while ((event = await this.native.nextEvent()) != null) {
        if (event.kind === "message" && event.data != null) {
          const data = event.binary === false
            ? new TextDecoder().decode(event.data)
            : this.binaryType === "blob"
              ? new Blob([event.data.slice().buffer as ArrayBuffer])
              : event.data.slice().buffer;
          this.dispatchEvent(new MessageEvent("message", { data }));
          continue;
        }
        if (event.kind === "bufferedamountchange") {
          if (this.native.bufferedAmount <= this.bufferedAmountLowThreshold) {
            this.dispatchEvent(new Event("bufferedamountlow"));
          }
          continue;
        }
        if (event.kind === "statechange") {
          if (event.state === "open") this.dispatchEvent(new Event("open"));
          if (event.state === "closed") this.dispatchClose();
        }
      }
    } catch {
      this.native.close();
      this.dispatchEvent(new Event("error"));
      this.dispatchClose();
    }
  }

  private dispatchClose(): void {
    if (this.closeDispatched) return;
    this.closeDispatched = true;
    this.dispatchEvent(new Event("close"));
  }
}

export class ServerPeerConnection extends EventTarget {
  private iceGatheringStateValue: NativeRTCIceGatheringState = "new";
  private dataChannels = 0;
  private readonly nativeDataChannels: NativeDataChannelBinding[] = [];
  private readonly rtpOwner: NativeRtpOwner;
  private closed = false;

  constructor(
    private readonly native: NativePeerConnectionBinding,
    private readonly owner: NativeTrackOwner,
    private readonly trackScope: NativeTrackScope,
    private readonly limits: RealtimePeerLimits,
    private readonly addressMappings: readonly RealtimeAddressMapping[],
    private readonly deploymentConfiguration: Readonly<
      NativeRtcConfigurationBinding
    >,
  ) {
    super();
    this.rtpOwner = new NativeRtpOwner(owner, trackScope);
    void this.pump();
  }

  get connectionState(): NativeRTCPeerConnectionState {
    return this.native.connectionState as NativeRTCPeerConnectionState;
  }

  get signalingState(): NativeRTCSignalingState {
    return this.native.signalingState as NativeRTCSignalingState;
  }

  get iceConnectionState() {
    return this.native.iceConnectionState;
  }

  get iceGatheringState(): NativeRTCIceGatheringState {
    return this.iceGatheringStateValue;
  }

  get localDescription(): NativeRTCSessionDescriptionInit | null {
    return localDescription(this.native.localDescription, this.addressMappings);
  }

  get currentLocalDescription(): NativeRTCSessionDescriptionInit | null {
    return localDescription(
      this.native.currentLocalDescription,
      this.addressMappings,
    );
  }

  get remoteDescription(): NativeRTCSessionDescriptionInit | null {
    return this.native.remoteDescription as NativeRTCSessionDescriptionInit ??
      null;
  }

  get currentRemoteDescription(): NativeRTCSessionDescriptionInit | null {
    return this.native.currentRemoteDescription as NativeRTCSessionDescriptionInit ??
      null;
  }

  async createOffer(
    options?: NativeRTCOfferOptions,
  ): Promise<NativeRTCSessionDescriptionInit> {
    return await this.native.createOffer(
      options,
    ) as NativeRTCSessionDescriptionInit;
  }

  async createAnswer(): Promise<NativeRTCSessionDescriptionInit> {
    return await this.native.createAnswer() as NativeRTCSessionDescriptionInit;
  }

  async setLocalDescription(
    description?: NativeRTCSessionDescriptionInit,
  ): Promise<void> {
    const value = description ?? (
      this.signalingState === "have-remote-offer"
        ? await this.createAnswer()
        : await this.createOffer()
    );
    if (value.sdp === undefined) {
      throw new TypeError("local session description requires sdp");
    }
    await this.native.setLocalDescription({ type: value.type, sdp: value.sdp });
  }

  async setRemoteDescription(
    description: NativeRTCSessionDescriptionInit,
  ): Promise<void> {
    if (description.sdp === undefined) {
      throw new TypeError("remote session description requires sdp");
    }
    await this.native.setRemoteDescription({
      type: description.type,
      sdp: description.sdp,
    });
    if (this.native.getSenders().length > this.limits.maxSenders) {
      this.close();
      throw capacityError("RTP sender");
    }
    if (
      this.native.getTransceivers().length >
        this.limits.maxTransceivers
    ) {
      this.close();
      throw capacityError("RTP transceiver");
    }
  }

  addIceCandidate(candidate?: NativeRTCIceCandidateInit | null): Promise<void> {
    if (candidate == null || candidate.candidate === undefined) {
      return this.native.addIceCandidate();
    }
    return this.native.addIceCandidate({
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? "",
      sdpMLineIndex: candidate.sdpMLineIndex ?? 0,
    });
  }

  createDataChannel(
    label: string,
    options: NativeRTCDataChannelInit = {},
  ): PortableRTCDataChannel {
    if (this.dataChannels >= this.limits.maxDataChannels) {
      throw capacityError("data channel");
    }
    this.dataChannels++;
    const native = this.native.createDataChannel(label, options);
    this.nativeDataChannels.push(native);
    return new ServerDataChannel(
      native,
      options,
    ) as unknown as PortableRTCDataChannel;
  }

  addTrack(
    track: PortableMediaStreamTrack,
    ...streams: readonly PortableMediaStream[]
  ): PortableRTCRtpSender {
    if (this.native.getSenders().length >= this.limits.maxSenders) {
      throw capacityError("RTP sender");
    }
    const wrapped = serverTrack(track, this.owner);
    const sender = this.native.addTrack(
      wrapped.native,
      streams.map((stream) => stream.id),
    );
    return this.rtpOwner.sender(sender);
  }

  removeTrack(sender: PortableRTCRtpSender): void {
    if (
      !(sender instanceof ServerRtpSender) ||
      !sender.belongsTo(this.rtpOwner)
    ) {
      throw new TypeError("sender belongs to a different WebRTC engine");
    }
    this.native.removeTrack(sender.native);
  }

  addTransceiver(
    trackOrKind: PortableMediaStreamTrack | "audio" | "video",
    init: PortableRTCRtpTransceiverInit = {},
  ): PortableRTCRtpTransceiver {
    if (this.native.getSenders().length >= this.limits.maxSenders) {
      throw capacityError("RTP sender");
    }
    if (
      this.native.getTransceivers().length >=
        this.limits.maxTransceivers
    ) {
      throw capacityError("RTP transceiver");
    }
    const streamIds = init.streams?.map((stream) => stream.id);
    const sendEncodings = init.sendEncodings?.map((encoding) => ({
      ...encoding,
    }));
    let transceiver: NativeRtpTransceiverBinding;
    if (typeof trackOrKind === "string") {
      transceiver = this.native.addTransceiverForKind(
        trackOrKind,
        init.direction,
        streamIds,
        sendEncodings,
      );
    } else {
      const track = serverTrack(trackOrKind, this.owner);
      transceiver = this.native.addTransceiver(
        track.native,
        init.direction,
        streamIds,
        sendEncodings,
      );
    }
    return this.rtpOwner.transceiver(transceiver);
  }

  getConfiguration(): PortableRTCConfiguration {
    return denormalizeConfiguration(this.native.getConfiguration());
  }

  setConfiguration(configuration: PortableRTCConfiguration = {}): void {
    this.native.setConfiguration(normalizeConfiguration(
      configuration,
      this.deploymentConfiguration,
    ));
  }

  getSenders(): PortableRTCRtpSender[] {
    return this.native.getSenders().map((sender) => this.rtpOwner.sender(sender));
  }

  getReceivers(): PortableRTCRtpReceiver[] {
    return this.native.getReceivers().map((receiver) =>
      this.rtpOwner.receiver(receiver)
    );
  }

  getTransceivers(): PortableRTCRtpTransceiver[] {
    return this.native.getTransceivers().map((transceiver) =>
      this.rtpOwner.transceiver(transceiver)
    );
  }

  async getStats(
    selector?: PortableMediaStreamTrack | null,
  ): Promise<PortableRTCStatsReport> {
    if (selector == null) {
      return statsReport(await this.native.getStats());
    }

    const track = serverTrack(selector, this.owner);
    for (const sender of this.native.getSenders()) {
      if (sameTrack(sender.track, track.native)) {
        return statsReport(await sender.getStats());
      }
    }
    for (const receiver of this.native.getReceivers()) {
      if (sameTrack(receiver.track, track.native)) {
        return statsReport(await receiver.getStats());
      }
    }
    throw new DOMException(
      "The selected track is not owned by this peer connection",
      "InvalidAccessError",
    );
  }

  restartIce(): void {
    this.native.restartIce();
  }

  operationalPressure(): RealtimeNativePeerPressure {
    return Object.freeze({
      peerEventDrops: boundedBigInt(this.native.droppedEvents),
      dataChannelEventDrops: this.nativeDataChannels.reduce(
        (total, channel) => total + boundedBigInt(channel.droppedEvents),
        0,
      ),
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const channel of this.nativeDataChannels) channel.close();
    this.nativeDataChannels.length = 0;
    this.native.close();
    this.rtpOwner.clear();
    this.trackScope.close();
    this.dispatchEvent(new Event("connectionstatechange"));
  }

  private async pump(): Promise<void> {
    try {
      let event;
      while ((event = await this.native.nextEvent()) != null) {
        switch (event.kind) {
          case "connectionstatechange":
          case "iceconnectionstatechange":
          case "negotiationneeded":
          case "signalingstatechange":
            this.dispatchEvent(new Event(event.kind));
            break;
          case "icecandidateerror":
            this.dispatchEvent(Object.assign(new Event("icecandidateerror"), {
              address: event.address ?? null,
              port: event.port ?? null,
              url: event.url ?? "",
              errorCode: event.errorCode ?? 0,
              errorText: event.errorText ?? "",
            }));
            break;
          case "icegatheringstatechange":
            this.iceGatheringStateValue =
              (event.state ?? "new") as NativeRTCIceGatheringState;
            this.dispatchEvent(new Event("icegatheringstatechange"));
            if (event.state === "complete") {
              this.dispatchEvent(Object.assign(new Event("icecandidate"), {
                candidate: null,
              }));
            }
            break;
          case "icecandidate":
            this.dispatchEvent(Object.assign(new Event("icecandidate"), {
              candidate: event.candidate == null
                ? null
                : new ServerIceCandidate(
                  event.candidate,
                  this.addressMappings,
                ) as NativeRTCIceCandidate,
            }));
            break;
          case "track": {
            const native = this.native.takeTrackEvent(requiredHandle(event.handle));
            this.dispatchEvent(trackEvent(
              native,
              this.owner,
              this.trackScope,
              this.rtpOwner,
            ));
            break;
          }
          case "datachannel": {
            if (this.dataChannels >= this.limits.maxDataChannels) {
              this.native
                .takeDataChannel(requiredHandle(event.handle))
                .close();
              this.close();
              return;
            }
            this.dataChannels++;
            const native = this.native.takeDataChannel(
              requiredHandle(event.handle),
            );
            this.nativeDataChannels.push(native);
            const channel = new ServerDataChannel(
              native,
            );
            this.dispatchEvent(Object.assign(new Event("datachannel"), {
              channel,
            }));
            break;
          }
        }
      }
    } catch {
      if (this.closed) return;
      this.close();
    }
  }
}

export function nativePeerPressure(
  peer: PortableRTCPeerConnection,
): RealtimeNativePeerPressure {
  return peer instanceof ServerPeerConnection
    ? peer.operationalPressure()
    : Object.freeze({ peerEventDrops: 0, dataChannelEventDrops: 0 });
}

function boundedBigInt(value: bigint): number {
  return Number(value > BigInt(Number.MAX_SAFE_INTEGER)
    ? BigInt(Number.MAX_SAFE_INTEGER)
    : value);
}

export function createServerPeerConnection(
  native: NativePeerConnectionBinding,
  owner: NativeTrackOwner,
  limits: RealtimePeerLimits,
  addressMappings: readonly RealtimeAddressMapping[],
  deploymentConfiguration: Readonly<NativeRtcConfigurationBinding> = {},
): PortableRTCPeerConnection {
  const trackScope = owner.createScope();
  return new ServerPeerConnection(
    native,
    owner,
    trackScope,
    limits,
    addressMappings,
    deploymentConfiguration,
  ) as unknown as PortableRTCPeerConnection;
}

export function normalizeConfiguration(
  configuration: PortableRTCConfiguration = {},
  network: Readonly<NativeRtcConfigurationBinding> = {},
): NativeRtcConfigurationBinding {
  const unsupported = [
    "bundlePolicy",
    "certificates",
    "iceCandidatePoolSize",
    "rtcpMuxPolicy",
  ] as const;
  for (const property of unsupported) {
    if (configuration[property] !== undefined) {
      throw new DOMException(
        `RTCConfiguration.${property} is not exposed by the bundled libwebrtc binding yet`,
        "NotSupportedError",
      );
    }
  }
  return {
    ...network,
    iceServers: configuration.iceServers?.map((server) => {
      if (
        server.credential !== undefined &&
        typeof server.credential !== "string"
      ) {
        throw new TypeError("WebRTC ICE server credentials must be strings");
      }
      return {
        urls: typeof server.urls === "string" ? [server.urls] : [...server.urls],
        ...(server.username === undefined ? {} : { username: server.username }),
        ...(server.credential === undefined
          ? {}
          : { credential: server.credential }),
      };
    }),
    iceTransportPolicy: configuration.iceTransportPolicy ?? "all",
  };
}

function denormalizeConfiguration(
  configuration: NativeRtcConfigurationBinding,
): PortableRTCConfiguration {
  return {
    iceServers: configuration.iceServers?.map((server) => ({
      urls: server.urls,
      ...(server.username === undefined ? {} : { username: server.username }),
      ...(server.credential === undefined
        ? {}
        : { credential: server.credential }),
    })),
    iceTransportPolicy:
      (configuration.iceTransportPolicy ?? "all") as NativeRTCIceTransportPolicy,
  };
}

function serverTrack(
  track: PortableMediaStreamTrack,
  owner: NativeTrackOwner,
): ServerMediaStreamTrack {
  if (
    !(track instanceof ServerMediaStreamTrack) ||
    !track.belongsTo(owner)
  ) {
    throw new TypeError("track belongs to a different WebRTC engine");
  }
  return track;
}

function sameTrack(
  left: NativeMediaStreamTrackBinding | null | undefined,
  right: NativeMediaStreamTrackBinding,
): boolean {
  return left?.identity === right.identity;
}

function statsReport(json: string): PortableRTCStatsReport {
  let parsed: unknown;
  try {
    parsed = json === "" ? [] : JSON.parse(json);
  } catch (cause) {
    throw new Error("libwebrtc returned malformed stats JSON", { cause });
  }
  if (!Array.isArray(parsed)) {
    throw new Error("libwebrtc stats must be an array");
  }

  const entries: [string, PortableRTCStats][] = [];
  for (const value of parsed) {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as { id?: unknown }).id !== "string" ||
      typeof (value as { type?: unknown }).type !== "string" ||
      typeof (value as { timestamp?: unknown }).timestamp !== "number"
    ) {
      throw new Error("libwebrtc returned an invalid RTCStats entry");
    }
    const stat = Object.freeze(value) as PortableRTCStats;
    entries.push([stat.id, stat]);
  }
  return new ServerRTCStatsReport(entries);
}

class ServerRTCStatsReport implements PortableRTCStatsReport {
  private readonly report: ReadonlyMap<string, PortableRTCStats>;

  constructor(entries: readonly (readonly [string, PortableRTCStats])[]) {
    this.report = new Map(entries);
  }

  get size(): number {
    return this.report.size;
  }

  get(key: string): PortableRTCStats | undefined {
    return this.report.get(key);
  }

  has(key: string): boolean {
    return this.report.has(key);
  }

  entries(): MapIterator<[string, PortableRTCStats]> {
    return this.report.entries();
  }

  keys(): MapIterator<string> {
    return this.report.keys();
  }

  values(): MapIterator<PortableRTCStats> {
    return this.report.values();
  }

  forEach(
    callback: (
      value: PortableRTCStats,
      key: string,
      map: ReadonlyMap<string, PortableRTCStats>,
    ) => void,
    thisArg?: unknown,
  ): void {
    this.report.forEach((_value, key) => {
      callback.call(thisArg, this.report.get(key)!, key, this);
    });
  }

  [Symbol.iterator](): MapIterator<[string, PortableRTCStats]> {
    return this.entries();
  }
}

function requiredHandle(handle: number | null | undefined): number {
  if (handle == null) throw new Error("native WebRTC event has no handle");
  return handle;
}

function capacityError(resource: string): DOMException {
  return new DOMException(
    `realtime ${resource} capacity is full`,
    "QuotaExceededError",
  );
}

function nativeOperationError(message: string, cause: unknown): DOMException {
  return new DOMException(`${message}: ${errorMessage(cause)}`, "OperationError");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message.slice(0, 256);
  }
  return "native libwebrtc operation failed";
}

function localDescription(
  description:
    | { readonly type: string; readonly sdp: string }
    | null
    | undefined,
  mappings: readonly RealtimeAddressMapping[],
): NativeRTCSessionDescriptionInit | null {
  if (description == null) return null;
  return {
    type: description.type as NativeRTCSessionDescriptionInit["type"],
    sdp: mappings.length === 0
      ? description.sdp
      : description.sdp
        .split("\n")
        .map((line) => {
          const carriageReturn = line.endsWith("\r") ? "\r" : "";
          const content = carriageReturn === "" ? line : line.slice(0, -1);
          return content.startsWith("a=candidate:")
            ? `a=${rewriteCandidate(content.slice(2), mappings)}${carriageReturn}`
            : line;
        })
        .join("\n"),
  };
}

function rewriteCandidate(
  candidate: string,
  mappings: readonly RealtimeAddressMapping[],
): string {
  if (mappings.length === 0) return candidate;
  const fields = candidate.split(" ");
  if (fields[6]?.toLowerCase() !== "typ" || fields[7]?.toLowerCase() !== "host") {
    return candidate;
  }
  const mapping = mappings.find(
    (candidateMapping) => candidateMapping.privateAddress === fields[4],
  );
  if (mapping === undefined) return candidate;
  fields[4] = mapping.publicAddress;
  return fields.join(" ");
}

function trackEvent(
  native: NativeTrackEventBinding,
  owner: NativeTrackOwner,
  scope: NativeTrackScope,
  rtpOwner: NativeRtpOwner,
): Event {
  return Object.assign(new Event("track"), {
    track: owner.wrapTrack(native.track, scope),
    receiver: rtpOwner.receiver(native.receiver),
    transceiver: rtpOwner.transceiver(native.transceiver),
    streams: native.streams.map((stream) =>
      new ServerMediaStream(stream, owner, scope)
    ),
  });
}
