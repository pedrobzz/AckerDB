use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex, MutexGuard, Weak,
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    },
};

use libwebrtc::{
    MediaType,
    data_channel::{DataChannel, DataChannelInit, DataChannelState},
    media_stream::MediaStream,
    media_stream_track::{MediaStreamTrack, RtcTrackState},
    peer_connection::{
        AnswerOptions, IceCandidateError, IceConnectionState, IceGatheringState, OfferOptions,
        PeerConnection, PeerConnectionState, SignalingState, TrackEvent,
    },
    peer_connection_factory::PeerConnectionFactory,
    rtp_parameters::{
        DegradationPreference, Priority, RtpCapabilities, RtpCodecCapability,
        RtpEncodingParameters, RtpParameters,
    },
    rtp_receiver::RtpReceiver,
    rtp_sender::RtpSender,
    rtp_transceiver::{RtpTransceiver, RtpTransceiverDirection, RtpTransceiverInit},
};
use napi::bindgen_prelude::{BigInt, ClassInstance, Uint8Array};
use napi_derive::napi;

use crate::{
    queue::{BoundedQueue, GenerationQueueBudget, QueueReservation},
    types::{NativeIceCandidate, NativeRtcConfiguration, NativeSessionDescription, rtc_error},
};

const PEER_EVENT_LIMIT: usize = 256;
const PEER_EVENT_BYTES: usize = 64;
const PENDING_TRACK_BYTES: usize = 64 * 1024;
const PENDING_DATA_CHANNEL_BYTES: usize = 64 * 1024;
const DATA_CHANNEL_EVENT_LIMIT: usize = 512;
const DATA_CHANNEL_EVENT_BYTES: usize = 64;
const DATA_CHANNEL_BUFFER_LIMIT: usize = 4 * 1024 * 1024;
const DATA_CHANNEL_OUTBOUND_LIMIT: usize = 512;
const DATA_CHANNEL_SEND_OVERHEAD_BYTES: usize = 64;

#[napi(object)]
#[derive(Clone, Debug, Default)]
pub struct NativeOfferOptions {
    pub ice_restart: Option<bool>,
    pub offer_to_receive_audio: Option<bool>,
    pub offer_to_receive_video: Option<bool>,
}

#[napi(object)]
#[derive(Clone, Debug, Default)]
pub struct NativeRtpEncodingParameters {
    pub active: Option<bool>,
    pub max_bitrate: Option<f64>,
    pub max_framerate: Option<f64>,
    pub priority: Option<String>,
    pub rid: Option<String>,
    pub scale_resolution_down_by: Option<f64>,
    pub scalability_mode: Option<String>,
    pub ssrc: Option<u32>,
}

#[napi(object)]
#[derive(Clone, Debug, PartialEq)]
pub struct NativeRtpCodecParameters {
    pub payload_type: u32,
    pub mime_type: String,
    pub clock_rate: f64,
    pub channels: Option<u32>,
}

#[napi(object)]
#[derive(Clone, Debug, PartialEq)]
pub struct NativeRtpHeaderExtensionParameters {
    pub uri: String,
    pub id: i32,
    pub encrypted: Option<bool>,
}

