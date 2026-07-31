use std::{
    borrow::Cow,
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use futures_util::StreamExt;
use libwebrtc::{
    audio_frame::AudioFrame,
    audio_source::{AudioSourceOptions, native::NativeAudioSource},
    audio_stream::native::{NativeAudioStream, NativeAudioStreamOptions as RtcAudioStreamOptions},
    media_stream_track::MediaStreamTrack,
    peer_connection_factory::{PeerConnectionFactory, native::PeerConnectionFactoryExt},
    video_frame::{I420Buffer, VideoFrame, VideoRotation},
    video_source::{VideoResolution, native::NativeVideoSource},
    video_stream::native::{NativeVideoStream, NativeVideoStreamOptions as RtcVideoStreamOptions},
};
use napi::bindgen_prelude::{
    BigInt, ClassInstance, Int16Array, Uint8Array, within_runtime_if_available,
};
use napi_derive::napi;
use tokio::sync::Notify;

use crate::{
    peer::NativeMediaStreamTrack,
    queue::{GenerationQueueBudget, QueueReservation},
    types::rtc_error,
};

static TRACK_SEQUENCE: AtomicU64 = AtomicU64::new(1);
const MAX_AUDIO_SAMPLE_RATE: u32 = 192_000;
const MAX_AUDIO_CHANNELS: u32 = 8;
const MAX_AUDIO_FRAME_BYTES: usize = 1024 * 1024;
const MAX_VIDEO_DIMENSION: u32 = 4_096;
const MAX_VIDEO_PIXELS: u32 = 8_388_608;
const MAX_VIDEO_FRAME_BYTES: usize = 16 * 1024 * 1024;

struct NativeQueueReservation(Mutex<Option<QueueReservation>>);

impl NativeQueueReservation {
    fn new(reservation: QueueReservation) -> Self {
        Self(Mutex::new(Some(reservation)))
    }

    fn optional(reservation: Option<QueueReservation>) -> Self {
        Self(Mutex::new(reservation))
    }

    fn release(&self) {
        lock(&self.0).take();
    }
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct NativeAudioSourceOptions {
    pub label: Option<String>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
    pub queue_size_ms: Option<u32>,
    pub echo_cancellation: Option<bool>,
    pub noise_suppression: Option<bool>,
    pub auto_gain_control: Option<bool>,
}

impl Default for NativeAudioSourceOptions {
    fn default() -> Self {
        Self {
            label: None,
            sample_rate: Some(48_000),
            channels: Some(1),
            queue_size_ms: Some(1_000),
            echo_cancellation: Some(false),
            noise_suppression: Some(false),
            auto_gain_control: Some(false),
        }
    }
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct NativeAudioStreamOptions {
    pub sample_rate: Option<i32>,
    pub channels: Option<i32>,
    pub queue_size_frames: Option<u32>,
}

impl Default for NativeAudioStreamOptions {
    fn default() -> Self {
        Self {
            sample_rate: Some(48_000),
            channels: Some(1),
            queue_size_frames: Some(10),
        }
    }
}

#[napi(object)]
pub struct NativeAudioFrame {
    pub data: Int16Array,
    pub sample_rate: u32,
    pub channels: u32,
    pub samples_per_channel: u32,
}

#[napi]
pub struct NativeAudioSourceHandle {
    source: NativeAudioSource,
    track: Mutex<Option<MediaStreamTrack>>,
    sample_rate: u32,
    channels: u32,
    budget: Mutex<Option<GenerationQueueBudget>>,
    reservation: NativeQueueReservation,
    closed: AtomicBool,
}

impl NativeAudioSourceHandle {
    pub fn new(
        factory: PeerConnectionFactory,
        options: NativeAudioSourceOptions,
        budget: GenerationQueueBudget,
    ) -> napi::Result<Self> {
        let sample_rate = native_audio_value(
            options.sample_rate.unwrap_or(48_000),
            "sampleRate",
            MAX_AUDIO_SAMPLE_RATE,
        )?;
        let channels = native_audio_value(
            options.channels.unwrap_or(1),
            "channels",
            MAX_AUDIO_CHANNELS,
        )?;
        let queue_size_ms = audio_queue_size(
            options.queue_size_ms.unwrap_or(1_000),
            sample_rate,
            channels,
        )?;
        let reservation = reserve_capacity(
            &budget,
            audio_source_queue_bytes(queue_size_ms, sample_rate, channels)?,
        )?;
        let source = NativeAudioSource::new(
            AudioSourceOptions {
                echo_cancellation: options.echo_cancellation.unwrap_or(false),
                noise_suppression: options.noise_suppression.unwrap_or(false),
                auto_gain_control: options.auto_gain_control.unwrap_or(false),
            },
            sample_rate,
            channels,
            queue_size_ms,
        );
        let label = options.label.unwrap_or_else(|| label("audio"));
        let track = factory.create_audio_track(&label, source.clone()).into();
        Ok(Self {
            source,
            track: Mutex::new(Some(track)),
            sample_rate,
            channels,
            budget: Mutex::new(Some(budget)),
            reservation: NativeQueueReservation::optional(reservation),
            closed: AtomicBool::new(false),
        })
    }
}

#[napi]
impl NativeAudioSourceHandle {
    #[napi(getter)]
    pub fn track(&self) -> napi::Result<NativeMediaStreamTrack> {
        lock(&self.track)
            .clone()
            .map(NativeMediaStreamTrack::new)
            .ok_or_else(|| napi::Error::from_reason("audio source is closed"))
    }

    #[napi(getter)]
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    #[napi(getter)]
    pub fn channels(&self) -> u32 {
        self.channels
    }

    #[napi(getter)]
    pub fn queued_duration(&self) -> f64 {
        self.source.queued_duration().as_secs_f64()
    }

    #[napi]
    pub async fn capture_frame(
        &self,
        data: Int16Array,
        sample_rate: u32,
        channels: u32,
        samples_per_channel: u32,
    ) -> napi::Result<()> {
        let expected = channels
            .checked_mul(samples_per_channel)
            .ok_or_else(|| napi::Error::from_reason("audio frame is too large"))?
            as usize;
        if expected != data.len() {
            return Err(napi::Error::from_reason(format!(
                "audio frame has {} samples; expected {expected}",
                data.len()
            )));
        }
        if sample_rate != self.sample_rate || channels != self.channels {
            return Err(napi::Error::from_reason(format!(
                "audio frame must be {} Hz with {} channel(s)",
                self.sample_rate, self.channels
            )));
        }
        let bytes = audio_frame_bytes(data.len())?;
        let budget = lock(&self.budget)
            .clone()
            .ok_or_else(|| napi::Error::from_reason("audio source is closed"))?;
        let _reservation = reserve(&budget, bytes)?;
        self.source
            .capture_frame(&AudioFrame {
                data: Cow::Owned(data.as_ref().to_vec()),
                sample_rate,
                num_channels: channels,
                samples_per_channel,
            })
            .await
            .map_err(rtc_error)
    }

    #[napi]
    pub async fn wait_for_playout(&self) {
        self.source.wait_for_playout().await;
    }

    #[napi]
    pub fn clear_queue(&self) {
        self.source.clear_buffer();
    }

    #[napi]
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.source.close();
        if let Some(track) = lock(&self.track).take() {
            track.set_enabled(false);
        }
        self.reservation.release();
        lock(&self.budget).take();
    }
}

impl Drop for NativeAudioSourceHandle {
    fn drop(&mut self) {
        self.close();
    }
}

#[napi]
pub struct NativeAudioStreamHandle {
    stream: Mutex<Option<NativeAudioStream>>,
    closed: AtomicBool,
    changed: Notify,
    reservation: NativeQueueReservation,
    last_dropped_frames: AtomicU64,
}

impl NativeAudioStreamHandle {
    pub fn new(
        track: &ClassInstance<'_, NativeMediaStreamTrack>,
        options: NativeAudioStreamOptions,
        budget: GenerationQueueBudget,
    ) -> napi::Result<Self> {
        let media_track = track.media_track()?;
        let MediaStreamTrack::Audio(track) = media_track else {
            return Err(napi::Error::from_reason(
                "audioStream requires an audio track",
            ));
        };
        let sample_rate = native_audio_stream_value(
            options.sample_rate.unwrap_or(48_000),
            "sampleRate",
            MAX_AUDIO_SAMPLE_RATE,
        )?;
        let channels = native_audio_stream_value(
            options.channels.unwrap_or(1),
            "channels",
            MAX_AUDIO_CHANNELS,
        )?;
        let queue_size_frames =
            positive(options.queue_size_frames.unwrap_or(10), "queueSizeFrames")?;
        let reservation = reserve(
            &budget,
            audio_stream_queue_bytes(sample_rate as u32, channels as u32, queue_size_frames)?,
        )?;
        Ok(Self {
            stream: Mutex::new(Some(NativeAudioStream::with_options(
                track,
                sample_rate,
                channels,
                RtcAudioStreamOptions {
                    queue_size_frames: Some(queue_size_frames as usize),
                },
            ))),
            closed: AtomicBool::new(false),
            changed: Notify::new(),
            reservation: NativeQueueReservation::new(reservation),
            last_dropped_frames: AtomicU64::new(0),
        })
    }
}

#[napi]
impl NativeAudioStreamHandle {
    #[napi(getter)]
    pub fn dropped_frames(&self) -> BigInt {
        let dropped_frames = lock(&self.stream)
            .as_ref()
            .map(NativeAudioStream::dropped_frames)
            .unwrap_or_else(|| self.last_dropped_frames.load(Ordering::Relaxed));
        self.last_dropped_frames
            .store(dropped_frames, Ordering::Relaxed);
        dropped_frames.into()
    }

    #[napi]
    pub async fn next_frame(&self) -> napi::Result<Option<NativeAudioFrame>> {
        let changed = self.changed.notified();
        if self.closed.load(Ordering::Acquire) {
            return Ok(None);
        }
        let Some(mut stream) = lock(&self.stream).take() else {
            return Err(napi::Error::from_reason(
                "audio stream already has a pending read",
            ));
        };
        let result = tokio::select! {
            frame = stream.next() => frame.map(|frame| {
                audio_frame_bytes(frame.data.len())?;
                Ok(NativeAudioFrame {
                    data: frame.data.into_owned().into(),
                    sample_rate: frame.sample_rate,
                    channels: frame.num_channels,
                    samples_per_channel: frame.samples_per_channel,
                })
            }).transpose(),
            _ = changed => {
                self.last_dropped_frames
                    .store(stream.dropped_frames(), Ordering::Relaxed);
                stream.close();
                self.reservation.release();
                return Ok(None);
            },
        };
        self.last_dropped_frames
            .store(stream.dropped_frames(), Ordering::Relaxed);
        if self.closed.load(Ordering::Acquire) {
            stream.close();
            self.reservation.release();
        } else {
            *lock(&self.stream) = Some(stream);
        }
        result
    }

    #[napi]
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.changed.notify_one();
        if let Some(mut stream) = lock(&self.stream).take() {
            self.last_dropped_frames
                .store(stream.dropped_frames(), Ordering::Relaxed);
            stream.close();
            self.reservation.release();
        }
    }
}

impl Drop for NativeAudioStreamHandle {
    fn drop(&mut self) {
        self.close();
    }
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct NativeVideoSourceOptions {
    pub label: Option<String>,
    pub width: u32,
    pub height: u32,
    pub screencast: Option<bool>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct NativeVideoStreamOptions {
    pub queue_size_frames: Option<u32>,
}

impl Default for NativeVideoStreamOptions {
    fn default() -> Self {
        Self {
            queue_size_frames: Some(1),
        }
    }
}

#[napi(object)]
pub struct NativeVideoFrameEvent {
    pub data: Uint8Array,
    pub width: u32,
    pub height: u32,
    pub timestamp_us: BigInt,
    pub rotation: u32,
}

#[napi]
pub struct NativeVideoSourceHandle {
    source: NativeVideoSource,
    track: Mutex<Option<MediaStreamTrack>>,
    width: u32,
    height: u32,
    closed: AtomicBool,
    reservation: NativeQueueReservation,
}

impl NativeVideoSourceHandle {
    pub fn new(
        factory: PeerConnectionFactory,
        options: NativeVideoSourceOptions,
        budget: GenerationQueueBudget,
    ) -> napi::Result<Self> {
        let width = positive(options.width, "width")?;
        let height = positive(options.height, "height")?;
        let frame_bytes = i420_size(width, height)?;
        let reservation = reserve(&budget, source_frame_bytes(frame_bytes)?)?;
        let source = within_runtime_if_available(|| {
            NativeVideoSource::new(
                VideoResolution { width, height },
                options.screencast.unwrap_or(false),
            )
        });
        let track = factory
            .create_video_track(
                &options.label.unwrap_or_else(|| label("video")),
                source.clone(),
            )
            .into();
        Ok(Self {
            source,
            track: Mutex::new(Some(track)),
            width,
            height,
            closed: AtomicBool::new(false),
            reservation: NativeQueueReservation::new(reservation),
        })
    }
}

#[napi]
impl NativeVideoSourceHandle {
    #[napi(getter)]
    pub fn track(&self) -> napi::Result<NativeMediaStreamTrack> {
        lock(&self.track)
            .clone()
            .map(NativeMediaStreamTrack::new)
            .ok_or_else(|| napi::Error::from_reason("video source is closed"))
    }

    #[napi(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[napi(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }

    #[napi]
    pub fn capture_frame(
        &self,
        data: Uint8Array,
        width: u32,
        height: u32,
        timestamp_us: BigInt,
        rotation: u32,
    ) -> napi::Result<()> {
        if self.closed.load(Ordering::Acquire) {
            return Err(napi::Error::from_reason("video source is closed"));
        }
        if width != self.width || height != self.height {
            return Err(napi::Error::from_reason(format!(
                "video frame must be {}x{}",
                self.width, self.height
            )));
        }
        let expected = i420_size(width, height)?;
        if data.len() != expected {
            return Err(napi::Error::from_reason(format!(
                "I420 frame has {} bytes; expected {expected}",
                data.len()
            )));
        }
        let (timestamp_us, lossless) = timestamp_us.get_i64();
        if !lossless {
            return Err(napi::Error::from_reason(
                "timestampUs is outside the signed 64-bit range",
            ));
        }
        let chroma_width = width.div_ceil(2);
        let chroma_height = height.div_ceil(2);
        let y_length = (width * height) as usize;
        let chroma_length = (chroma_width * chroma_height) as usize;
        let mut buffer = I420Buffer::new(width, height);
        let (stride_y, stride_u, stride_v) = buffer.strides();
        let (y, u, v) = buffer.data_mut();
        copy_to_plane(
            &data[..y_length],
            width as usize,
            y,
            stride_y as usize,
            height as usize,
        );
        copy_to_plane(
            &data[y_length..y_length + chroma_length],
            chroma_width as usize,
            u,
            stride_u as usize,
            chroma_height as usize,
        );
        copy_to_plane(
            &data[y_length + chroma_length..],
            chroma_width as usize,
            v,
            stride_v as usize,
            chroma_height as usize,
        );
        let mut frame = VideoFrame::new(video_rotation(rotation)?, buffer);
        frame.timestamp_us = timestamp_us;
        self.source.capture_frame(&frame);
        Ok(())
    }

    #[napi]
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(track) = lock(&self.track).take() {
            track.set_enabled(false);
        }
        self.reservation.release();
    }
}

impl Drop for NativeVideoSourceHandle {
    fn drop(&mut self) {
        self.close();
    }
}

#[napi]
pub struct NativeVideoStreamHandle {
    stream: Mutex<Option<NativeVideoStream>>,
    closed: AtomicBool,
    changed: Notify,
    reservation: NativeQueueReservation,
    last_dropped_frames: AtomicU64,
}

impl NativeVideoStreamHandle {
    pub fn new(
        track: &ClassInstance<'_, NativeMediaStreamTrack>,
        options: NativeVideoStreamOptions,
        budget: GenerationQueueBudget,
    ) -> napi::Result<Self> {
        let media_track = track.media_track()?;
        let MediaStreamTrack::Video(track) = media_track else {
            return Err(napi::Error::from_reason(
                "videoStream requires a video track",
            ));
        };
        let queue_size_frames =
            positive(options.queue_size_frames.unwrap_or(1), "queueSizeFrames")?;
        let reservation = reserve(&budget, video_stream_queue_bytes(queue_size_frames)?)?;
        Ok(Self {
            stream: Mutex::new(Some(NativeVideoStream::with_options(
                track,
                RtcVideoStreamOptions {
                    queue_size_frames: Some(queue_size_frames as usize),
                },
            ))),
            closed: AtomicBool::new(false),
            changed: Notify::new(),
            reservation: NativeQueueReservation::new(reservation),
            last_dropped_frames: AtomicU64::new(0),
        })
    }
}

#[napi]
impl NativeVideoStreamHandle {
    #[napi(getter)]
    pub fn dropped_frames(&self) -> BigInt {
        let dropped_frames = lock(&self.stream)
            .as_ref()
            .map(NativeVideoStream::dropped_frames)
            .unwrap_or_else(|| self.last_dropped_frames.load(Ordering::Relaxed));
        self.last_dropped_frames
            .store(dropped_frames, Ordering::Relaxed);
        dropped_frames.into()
    }

    #[napi]
    pub async fn next_frame(&self) -> napi::Result<Option<NativeVideoFrameEvent>> {
        let changed = self.changed.notified();
        if self.closed.load(Ordering::Acquire) {
            return Ok(None);
        }
        let Some(mut stream) = lock(&self.stream).take() else {
            return Err(napi::Error::from_reason(
                "video stream already has a pending read",
            ));
        };
        let result = tokio::select! {
            frame = stream.next() => frame.map(video_frame).transpose(),
            _ = changed => {
                self.last_dropped_frames
                    .store(stream.dropped_frames(), Ordering::Relaxed);
                stream.close();
                self.reservation.release();
                return Ok(None);
            },
        };
        self.last_dropped_frames
            .store(stream.dropped_frames(), Ordering::Relaxed);
        if self.closed.load(Ordering::Acquire) {
            stream.close();
            self.reservation.release();
        } else {
            *lock(&self.stream) = Some(stream);
        }
        result
    }

    #[napi]
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.changed.notify_one();
        if let Some(mut stream) = lock(&self.stream).take() {
            self.last_dropped_frames
                .store(stream.dropped_frames(), Ordering::Relaxed);
            stream.close();
            self.reservation.release();
        }
    }
}

impl Drop for NativeVideoStreamHandle {
    fn drop(&mut self) {
        self.close();
    }
}

fn video_frame(
    frame: libwebrtc::video_frame::BoxVideoFrame,
) -> napi::Result<NativeVideoFrameEvent> {
    let i420 = frame.buffer.as_ref().to_i420();
    let width = libwebrtc::video_frame::VideoBuffer::width(&i420);
    let height = libwebrtc::video_frame::VideoBuffer::height(&i420);
    let chroma_width = width.div_ceil(2);
    let chroma_height = height.div_ceil(2);
    let (stride_y, stride_u, stride_v) = i420.strides();
    let (y, u, v) = i420.data();
    let mut data = Vec::with_capacity(i420_size(width, height)?);
    copy_from_plane(
        y,
        stride_y as usize,
        width as usize,
        height as usize,
        &mut data,
    );
    copy_from_plane(
        u,
        stride_u as usize,
        chroma_width as usize,
        chroma_height as usize,
        &mut data,
    );
    copy_from_plane(
        v,
        stride_v as usize,
        chroma_width as usize,
        chroma_height as usize,
        &mut data,
    );
    Ok(NativeVideoFrameEvent {
        data: data.into(),
        width,
        height,
        timestamp_us: frame.timestamp_us.into(),
        rotation: frame.rotation as u32,
    })
}

fn copy_from_plane(
    source: &[u8],
    source_stride: usize,
    row_width: usize,
    rows: usize,
    destination: &mut Vec<u8>,
) {
    for row in 0..rows {
        let start = row * source_stride;
        destination.extend_from_slice(&source[start..start + row_width]);
    }
}

fn copy_to_plane(
    source: &[u8],
    row_width: usize,
    destination: &mut [u8],
    destination_stride: usize,
    rows: usize,
) {
    for row in 0..rows {
        let source_start = row * row_width;
        let destination_start = row * destination_stride;
        destination[destination_start..destination_start + row_width]
            .copy_from_slice(&source[source_start..source_start + row_width]);
    }
}

fn i420_size(width: u32, height: u32) -> napi::Result<usize> {
    if width == 0 || height == 0 {
        return Err(napi::Error::from_reason(
            "video dimensions must be positive",
        ));
    }
    if width > MAX_VIDEO_DIMENSION || height > MAX_VIDEO_DIMENSION {
        return Err(napi::Error::from_reason(
            "video dimensions exceed the native frame limit",
        ));
    }
    let luma = width
        .checked_mul(height)
        .ok_or_else(|| napi::Error::from_reason("video frame is too large"))?;
    if luma > MAX_VIDEO_PIXELS {
        return Err(napi::Error::from_reason(
            "video frame exceeds the native pixel limit",
        ));
    }
    let chroma = width
        .div_ceil(2)
        .checked_mul(height.div_ceil(2))
        .and_then(|value| value.checked_mul(2))
        .ok_or_else(|| napi::Error::from_reason("video frame is too large"))?;
    let bytes = usize::try_from(
        luma.checked_add(chroma)
            .ok_or_else(|| napi::Error::from_reason("video frame is too large"))?,
    )
    .map_err(|_| napi::Error::from_reason("video frame is too large"))?;
    if bytes > MAX_VIDEO_FRAME_BYTES {
        return Err(napi::Error::from_reason(
            "video frame exceeds the native byte limit",
        ));
    }
    Ok(bytes)
}

fn video_rotation(rotation: u32) -> napi::Result<VideoRotation> {
    match rotation {
        0 => Ok(VideoRotation::VideoRotation0),
        90 => Ok(VideoRotation::VideoRotation90),
        180 => Ok(VideoRotation::VideoRotation180),
        270 => Ok(VideoRotation::VideoRotation270),
        _ => Err(napi::Error::from_reason(
            "rotation must be 0, 90, 180, or 270",
        )),
    }
}

fn positive(value: u32, name: &str) -> napi::Result<u32> {
    if value == 0 {
        return Err(napi::Error::from_reason(format!("{name} must be positive")));
    }
    Ok(value)
}

fn positive_i32(value: i32, name: &str) -> napi::Result<i32> {
    if value <= 0 {
        return Err(napi::Error::from_reason(format!("{name} must be positive")));
    }
    Ok(value)
}

fn audio_queue_size(value: u32, sample_rate: u32, channels: u32) -> napi::Result<u32> {
    if value == 0 || !value.is_multiple_of(10) {
        return Err(napi::Error::from_reason(
            "queueSizeMs must be a positive multiple of 10",
        ));
    }
    audio_source_queue_bytes(value, sample_rate, channels)?;
    Ok(value)
}

fn native_audio_value(value: u32, name: &str, max: u32) -> napi::Result<u32> {
    let value = positive(value, name)?;
    if value > max {
        return Err(napi::Error::from_reason(format!(
            "{name} exceeds the native audio limit"
        )));
    }
    Ok(value)
}

fn native_audio_stream_value(value: i32, name: &str, max: u32) -> napi::Result<i32> {
    let value = positive_i32(value, name)?;
    if value as u32 > max {
        return Err(napi::Error::from_reason(format!(
            "{name} exceeds the native audio limit"
        )));
    }
    Ok(value)
}

fn reserve_capacity(
    budget: &GenerationQueueBudget,
    bytes: usize,
) -> napi::Result<Option<QueueReservation>> {
    if bytes == 0 {
        return Ok(None);
    }
    reserve(budget, bytes).map(Some)
}

fn reserve(budget: &GenerationQueueBudget, bytes: usize) -> napi::Result<QueueReservation> {
    budget
        .reserve(bytes)
        .map_err(|_| napi::Error::from_reason("native WebRTC queue byte budget is saturated"))
}

fn audio_frame_bytes(samples: usize) -> napi::Result<usize> {
    let bytes = samples
        .checked_mul(std::mem::size_of::<i16>())
        .ok_or_else(|| napi::Error::from_reason("audio frame is too large"))?;
    if bytes > MAX_AUDIO_FRAME_BYTES {
        return Err(napi::Error::from_reason(
            "audio frame exceeds the native byte limit",
        ));
    }
    Ok(bytes)
}

fn audio_source_queue_bytes(
    queue_size_ms: u32,
    sample_rate: u32,
    channels: u32,
) -> napi::Result<usize> {
    let bytes = u64::from(queue_size_ms / 10)
        .checked_mul(u64::from(sample_rate).div_ceil(100))
        .and_then(|value| value.checked_mul(u64::from(channels)))
        .and_then(|value| value.checked_mul(2))
        // libwebrtc reserves both the queue and its notification threshold.
        .and_then(|value| value.checked_mul(2))
        .ok_or_else(|| napi::Error::from_reason("audio queue is too large"))?;
    queue_bytes(bytes, "audio queue is too large")
}

fn audio_stream_queue_bytes(
    sample_rate: u32,
    channels: u32,
    queue_size_frames: u32,
) -> napi::Result<usize> {
    let bytes = u64::from(sample_rate)
        .div_ceil(100)
        .checked_mul(u64::from(channels))
        .and_then(|value| value.checked_mul(2))
        .and_then(|value| value.checked_mul(u64::from(queue_size_frames)))
        .ok_or_else(|| napi::Error::from_reason("audio stream queue is too large"))?;
    queue_bytes(bytes, "audio stream queue is too large")
}

fn source_frame_bytes(frame_bytes: usize) -> napi::Result<usize> {
    queue_bytes(
        u64::try_from(frame_bytes)
            .ok()
            .and_then(|value| value.checked_mul(2))
            .ok_or_else(|| napi::Error::from_reason("video source queue is too large"))?,
        "video source queue is too large",
    )
}

fn video_stream_queue_bytes(queue_size_frames: u32) -> napi::Result<usize> {
    let bytes = u64::from(queue_size_frames)
        .checked_mul(MAX_VIDEO_FRAME_BYTES as u64)
        .ok_or_else(|| napi::Error::from_reason("video stream queue is too large"))?;
    queue_bytes(bytes, "video stream queue is too large")
}

fn queue_bytes(bytes: u64, error: &'static str) -> napi::Result<usize> {
    let bytes = usize::try_from(bytes).map_err(|_| napi::Error::from_reason(error))?;
    if bytes > u32::MAX as usize {
        return Err(napi::Error::from_reason(error));
    }
    Ok(bytes)
}

fn label(kind: &str) -> String {
    format!(
        "ackerdb-{kind}-{}",
        TRACK_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