#[napi(object)]
#[derive(Clone, Debug, PartialEq)]
pub struct NativeRtcpParameters {
    pub cname: Option<String>,
    pub reduced_size: Option<bool>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct NativeRtpParameters {
    pub transaction_id: String,
    pub codecs: Vec<NativeRtpCodecParameters>,
    pub header_extensions: Vec<NativeRtpHeaderExtensionParameters>,
    pub encodings: Vec<NativeRtpEncodingParameters>,
    pub rtcp: NativeRtcpParameters,
    pub degradation_preference: Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct NativeRtpCodecCapability {
    pub mime_type: String,
    pub clock_rate: f64,
    pub channels: Option<u32>,
    pub sdp_fmtp_line: Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct NativeRtpHeaderExtensionCapability {
    pub uri: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct NativeRtpCapabilities {
    pub codecs: Vec<NativeRtpCodecCapability>,
    pub header_extensions: Vec<NativeRtpHeaderExtensionCapability>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct NativeDataChannelOptions {
    pub ordered: Option<bool>,
    pub max_packet_life_time: Option<i32>,
    pub max_retransmits: Option<i32>,
    pub protocol: Option<String>,
    pub negotiated: Option<bool>,
    pub id: Option<i32>,
}

impl Default for NativeDataChannelOptions {
    fn default() -> Self {
        Self {
            ordered: Some(true),
            max_packet_life_time: None,
            max_retransmits: None,
            protocol: Some(String::new()),
            negotiated: Some(false),
            id: Some(-1),
        }
    }
}

impl NativeDataChannelOptions {
    fn to_rtc(&self) -> DataChannelInit {
        DataChannelInit {
            ordered: self.ordered.unwrap_or(true),
            max_retransmit_time: self.max_packet_life_time,
            max_retransmits: self.max_retransmits,
            protocol: self.protocol.clone().unwrap_or_default(),
            negotiated: self.negotiated.unwrap_or(false),
            id: self.id.unwrap_or(-1),
            priority: None,
        }
    }
}

enum PeerEvent {
    ConnectionState(String),
    IceCandidate(NativeIceCandidate),
    IceCandidateError(IceCandidateError),
    IceConnectionState(String),
    IceGatheringState(String),
    NegotiationNeeded,
    SignalingState(String),
    Track(u32),
    DataChannel(u32),
}

impl PeerEvent {
    fn retained_bytes(&self) -> usize {
        match self {
            Self::IceCandidate(candidate) => PEER_EVENT_BYTES
                .saturating_add(candidate.candidate.len())
                .saturating_add(candidate.sdp_mid.len()),
            Self::IceCandidateError(error) => PEER_EVENT_BYTES
                .saturating_add(error.address.len())
                .saturating_add(error.url.len())
                .saturating_add(error.error_text.len()),
            _ => PEER_EVENT_BYTES,
        }
    }

    fn enqueue(self, events: &BoundedQueue<Self>) -> bool {
        let retained_bytes = self.retained_bytes();
        events.push_weighted_with(1, retained_bytes, || self)
    }
}

#[napi(object)]
pub struct NativePeerEvent {
    pub kind: String,
    pub state: Option<String>,
    pub candidate: Option<NativeIceCandidate>,
    pub handle: Option<u32>,
    pub address: Option<String>,
    pub port: Option<i32>,
    pub url: Option<String>,
    pub error_code: Option<i32>,
    pub error_text: Option<String>,
}

struct Pending<T> {
    value: T,
    _reservation: QueueReservation,
}

struct PeerPending {
    next: AtomicU32,
    tracks: Mutex<HashMap<u32, Pending<TrackEvent>>>,
    data_channels: Mutex<HashMap<u32, Pending<DataChannel>>>,
}

impl PeerPending {
    fn new() -> Self {
        Self {
            next: AtomicU32::new(1),
            tracks: Mutex::new(HashMap::new()),
            data_channels: Mutex::new(HashMap::new()),
        }
    }

    fn id(&self) -> u32 {
        self.next.fetch_add(1, Ordering::Relaxed)
    }

    fn clear(&self) {
        lock(&self.tracks).clear();
        lock(&self.data_channels).clear();
    }
}

#[napi]
pub struct NativePeerConnection {
    peer: Mutex<Option<PeerConnection>>,
    configuration: Mutex<NativeRtcConfiguration>,
    local_description: Mutex<Option<NativeSessionDescription>>,
    remote_description: Mutex<Option<NativeSessionDescription>>,
    events: Arc<BoundedQueue<PeerEvent>>,
    budget: Mutex<Option<GenerationQueueBudget>>,
    pending: Arc<PeerPending>,
    data_channel_queues: Arc<Mutex<Vec<Weak<BoundedQueue<DataChannelEvent>>>>>,
    closed: Arc<AtomicBool>,
}

impl NativePeerConnection {
    pub fn new(
        factory: PeerConnectionFactory,
        configuration: NativeRtcConfiguration,
        budget: GenerationQueueBudget,
    ) -> napi::Result<Self> {
        let peer = factory
            .create_peer_connection(configuration.to_rtc()?)
            .map_err(rtc_error)?;
        let events = Arc::new(BoundedQueue::new(PEER_EVENT_LIMIT, budget.clone()));
        let pending = Arc::new(PeerPending::new());
        let data_channel_queues = Arc::new(Mutex::new(Vec::new()));
        let closed = Arc::new(AtomicBool::new(false));

        {
            let events = events.clone();
            peer.on_connection_state_change(Some(Box::new(move |state| {
                PeerEvent::ConnectionState(connection_state(state)).enqueue(&events);
            })));
        }
        {
            let events = events.clone();
            peer.on_ice_candidate(Some(Box::new(move |candidate| {
                PeerEvent::IceCandidate(candidate.into()).enqueue(&events);
            })));
        }
        {
            let events = events.clone();
            peer.on_ice_candidate_error(Some(Box::new(move |error| {
                PeerEvent::IceCandidateError(error).enqueue(&events);
            })));
        }
        {
            let events = events.clone();
            peer.on_ice_connection_state_change(Some(Box::new(move |state| {
                PeerEvent::IceConnectionState(ice_connection_state(state)).enqueue(&events);
            })));
        }
        {
            let events = events.clone();
            peer.on_ice_gathering_state_change(Some(Box::new(move |state| {
                PeerEvent::IceGatheringState(ice_gathering_state(state)).enqueue(&events);
            })));
        }
        {
            let events = events.clone();
            peer.on_negotiation_needed(Some(Box::new(move |_| {
                PeerEvent::NegotiationNeeded.enqueue(&events);
            })));
        }
        {
            let events = events.clone();
            peer.on_signaling_state_change(Some(Box::new(move |state| {
                PeerEvent::SignalingState(signaling_state(state)).enqueue(&events);
            })));
        }
        {
            let events = events.clone();
            let pending = pending.clone();
            let budget = budget.clone();
            peer.on_track(Some(Box::new(move |event| {
                let reservation = match budget.reserve(PENDING_TRACK_BYTES) {
                    Ok(reservation) => reservation,
                    Err(saturation) => {
                        events.saturate(saturation);
                        return;
                    }
                };
                let id = pending.id();
                lock(&pending.tracks).insert(
                    id,
                    Pending {
                        value: event,
                        _reservation: reservation,
                    },
                );
                if !PeerEvent::Track(id).enqueue(&events) {
                    lock(&pending.tracks).remove(&id);
                }
            })));
        }
        {
            let events = events.clone();
            let pending = pending.clone();
            let budget = budget.clone();
            peer.on_data_channel(Some(Box::new(move |channel| {
                let reservation = match budget.reserve(PENDING_DATA_CHANNEL_BYTES) {
                    Ok(reservation) => reservation,
                    Err(saturation) => {
                        events.saturate(saturation);
                        return;
                    }
                };
                let id = pending.id();
                lock(&pending.data_channels).insert(
                    id,
                    Pending {
                        value: channel,
                        _reservation: reservation,
                    },
                );
                if !PeerEvent::DataChannel(id).enqueue(&events) {
                    lock(&pending.data_channels).remove(&id);
                }
            })));
        }

        Ok(Self {
            peer: Mutex::new(Some(peer)),
            configuration: Mutex::new(configuration),
            local_description: Mutex::new(None),
            remote_description: Mutex::new(None),
            events,
            budget: Mutex::new(Some(budget)),
            pending,
            data_channel_queues,
            closed,
        })
    }

    fn peer(&self) -> napi::Result<PeerConnection> {
        lock(&self.peer)
            .clone()
            .ok_or_else(|| napi::Error::from_reason("peer connection is closed"))
    }

    fn budget(&self) -> napi::Result<GenerationQueueBudget> {
        lock(&self.budget)
            .clone()
            .ok_or_else(|| napi::Error::from_reason("peer connection is closed"))
    }
}

#[napi]
impl NativePeerConnection {
    #[napi(getter)]
    pub fn dropped_events(&self) -> BigInt {
        self.events.dropped().into()
    }

    #[napi(getter)]
    pub fn queue_terminal_reason(&self) -> Option<String> {
        self.events.terminal_reason().map(str::to_owned)
    }

    #[napi(getter)]
    pub fn connection_state(&self) -> String {
        lock(&self.peer)
            .as_ref()
            .map(|peer| connection_state(peer.connection_state()))
            .unwrap_or_else(|| "closed".into())
    }

    #[napi(getter)]
    pub fn signaling_state(&self) -> String {
        lock(&self.peer)
            .as_ref()
            .map(|peer| signaling_state(peer.signaling_state()))
            .unwrap_or_else(|| "closed".into())
    }

    #[napi(getter)]
    pub fn ice_connection_state(&self) -> String {
        lock(&self.peer)
            .as_ref()
            .map(|peer| ice_connection_state(peer.ice_connection_state()))
            .unwrap_or_else(|| "closed".into())
    }

    #[napi(getter)]
    pub fn local_description(&self) -> Option<NativeSessionDescription> {
        lock(&self.local_description).clone()
    }

    #[napi(getter)]
    pub fn remote_description(&self) -> Option<NativeSessionDescription> {
        lock(&self.remote_description).clone()
    }

    #[napi(getter)]
    pub fn current_local_description(&self) -> Option<NativeSessionDescription> {
        lock(&self.peer)
            .as_ref()
            .and_then(|peer| peer.current_local_description())
            .map(Into::into)
            .or_else(|| lock(&self.local_description).clone())
    }

    #[napi(getter)]
    pub fn current_remote_description(&self) -> Option<NativeSessionDescription> {
        lock(&self.peer)
            .as_ref()
            .and_then(|peer| peer.current_remote_description())
            .map(Into::into)
            .or_else(|| lock(&self.remote_description).clone())
    }

    #[napi]
    pub fn get_configuration(&self) -> NativeRtcConfiguration {
        lock(&self.configuration).clone()
    }

    #[napi]
    pub fn set_configuration(&self, configuration: NativeRtcConfiguration) -> napi::Result<()> {
        self.peer()?
            .set_configuration(configuration.to_rtc()?)
            .map_err(rtc_error)?;
        *lock(&self.configuration) = configuration;
        Ok(())
    }

    #[napi]
    pub async fn create_offer(
        &self,
        options: Option<NativeOfferOptions>,
    ) -> napi::Result<NativeSessionDescription> {
        let options = options.unwrap_or_default();
        self.peer()?
            .create_offer(OfferOptions {
                ice_restart: options.ice_restart.unwrap_or(false),
                offer_to_receive_audio: options.offer_to_receive_audio.unwrap_or(false),
                offer_to_receive_video: options.offer_to_receive_video.unwrap_or(false),
            })
            .await
            .map(Into::into)
            .map_err(rtc_error)
    }

    #[napi]
    pub async fn create_answer(&self) -> napi::Result<NativeSessionDescription> {
        self.peer()?
            .create_answer(AnswerOptions::default())
            .await
            .map(Into::into)
            .map_err(rtc_error)
    }

    #[napi]
    pub async fn set_local_description(
        &self,
        description: NativeSessionDescription,
    ) -> napi::Result<()> {
        self.peer()?
            .set_local_description(description.clone().parse()?)
            .await
            .map_err(rtc_error)?;
        *lock(&self.local_description) = Some(description);
        Ok(())
    }

    #[napi]
    pub async fn set_remote_description(
        &self,
        description: NativeSessionDescription,
    ) -> napi::Result<()> {
        self.peer()?
            .set_remote_description(description.clone().parse()?)
            .await
            .map_err(rtc_error)?;
        *lock(&self.remote_description) = Some(description);
        Ok(())
    }

    #[napi]
    pub async fn add_ice_candidate(
        &self,
        candidate: Option<NativeIceCandidate>,
    ) -> napi::Result<()> {
        let Some(candidate) = candidate else {
            return Ok(());
        };
        self.peer()?
            .add_ice_candidate(candidate.parse()?)
            .await
            .map_err(rtc_error)
    }

    #[napi]
    pub fn create_data_channel(
        &self,
        label: String,
        options: Option<NativeDataChannelOptions>,
    ) -> napi::Result<NativeDataChannel> {
        let options = options.unwrap_or_default();
        let channel = self
            .peer()?
            .create_data_channel(&label, options.to_rtc())
            .map_err(rtc_error)?;
        Ok(NativeDataChannel::new(
            channel,
            options,
            self.budget()?,
            self.data_channel_queues.clone(),
        ))
    }

    #[napi]
    pub fn add_track(
        &self,
        track: ClassInstance<'_, NativeMediaStreamTrack>,
        stream_ids: Vec<String>,
    ) -> napi::Result<NativeRtpSender> {
        self.peer()?
            .add_track(track.media_track()?, &stream_ids)
            .map(NativeRtpSender::new)
            .map_err(rtc_error)
    }

    #[napi]
    pub fn remove_track(&self, sender: ClassInstance<'_, NativeRtpSender>) -> napi::Result<()> {
        self.peer()?
            .remove_track(sender.sender.clone())
            .map_err(rtc_error)
    }

    #[napi]
    pub fn add_transceiver(
        &self,
        track_or_kind: ClassInstance<'_, NativeMediaStreamTrack>,
        direction: Option<String>,
        stream_ids: Option<Vec<String>>,
        send_encodings: Option<Vec<NativeRtpEncodingParameters>>,
    ) -> napi::Result<NativeRtpTransceiver> {
        self.peer()?
            .add_transceiver(
                track_or_kind.media_track()?,
                transceiver_init(direction, stream_ids, send_encodings)?,
            )
            .map(|transceiver| NativeRtpTransceiver { transceiver })
            .map_err(rtc_error)
    }

    #[napi]
    pub fn add_transceiver_for_kind(
        &self,
        kind: String,
        direction: Option<String>,
        stream_ids: Option<Vec<String>>,
        send_encodings: Option<Vec<NativeRtpEncodingParameters>>,
    ) -> napi::Result<NativeRtpTransceiver> {
        let media_type = match kind.as_str() {
            "audio" => MediaType::Audio,
            "video" => MediaType::Video,
            _ => return Err(napi::Error::from_reason("kind must be audio or video")),
        };
        self.peer()?
            .add_transceiver_for_media(
                media_type,
                transceiver_init(direction, stream_ids, send_encodings)?,
            )
            .map(|transceiver| NativeRtpTransceiver { transceiver })
            .map_err(rtc_error)
    }

    #[napi]
    pub fn get_senders(&self) -> Vec<NativeRtpSender> {
        lock(&self.peer)
            .as_ref()
            .map(PeerConnection::senders)
            .unwrap_or_default()
            .into_iter()
            .map(NativeRtpSender::new)
            .collect()
    }

    #[napi]
    pub fn get_receivers(&self) -> Vec<NativeRtpReceiver> {
        lock(&self.peer)
            .as_ref()
            .map(PeerConnection::receivers)
            .unwrap_or_default()
            .into_iter()
            .map(|receiver| NativeRtpReceiver { receiver })
            .collect()
    }

    #[napi]
    pub fn get_transceivers(&self) -> Vec<NativeRtpTransceiver> {
        lock(&self.peer)
            .as_ref()
            .map(PeerConnection::transceivers)
            .unwrap_or_default()
            .into_iter()
            .map(|transceiver| NativeRtpTransceiver { transceiver })
            .collect()
    }

    #[napi]
    pub fn restart_ice(&self) -> napi::Result<()> {
        self.peer()?.restart_ice();
        Ok(())
    }

    #[napi]
    pub async fn get_stats(&self) -> napi::Result<String> {
        self.peer()?.get_stats_json().await.map_err(rtc_error)
    }

    #[napi]
    pub async fn next_event(&self) -> napi::Result<Option<NativePeerEvent>> {
        self.events
            .next()
            .await
            .map(|event| event.map(|event| event.map(native_peer_event)))
            .map_err(napi::Error::from_reason)
    }

    #[napi]
    pub fn take_track_event(&self, handle: u32) -> napi::Result<NativeTrackEvent> {
        lock(&self.pending.tracks)
            .remove(&handle)
            .map(|pending| NativeTrackEvent {
                event: pending.value,
            })
            .ok_or_else(|| napi::Error::from_reason("unknown native track event"))
    }

    #[napi]
    pub fn take_data_channel(&self, handle: u32) -> napi::Result<NativeDataChannel> {
        let budget = self.budget()?;
        lock(&self.pending.data_channels)
            .remove(&handle)
            .map(|pending| {
                NativeDataChannel::new(
                    pending.value,
                    NativeDataChannelOptions::default(),
                    budget,
                    self.data_channel_queues.clone(),
                )
            })
            .ok_or_else(|| napi::Error::from_reason("unknown native data channel"))
    }

    #[napi]
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(peer) = lock(&self.peer).take() {
            peer.close();
        }
        self.events.close();
        self.pending.clear();
        for queue in lock(&self.data_channel_queues).drain(..) {
            if let Some(queue) = queue.upgrade() {
                queue.close();
            }
        }
        lock(&self.budget).take();
    }
}

impl Drop for NativePeerConnection {
    fn drop(&mut self) {
        self.close();
    }
}

enum DataChannelEvent {
    State(String),
    Message(Vec<u8>, bool),
    BufferedAmount,
}

impl DataChannelEvent {
    fn retained_bytes(&self) -> usize {
        match self {
            Self::Message(data, _) => DATA_CHANNEL_EVENT_BYTES.saturating_add(data.len()),
            Self::State(_) | Self::BufferedAmount => DATA_CHANNEL_EVENT_BYTES,
        }
    }

    fn enqueue(self, events: &BoundedQueue<Self>) -> bool {
        let weight = match &self {
            Self::Message(data, _) => data.len().max(1),
            Self::State(_) | Self::BufferedAmount => 1,
        };
        let retained_bytes = self.retained_bytes();
        events.push_weighted_with(weight, retained_bytes, || self)
    }
}

struct OutboundMessage {
    id: u64,
    remaining: u64,
    _reservation: QueueReservation,
}

#[napi(object)]
pub struct NativeDataChannelEvent {
    pub kind: String,
    pub state: Option<String>,
    pub data: Option<Uint8Array>,
    pub binary: Option<bool>,
}

#[napi]
pub struct NativeDataChannel {
    channel: Mutex<Option<DataChannel>>,
    id: i32,
    label: String,
    options: NativeDataChannelOptions,
    events: Arc<BoundedQueue<DataChannelEvent>>,
    budget: Arc<Mutex<Option<GenerationQueueBudget>>>,
    outbound: Arc<Mutex<VecDeque<OutboundMessage>>>,
    next_send: AtomicU64,
    closed: Arc<AtomicBool>,
}

impl NativeDataChannel {
    fn new(
        channel: DataChannel,
        options: NativeDataChannelOptions,
        budget: GenerationQueueBudget,
        data_channel_queues: Arc<Mutex<Vec<Weak<BoundedQueue<DataChannelEvent>>>>>,
    ) -> Self {
        let id = channel.id();
        let label = channel.label();
        let events = Arc::new(BoundedQueue::with_weight_limit(
            DATA_CHANNEL_EVENT_LIMIT,
            DATA_CHANNEL_BUFFER_LIMIT,
            budget.clone(),
        ));
        let budget = Arc::new(Mutex::new(Some(budget)));
        let outbound = Arc::new(Mutex::new(VecDeque::new()));
        let closed = Arc::new(AtomicBool::new(false));
        lock(&data_channel_queues).push(Arc::downgrade(&events));
        {
            let events = events.clone();
            let outbound = outbound.clone();
            let budget = budget.clone();
            channel.on_state_change(Some(Box::new(move |state| {
                let state = data_channel_state(state);
                if state == "closed" {
                    lock(&outbound).clear();
                    lock(&budget).take();
                }
                DataChannelEvent::State(state).enqueue(&events);
            })));
        }
        {
            let events = events.clone();
            channel.on_message(Some(Box::new(move |message| {
                DataChannelEvent::Message(message.data.to_vec(), message.binary).enqueue(&events);
            })));
        }
        {
            let events = events.clone();
            let outbound = outbound.clone();
            channel.on_buffered_amount_change(Some(Box::new(move |sent_bytes| {
                release_outbound_bytes(&outbound, sent_bytes);
                DataChannelEvent::BufferedAmount.enqueue(&events);
            })));
        }
        Self {
            channel: Mutex::new(Some(channel)),
            id,
            label,
            options,
            events,
            budget,
            outbound,
            next_send: AtomicU64::new(1),
            closed,
        }
    }

    fn channel(&self) -> napi::Result<DataChannel> {
        lock(&self.channel)
            .clone()
            .ok_or_else(|| napi::Error::from_reason("data channel is closed"))
    }

    fn budget(&self) -> napi::Result<GenerationQueueBudget> {
        lock(&self.budget)
            .clone()
            .ok_or_else(|| napi::Error::from_reason("data channel is closed"))
    }
}

#[napi]
impl NativeDataChannel {
    #[napi(getter)]
    pub fn dropped_events(&self) -> BigInt {
        self.events.dropped().into()
    }

    #[napi(getter)]
    pub fn queue_terminal_reason(&self) -> Option<String> {
        self.events.terminal_reason().map(str::to_owned)
    }

    #[napi(getter)]
    pub fn id(&self) -> i32 {
        self.id
    }

    #[napi(getter)]
    pub fn label(&self) -> String {
        self.label.clone()
    }

    #[napi(getter)]
    pub fn ready_state(&self) -> String {
        lock(&self.channel)
            .as_ref()
            .map(|channel| data_channel_state(channel.state()))
            .unwrap_or_else(|| "closed".into())
    }

    #[napi(getter)]
    pub fn buffered_amount(&self) -> f64 {
        lock(&self.channel)
            .as_ref()
            .map(|channel| channel.buffered_amount() as f64)
            .unwrap_or(0.0)
    }

    #[napi(getter)]
    pub fn ordered(&self) -> bool {
        self.options.ordered.unwrap_or(true)
    }

    #[napi(getter)]
    pub fn negotiated(&self) -> bool {
        self.options.negotiated.unwrap_or(false)
    }

    #[napi(getter)]
    pub fn protocol(&self) -> String {
        self.options.protocol.clone().unwrap_or_default()
    }

    #[napi]
    pub fn send(&self, data: Uint8Array, binary: bool) -> napi::Result<()> {
        let channel = self.channel()?;
        if outbound_item_limit_reached(lock(&self.outbound).len()) {
            self.events.saturate_item_limit();
            self.close();
            return Err(napi::Error::from_reason(
                "native WebRTC data channel outbound queue exceeded its item limit",
            ));
        }
        let bytes = data.len();
        let retained_bytes = bytes.saturating_add(DATA_CHANNEL_SEND_OVERHEAD_BYTES);
        let reservation = match self.budget()?.reserve(retained_bytes) {
            Ok(reservation) => reservation,
            Err(saturation) => {
                self.events.saturate(saturation);
                self.close();
                return Err(napi::Error::from_reason(
                    "native WebRTC queue byte budget is saturated",
                ));
            }
        };
        let id = self.next_send.fetch_add(1, Ordering::Relaxed);
        lock(&self.outbound).push_back(OutboundMessage {
            id,
            remaining: bytes as u64,
            _reservation: reservation,
        });
        match channel.send(data.as_ref(), binary) {
            Ok(()) => Ok(()),
            Err(error) => {
                remove_outbound_message(&self.outbound, id);
                Err(rtc_error(error))
            }
        }
    }

    #[napi]
    pub async fn next_event(&self) -> napi::Result<Option<NativeDataChannelEvent>> {
        self.events
            .next()
            .await
            .map(|event| {
                event.map(|event| {
                    event.map(|event| match event {
                        DataChannelEvent::State(state) => NativeDataChannelEvent {
                            kind: "statechange".into(),
                            state: Some(state),
                            data: None,
                            binary: None,
                        },
                        DataChannelEvent::Message(data, binary) => NativeDataChannelEvent {
                            kind: "message".into(),
                            state: None,
                            data: Some(data.into()),
                            binary: Some(binary),
                        },
                        DataChannelEvent::BufferedAmount => NativeDataChannelEvent {
                            kind: "bufferedamountchange".into(),
                            state: None,
                            data: None,
                            binary: None,
                        },
                    })
                })
            })
            .map_err(napi::Error::from_reason)
    }

    #[napi]
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(channel) = lock(&self.channel).take() {
            channel.close();
        }
        lock(&self.outbound).clear();
        self.events.close();
        lock(&self.budget).take();
    }
}

fn release_outbound_bytes(outbound: &Mutex<VecDeque<OutboundMessage>>, mut sent_bytes: u64) {
    let mut outbound = lock(outbound);
    loop {
        let Some(message) = outbound.front_mut() else {
            return;
        };
        if message.remaining == 0 {
            // The native callback reports byte deltas, so it cannot identify
            // adjacent empty sends. One callback may acknowledge at most one
            // of them; retaining more reservations is safer than admitting an
            // unbounded zero-byte run.
            outbound.pop_front();
            return;
        }
        if sent_bytes == 0 {
            return;
        }
        if sent_bytes < message.remaining {
            message.remaining -= sent_bytes;
            return;
        }
        sent_bytes -= message.remaining;
        outbound.pop_front();
    }
}

fn outbound_item_limit_reached(pending_messages: usize) -> bool {
    pending_messages >= DATA_CHANNEL_OUTBOUND_LIMIT
}

fn remove_outbound_message(outbound: &Mutex<VecDeque<OutboundMessage>>, id: u64) {
    let mut outbound = lock(outbound);
    if let Some(index) = outbound.iter().position(|message| message.id == id) {
        outbound.remove(index);
    }
}

impl Drop for NativeDataChannel {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::VecDeque, sync::Mutex};

    use crate::queue::QueueBudget;

    use super::{
        DATA_CHANNEL_EVENT_BYTES, DATA_CHANNEL_OUTBOUND_LIMIT, DATA_CHANNEL_SEND_OVERHEAD_BYTES,
        DataChannelEvent, OutboundMessage, outbound_item_limit_reached, release_outbound_bytes,
    };

    #[test]
    fn outbound_item_limit_counts_zero_byte_messages() {
        // NativeDataChannel::send checks this before it considers payload bytes,
        // so zero-byte sends take the same bounded FIFO path as every other send.
        assert!(!outbound_item_limit_reached(
            DATA_CHANNEL_OUTBOUND_LIMIT.saturating_sub(1)
        ));
        assert!(outbound_item_limit_reached(DATA_CHANNEL_OUTBOUND_LIMIT));
    }

    #[test]
    fn a_zero_byte_callback_releases_one_zero_byte_send() {
        let root = QueueBudget::new(1024).expect("test process budget");
        let budget = root.generation(1024).expect("test generation budget");
        let outbound = Mutex::new(VecDeque::from([
            OutboundMessage {
                id: 1,
                remaining: 0,
                _reservation: budget
                    .reserve(DATA_CHANNEL_SEND_OVERHEAD_BYTES)
                    .expect("first reservation"),
            },
            OutboundMessage {
                id: 2,
                remaining: 0,
                _reservation: budget
                    .reserve(DATA_CHANNEL_SEND_OVERHEAD_BYTES)
                    .expect("second reservation"),
            },
        ]));

        release_outbound_bytes(&outbound, 0);

        let outbound = outbound.lock().expect("outbound queue lock");
        assert_eq!(outbound.len(), 1);
        assert_eq!(outbound.front().expect("remaining message").id, 2);
    }

    #[test]
    fn a_nonzero_callback_also_releases_at_most_one_zero_byte_send() {
        let root = QueueBudget::new(1024).expect("test process budget");
        let budget = root.generation(1024).expect("test generation budget");
        let outbound = Mutex::new(VecDeque::from([
            OutboundMessage {
                id: 1,
                remaining: 0,
                _reservation: budget
                    .reserve(DATA_CHANNEL_SEND_OVERHEAD_BYTES)
                    .expect("first reservation"),
            },
            OutboundMessage {
                id: 2,
                remaining: 0,
                _reservation: budget
                    .reserve(DATA_CHANNEL_SEND_OVERHEAD_BYTES)
                    .expect("second reservation"),
            },
        ]));

        release_outbound_bytes(&outbound, 1);

        let outbound = outbound.lock().expect("outbound queue lock");
        assert_eq!(outbound.len(), 1);
        assert_eq!(outbound.front().expect("remaining message").id, 2);
    }

    #[test]
    fn inbound_message_reserves_its_payload() {
        let event = DataChannelEvent::Message(vec![0; 1024], true);
        assert_eq!(
            event.retained_bytes(),
            DATA_CHANNEL_EVENT_BYTES.saturating_add(1024),
        );
    }
}

#[napi]
pub struct NativeMediaStreamTrack {
    track: Mutex<Option<MediaStreamTrack>>,
    identity: u64,
    id: String,
    kind: String,
}

impl NativeMediaStreamTrack {
    pub(crate) fn new(track: MediaStreamTrack) -> Self {
        let identity = track.native_identity();
        let id = track.id();
        let kind = match track {
            MediaStreamTrack::Audio(_) => "audio",
            MediaStreamTrack::Video(_) => "video",
        }
        .into();
        Self {
            track: Mutex::new(Some(track)),
            identity,
            id,
            kind,
        }
    }

    pub(crate) fn media_track(&self) -> napi::Result<MediaStreamTrack> {
        lock(&self.track)
            .clone()
            .ok_or_else(|| napi::Error::from_reason("media stream track is stopped"))
    }
}

#[napi]
impl NativeMediaStreamTrack {
    #[napi(getter)]
    pub fn identity(&self) -> BigInt {
        self.identity.into()
    }

    #[napi(getter)]
    pub fn id(&self) -> String {
        self.id.clone()
    }

    #[napi(getter)]
    pub fn kind(&self) -> String {
        self.kind.clone()
    }

    #[napi(getter)]
    pub fn enabled(&self) -> bool {
        lock(&self.track)
            .as_ref()
            .is_some_and(MediaStreamTrack::enabled)
    }

    #[napi(setter)]
    pub fn set_enabled(&self, enabled: bool) {
        if let Some(track) = lock(&self.track).as_ref() {
            track.set_enabled(enabled);
        }
    }

    #[napi(getter)]
    pub fn ready_state(&self) -> String {
        match lock(&self.track).as_ref().map(MediaStreamTrack::state) {
            Some(RtcTrackState::Live) => "live",
            Some(RtcTrackState::Ended) | None => "ended",
        }
        .into()
    }

    #[napi]
    pub fn stop(&self) {
        if let Some(track) = lock(&self.track).take() {
            track.set_enabled(false);
        }
    }
}

#[napi]
pub struct NativeMediaStream {
    stream: MediaStream,
}

#[napi]
impl NativeMediaStream {
    #[napi(getter)]
    pub fn id(&self) -> String {
        self.stream.id()
    }

    #[napi]
    pub fn get_audio_tracks(&self) -> Vec<NativeMediaStreamTrack> {
        self.stream
            .audio_tracks()
            .into_iter()
            .map(|track| NativeMediaStreamTrack::new(track.into()))
            .collect()
    }

    #[napi]
    pub fn get_video_tracks(&self) -> Vec<NativeMediaStreamTrack> {
        self.stream
            .video_tracks()
            .into_iter()
            .map(|track| NativeMediaStreamTrack::new(track.into()))
            .collect()
    }
}

#[napi]
pub struct NativeRtpSender {
    sender: RtpSender,
    last_parameters: Mutex<Option<RtpParameters>>,
}

impl NativeRtpSender {
    fn new(sender: RtpSender) -> Self {
        Self {
            sender,
            last_parameters: Mutex::new(None),
        }
    }
}

#[napi]
impl NativeRtpSender {
    #[napi(getter)]
    pub fn identity(&self) -> BigInt {
        self.sender.native_identity().into()
    }

    #[napi(getter)]
    pub fn track(&self) -> Option<NativeMediaStreamTrack> {
        self.sender.track().map(NativeMediaStreamTrack::new)
    }

    #[napi]
    pub fn replace_track(
        &self,
        track: Option<ClassInstance<'_, NativeMediaStreamTrack>>,
    ) -> napi::Result<()> {
        self.sender
            .set_track(track.map(|track| track.media_track()).transpose()?)
            .map_err(rtc_error)
    }

    #[napi]
    pub fn get_parameters(&self) -> NativeRtpParameters {
        let parameters = self.sender.parameters();
        let result = native_rtp_parameters(parameters.clone());
        *lock(&self.last_parameters) = Some(parameters);
        result
    }

    #[napi]
    pub fn set_parameters(&self, parameters: NativeRtpParameters) -> napi::Result<()> {
        let current = lock(&self.last_parameters)
            .take()
            .filter(|current| current.transaction_id() == parameters.transaction_id)
            .ok_or_else(|| {
                invalid_modification(
                    "RTP parameters must come from the latest getParameters() call",
                )
            })?;
        let updated = update_rtp_parameters(current, parameters)?;
        self.sender.set_parameters(updated).map_err(rtc_error)
    }

    #[napi]
    pub async fn get_stats(&self) -> napi::Result<String> {
        self.sender.get_stats_json().await.map_err(rtc_error)
    }
}

#[napi]
pub struct NativeRtpReceiver {
    receiver: RtpReceiver,
}

#[napi]
impl NativeRtpReceiver {
    #[napi(getter)]
    pub fn identity(&self) -> BigInt {
        self.receiver.native_identity().into()
    }

    #[napi(getter)]
    pub fn track(&self) -> Option<NativeMediaStreamTrack> {
        self.receiver.track().map(NativeMediaStreamTrack::new)
    }

    #[napi]
    pub fn get_parameters(&self) -> NativeRtpParameters {
        native_rtp_parameters(self.receiver.parameters())
    }

    #[napi]
    pub async fn get_stats(&self) -> napi::Result<String> {
        self.receiver.get_stats_json().await.map_err(rtc_error)
    }
}

#[napi]
pub struct NativeRtpTransceiver {
    transceiver: RtpTransceiver,
}

#[napi]
impl NativeRtpTransceiver {
    #[napi(getter)]
    pub fn identity(&self) -> BigInt {
        self.transceiver.native_identity().into()
    }

    #[napi(getter)]
    pub fn mid(&self) -> Option<String> {
        self.transceiver.mid()
    }

    #[napi(getter)]
    pub fn direction(&self) -> String {
        transceiver_direction(self.transceiver.direction())
    }

    #[napi(setter)]
    pub fn set_direction(&self, value: String) -> napi::Result<()> {
        self.transceiver
            .set_direction(parse_transceiver_direction(&value)?)
            .map_err(rtc_error)
    }

    #[napi(getter)]
    pub fn current_direction(&self) -> Option<String> {
        self.transceiver
            .current_direction()
            .map(transceiver_direction)
    }

    #[napi(getter)]
    pub fn sender(&self) -> NativeRtpSender {
        NativeRtpSender::new(self.transceiver.sender())
    }

    #[napi(getter)]
    pub fn receiver(&self) -> NativeRtpReceiver {
        NativeRtpReceiver {
            receiver: self.transceiver.receiver(),
        }
    }

    #[napi]
    pub fn set_codec_preferences(&self, codecs: Vec<NativeRtpCodecCapability>) -> napi::Result<()> {
        self.transceiver
            .set_codec_preferences(
                codecs
                    .into_iter()
                    .map(rtp_codec_capability)
                    .collect::<napi::Result<Vec<_>>>()?,
            )
            .map_err(rtc_error)
    }

    #[napi]
    pub fn stop(&self) -> napi::Result<()> {
        self.transceiver.stop().map_err(rtc_error)
    }
}

#[napi]
pub struct NativeTrackEvent {
    event: TrackEvent,
}

#[napi]
impl NativeTrackEvent {
    #[napi(getter)]
    pub fn track(&self) -> NativeMediaStreamTrack {
        NativeMediaStreamTrack::new(self.event.track.clone())
    }

    #[napi(getter)]
    pub fn receiver(&self) -> NativeRtpReceiver {
        NativeRtpReceiver {
            receiver: self.event.receiver.clone(),
        }
    }

    #[napi(getter)]
    pub fn transceiver(&self) -> NativeRtpTransceiver {
        NativeRtpTransceiver {
            transceiver: self.event.transceiver.clone(),
        }
    }

    #[napi(getter)]
    pub fn streams(&self) -> Vec<NativeMediaStream> {
        self.event
            .streams
            .iter()
            .cloned()
            .map(|stream| NativeMediaStream { stream })
            .collect()
    }
}

fn native_peer_event(event: PeerEvent) -> NativePeerEvent {
    match event {
        PeerEvent::ConnectionState(state) => NativePeerEvent {
            kind: "connectionstatechange".into(),
            state: Some(state),
            ..native_peer_event_base()
        },
        PeerEvent::IceCandidate(candidate) => NativePeerEvent {
            kind: "icecandidate".into(),
            candidate: Some(candidate),
            ..native_peer_event_base()
        },
        PeerEvent::IceCandidateError(error) => NativePeerEvent {
            kind: "icecandidateerror".into(),
            address: Some(error.address),
            port: Some(error.port),
            url: Some(error.url),
            error_code: Some(error.error_code),
            error_text: Some(error.error_text),
            ..native_peer_event_base()
        },
        PeerEvent::IceConnectionState(state) => NativePeerEvent {
            kind: "iceconnectionstatechange".into(),
            state: Some(state),
            ..native_peer_event_base()
        },
        PeerEvent::IceGatheringState(state) => NativePeerEvent {
            kind: "icegatheringstatechange".into(),
            state: Some(state),
            ..native_peer_event_base()
        },
        PeerEvent::NegotiationNeeded => NativePeerEvent {
            kind: "negotiationneeded".into(),
            ..native_peer_event_base()
        },
        PeerEvent::SignalingState(state) => NativePeerEvent {
            kind: "signalingstatechange".into(),
            state: Some(state),
            ..native_peer_event_base()
        },
        PeerEvent::Track(handle) => NativePeerEvent {
            kind: "track".into(),
            handle: Some(handle),
            ..native_peer_event_base()
        },
        PeerEvent::DataChannel(handle) => NativePeerEvent {
            kind: "datachannel".into(),
            handle: Some(handle),
            ..native_peer_event_base()
        },
    }
}

fn native_peer_event_base() -> NativePeerEvent {
    NativePeerEvent {
        kind: String::new(),
        state: None,
        candidate: None,
        handle: None,
        address: None,
        port: None,
        url: None,
        error_code: None,
        error_text: None,
    }
}

pub(crate) fn native_rtp_capabilities(value: RtpCapabilities) -> NativeRtpCapabilities {
    NativeRtpCapabilities {
        codecs: value
            .codecs
            .into_iter()
            .map(|codec| NativeRtpCodecCapability {
                mime_type: codec.mime_type,
                clock_rate: codec.clock_rate.unwrap_or_default() as f64,
                channels: codec.channels.map(u32::from),
                sdp_fmtp_line: codec.sdp_fmtp_line,
            })
            .collect(),
        header_extensions: value
            .header_extensions
            .into_iter()
            .map(|extension| NativeRtpHeaderExtensionCapability { uri: extension.uri })
            .collect(),
    }
}

fn native_rtp_parameters(value: RtpParameters) -> NativeRtpParameters {
    let degradation_preference = value.degradation_preference().map(degradation_preference);
    NativeRtpParameters {
        transaction_id: value.transaction_id().to_owned(),
        codecs: value
            .codecs
            .into_iter()
            .map(|codec| NativeRtpCodecParameters {
                payload_type: u32::from(codec.payload_type),
                mime_type: codec.mime_type,
                clock_rate: codec.clock_rate.unwrap_or_default() as f64,
                channels: codec.channels.map(u32::from),
            })
            .collect(),
        header_extensions: value
            .header_extensions
            .into_iter()
            .map(|extension| NativeRtpHeaderExtensionParameters {
                uri: extension.uri,
                id: extension.id,
                encrypted: Some(extension.encrypted),
            })
            .collect(),
        encodings: value
            .encodings
            .into_iter()
            .map(native_rtp_encoding)
            .collect(),
        rtcp: NativeRtcpParameters {
            cname: Some(value.rtcp.cname),
            reduced_size: Some(value.rtcp.reduced_size),
        },
        degradation_preference,
    }
}

fn native_rtp_encoding(value: RtpEncodingParameters) -> NativeRtpEncodingParameters {
    NativeRtpEncodingParameters {
        active: Some(value.active),
        max_bitrate: value.max_bitrate.map(|value| value as f64),
        max_framerate: value.max_framerate,
        priority: Some(priority(value.priority)),
        rid: Some(value.rid),
        scale_resolution_down_by: value.scale_resolution_down_by,
        scalability_mode: value.scalability_mode,
        ssrc: value.has_ssrc.then_some(value.ssrc),
    }
}

fn update_rtp_parameters(
    mut current: RtpParameters,
    requested: NativeRtpParameters,
) -> napi::Result<RtpParameters> {
    let visible = native_rtp_parameters(current.clone());
    if requested.transaction_id != visible.transaction_id {
        return Err(invalid_modification(
            "RTP transactionId no longer identifies the current parameters",
        ));
    }
    if requested.codecs != visible.codecs
        || requested.header_extensions != visible.header_extensions
        || requested.rtcp != visible.rtcp
    {
        return Err(invalid_modification(
            "RTP codecs, headerExtensions, and rtcp are read-only",
        ));
    }
    if requested.encodings.len() != current.encodings.len() {
        return Err(invalid_modification("RTP encoding count is read-only"));
    }

    for (encoding, requested) in current.encodings.iter_mut().zip(requested.encodings) {
        if requested.rid.as_deref().unwrap_or_default() != encoding.rid {
            return Err(invalid_modification("RTP encoding rid is read-only"));
        }
        if requested.ssrc != encoding.has_ssrc.then_some(encoding.ssrc) {
            return Err(invalid_modification("RTP encoding ssrc is read-only"));
        }
        encoding.active = requested.active.unwrap_or(true);
        encoding.max_bitrate = optional_positive_integer(requested.max_bitrate, "maxBitrate")?;
        encoding.max_framerate = optional_positive(requested.max_framerate, "maxFramerate")?;
        encoding.priority = parse_priority(requested.priority.as_deref().unwrap_or("low"))?;
        encoding.scale_resolution_down_by =
            optional_at_least_one(requested.scale_resolution_down_by, "scaleResolutionDownBy")?;
        encoding.scalability_mode = requested.scalability_mode;
    }
    if let Some(preference) = requested.degradation_preference {
        current.set_degradation_preference(parse_degradation_preference(&preference)?);
    }
    Ok(current)
}

fn invalid_modification(reason: &str) -> napi::Error {
    napi::Error::from_reason(format!("InvalidModificationError: {reason}"))
}

fn rtp_codec_capability(value: NativeRtpCodecCapability) -> napi::Result<RtpCodecCapability> {
    if value.mime_type.split_once('/').is_none() {
        return Err(napi::Error::from_reason(
            "RTP codec mimeType must contain a media kind and codec name",
        ));
    }
    Ok(RtpCodecCapability {
        channels: value
            .channels
            .map(|channels| {
                u16::try_from(channels)
                    .map_err(|_| napi::Error::from_reason("RTP codec channels is too large"))
            })
            .transpose()?,
        clock_rate: Some(positive_integer(value.clock_rate, "clockRate")?),
        mime_type: value.mime_type,
        sdp_fmtp_line: value.sdp_fmtp_line,
    })
}

fn transceiver_init(
    direction: Option<String>,
    stream_ids: Option<Vec<String>>,
    send_encodings: Option<Vec<NativeRtpEncodingParameters>>,
) -> napi::Result<RtpTransceiverInit> {
    Ok(RtpTransceiverInit {
        direction: parse_transceiver_direction(direction.as_deref().unwrap_or("sendrecv"))?,
        stream_ids: stream_ids.unwrap_or_default(),
        send_encodings: send_encodings
            .unwrap_or_default()
            .into_iter()
            .map(parse_encoding)
            .collect::<napi::Result<Vec<_>>>()?,
    })
}

fn positive_integer(value: f64, name: &str) -> napi::Result<u64> {
    optional_positive_integer(Some(value), name)?
        .ok_or_else(|| napi::Error::from_reason(format!("{name} is required")))
}

fn parse_encoding(value: NativeRtpEncodingParameters) -> napi::Result<RtpEncodingParameters> {
    let mut encoding = RtpEncodingParameters {
        active: value.active.unwrap_or(true),
        max_bitrate: optional_positive_integer(value.max_bitrate, "maxBitrate")?,
        max_framerate: optional_positive(value.max_framerate, "maxFramerate")?,
        priority: parse_priority(value.priority.as_deref().unwrap_or("low"))?,
        rid: value.rid.unwrap_or_default(),
        scale_resolution_down_by: optional_at_least_one(
            value.scale_resolution_down_by,
            "scaleResolutionDownBy",
        )?,
        scalability_mode: value.scalability_mode,
        ..RtpEncodingParameters::default()
    };
    if let Some(ssrc) = value.ssrc {
        encoding.has_ssrc = true;
        encoding.ssrc = ssrc;
    }
    Ok(encoding)
}

fn optional_positive_integer(value: Option<f64>, name: &str) -> napi::Result<Option<u64>> {
    value
        .map(|value| {
            if !value.is_finite() || value <= 0.0 || value.fract() != 0.0 {
                return Err(napi::Error::from_reason(format!(
                    "{name} must be a positive integer",
                )));
            }
            Ok(value as u64)
        })
        .transpose()
}

fn optional_positive(value: Option<f64>, name: &str) -> napi::Result<Option<f64>> {
    value
        .map(|value| {
            if !value.is_finite() || value <= 0.0 {
                return Err(napi::Error::from_reason(
                    format!("{name} must be positive",),
                ));
            }
            Ok(value)
        })
        .transpose()
}

fn optional_at_least_one(value: Option<f64>, name: &str) -> napi::Result<Option<f64>> {
    value
        .map(|value| {
            if !value.is_finite() || value < 1.0 {
                return Err(napi::Error::from_reason(format!(
                    "{name} must be at least 1",
                )));
            }
            Ok(value)
        })
        .transpose()
}

fn parse_priority(value: &str) -> napi::Result<Priority> {
    match value {
        "very-low" => Ok(Priority::VeryLow),
        "low" => Ok(Priority::Low),
        "medium" => Ok(Priority::Medium),
        "high" => Ok(Priority::High),
        _ => Err(napi::Error::from_reason(format!(
            "unsupported RTP priority \"{value}\"",
        ))),
    }
}

fn priority(value: Priority) -> String {
    match value {
        Priority::VeryLow => "very-low",
        Priority::Low => "low",
        Priority::Medium => "medium",
        Priority::High => "high",
    }
    .into()
}

fn parse_degradation_preference(value: &str) -> napi::Result<DegradationPreference> {
    match value {
        "balanced" => Ok(DegradationPreference::Balanced),
        "maintain-framerate" => Ok(DegradationPreference::MaintainFramerate),
        "maintain-resolution" => Ok(DegradationPreference::MaintainResolution),
        _ => Err(napi::Error::from_reason(format!(
            "unsupported degradationPreference \"{value}\"",
        ))),
    }
}

fn degradation_preference(value: DegradationPreference) -> String {
    match value {
        DegradationPreference::MaintainFramerateAndResolution => "balanced",
        DegradationPreference::MaintainFramerate => "maintain-framerate",
        DegradationPreference::MaintainResolution => "maintain-resolution",
        DegradationPreference::Balanced => "balanced",
    }
    .into()
}

fn parse_transceiver_direction(value: &str) -> napi::Result<RtpTransceiverDirection> {
    match value {
        "sendrecv" => Ok(RtpTransceiverDirection::SendRecv),
        "sendonly" => Ok(RtpTransceiverDirection::SendOnly),
        "recvonly" => Ok(RtpTransceiverDirection::RecvOnly),
        "inactive" => Ok(RtpTransceiverDirection::Inactive),
        "stopped" => Ok(RtpTransceiverDirection::Stopped),
        _ => Err(napi::Error::from_reason(format!(
            "unsupported transceiver direction \"{value}\""
        ))),
    }
}

fn transceiver_direction(value: RtpTransceiverDirection) -> String {
    match value {
        RtpTransceiverDirection::SendRecv => "sendrecv",
        RtpTransceiverDirection::SendOnly => "sendonly",
        RtpTransceiverDirection::RecvOnly => "recvonly",
        RtpTransceiverDirection::Inactive => "inactive",
        RtpTransceiverDirection::Stopped => "stopped",
    }
    .into()
}

fn connection_state(value: PeerConnectionState) -> String {
    match value {
        PeerConnectionState::New => "new",
        PeerConnectionState::Connecting => "connecting",
        PeerConnectionState::Connected => "connected",
        PeerConnectionState::Disconnected => "disconnected",
        PeerConnectionState::Failed => "failed",
        PeerConnectionState::Closed => "closed",
    }
    .into()
}

fn ice_connection_state(value: IceConnectionState) -> String {
    match value {
        IceConnectionState::New => "new",
        IceConnectionState::Checking => "checking",
        IceConnectionState::Connected => "connected",
        IceConnectionState::Completed => "completed",
        IceConnectionState::Failed => "failed",
        IceConnectionState::Disconnected => "disconnected",
        IceConnectionState::Closed => "closed",
        IceConnectionState::Max => "closed",
    }
    .into()
}

fn signaling_state(value: SignalingState) -> String {
    match value {
        SignalingState::Stable => "stable",
        SignalingState::HaveLocalOffer => "have-local-offer",
        SignalingState::HaveLocalPrAnswer => "have-local-pranswer",
        SignalingState::HaveRemoteOffer => "have-remote-offer",
        SignalingState::HaveRemotePrAnswer => "have-remote-pranswer",
        SignalingState::Closed => "closed",
    }
    .into()
}

fn ice_gathering_state(value: IceGatheringState) -> String {
    match value {
        IceGatheringState::New => "new",
        IceGatheringState::Gathering => "gathering",
        IceGatheringState::Complete => "complete",
    }
    .into()
}

fn data_channel_state(value: DataChannelState) -> String {
    match value {
        DataChannelState::Connecting => "connecting",
        DataChannelState::Open => "open",
        DataChannelState::Closing => "closing",
        DataChannelState::Closed => "closed",
    }
    .into()
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
