mod media;
mod peer;
mod queue;
mod types;

use libwebrtc::{MediaType, peer_connection_factory::PeerConnectionFactory};
use napi::bindgen_prelude::{BigInt, ClassInstance};
use napi_derive::napi;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

use crate::queue::{GenerationQueueBudget, QueueBudget};

pub use media::{
    NativeAudioSourceHandle, NativeAudioStreamHandle, NativeVideoSourceHandle,
    NativeVideoStreamHandle,
};
pub use peer::NativePeerConnection;
pub use types::NativeRtcConfiguration;

static TRACK_CLONE_SEQUENCE: AtomicU64 = AtomicU64::new(1);
const DEFAULT_MAX_QUEUED_BYTES: u32 = 64 * 1024 * 1024;

#[napi]
pub fn native_abi_version() -> u32 {
    // Keep one non-lazy external data symbol in the Mach-O import table. Some
    // Apple linkers otherwise leave an odd indirect-symbol count and place the
    // following string table at a four-byte rather than eight-byte boundary.
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            static environ: *const *const std::ffi::c_char;
        }
        std::hint::black_box(std::ptr::addr_of!(environ));
    }
    6
}

#[napi]
pub struct NativeRtcEngine {
    factory: Option<PeerConnectionFactory>,
    queue_budget: Option<QueueBudget>,
}

#[napi(object)]
#[derive(Default)]
pub struct NativeRtcEngineOptions {
    pub ignored_interfaces: Option<Vec<String>>,
    pub ignored_adapter_types: Option<Vec<String>>,
    pub max_queued_bytes: Option<u32>,
}

#[napi]
pub struct NativeGenerationBudget {
    budget: Mutex<Option<GenerationQueueBudget>>,
    closed: AtomicBool,
    last_reserved_bytes: AtomicU64,
    last_saturations: AtomicU64,
}

impl NativeGenerationBudget {
    fn new(budget: GenerationQueueBudget) -> Self {
        Self {
            budget: Mutex::new(Some(budget)),
            closed: AtomicBool::new(false),
            last_reserved_bytes: AtomicU64::new(0),
            last_saturations: AtomicU64::new(0),
        }
    }

    pub(crate) fn budget(&self) -> napi::Result<GenerationQueueBudget> {
        if self.closed.load(Ordering::Acquire) {
            return Err(napi::Error::from_reason("native generation is closed"));
        }
        self.budget
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or_else(|| napi::Error::from_reason("native generation is closed"))
    }

    fn metrics(&self) -> (u64, u64) {
        let metrics = self
            .budget
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .map(|budget| (budget.reserved_bytes(), budget.saturations()));
        if let Some((reserved_bytes, saturations)) = metrics {
            self.last_reserved_bytes
                .store(reserved_bytes, Ordering::Relaxed);
            self.last_saturations.store(saturations, Ordering::Relaxed);
            return (reserved_bytes, saturations);
        }
        (
            self.last_reserved_bytes.load(Ordering::Relaxed),
            self.last_saturations.load(Ordering::Relaxed),
        )
    }
}

#[napi]
impl NativeGenerationBudget {
    #[napi(getter)]
    pub fn reserved_bytes(&self) -> BigInt {
        self.metrics().0.into()
    }

    #[napi(getter)]
    pub fn saturations(&self) -> BigInt {
        self.metrics().1.into()
    }

    #[napi]
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(budget) = self
            .budget
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            self.last_reserved_bytes
                .store(budget.reserved_bytes(), Ordering::Relaxed);
            self.last_saturations
                .store(budget.saturations(), Ordering::Relaxed);
            budget.close();
        }
    }
}

#[napi]
impl NativeRtcEngine {
    #[napi(constructor)]
    pub fn new(options: Option<NativeRtcEngineOptions>) -> napi::Result<Self> {
        let options = options.unwrap_or_default();
        let queue_budget =
            QueueBudget::new(options.max_queued_bytes.unwrap_or(DEFAULT_MAX_QUEUED_BYTES))
                .map_err(napi::Error::from_reason)?;
        Ok(Self {
            factory: Some(PeerConnectionFactory::with_network_configuration(
                options.ignored_interfaces.unwrap_or_default(),
                network_ignore_mask(
                    options
                        .ignored_adapter_types
                        .unwrap_or_else(|| vec!["loopback".to_owned()]),
                )?,
            )),
            queue_budget: Some(queue_budget),
        })
    }

    #[napi]
    pub fn close(&mut self) {
        self.factory.take();
        self.queue_budget.take();
    }

    #[napi]
    pub fn create_generation_budget(
        &self,
        max_queued_bytes: u32,
    ) -> napi::Result<NativeGenerationBudget> {
        self.queue_budget()?
            .generation(max_queued_bytes)
            .map(NativeGenerationBudget::new)
            .map_err(napi::Error::from_reason)
    }

    #[napi(getter)]
    pub fn reserved_bytes(&self) -> BigInt {
        self.queue_budget
            .as_ref()
            .map(QueueBudget::reserved_bytes)
            .unwrap_or_default()
            .into()
    }

    #[napi(getter)]
    pub fn queue_saturations(&self) -> BigInt {
        self.queue_budget
            .as_ref()
            .map(QueueBudget::saturations)
            .unwrap_or_default()
            .into()
    }

    #[napi]
    pub fn create_peer_connection(
        &self,
        configuration: Option<NativeRtcConfiguration>,
        budget: ClassInstance<'_, NativeGenerationBudget>,
    ) -> napi::Result<NativePeerConnection> {
        NativePeerConnection::new(
            self.factory()?,
            configuration.unwrap_or_default(),
            budget.budget()?,
        )
    }

    #[napi]
    pub fn create_audio_source(
        &self,
        options: Option<media::NativeAudioSourceOptions>,
        budget: ClassInstance<'_, NativeGenerationBudget>,
    ) -> napi::Result<NativeAudioSourceHandle> {
        NativeAudioSourceHandle::new(
            self.factory()?,
            options.unwrap_or_default(),
            budget.budget()?,
        )
    }

    #[napi]
    pub fn create_audio_stream(
        &self,
        track: napi::bindgen_prelude::ClassInstance<'_, peer::NativeMediaStreamTrack>,
        options: Option<media::NativeAudioStreamOptions>,
        budget: ClassInstance<'_, NativeGenerationBudget>,
    ) -> napi::Result<NativeAudioStreamHandle> {
        self.factory()?;
        NativeAudioStreamHandle::new(&track, options.unwrap_or_default(), budget.budget()?)
    }

    #[napi]
    pub fn create_video_source(
        &self,
        options: media::NativeVideoSourceOptions,
        budget: ClassInstance<'_, NativeGenerationBudget>,
    ) -> napi::Result<NativeVideoSourceHandle> {
        NativeVideoSourceHandle::new(self.factory()?, options, budget.budget()?)
    }

    #[napi]
    pub fn create_video_stream(
        &self,
        track: napi::bindgen_prelude::ClassInstance<'_, peer::NativeMediaStreamTrack>,
        options: Option<media::NativeVideoStreamOptions>,
        budget: ClassInstance<'_, NativeGenerationBudget>,
    ) -> napi::Result<NativeVideoStreamHandle> {
        self.factory()?;
        NativeVideoStreamHandle::new(&track, options.unwrap_or_default(), budget.budget()?)
    }

    #[napi]
    pub fn clone_track(
        &self,
        track: ClassInstance<'_, peer::NativeMediaStreamTrack>,
    ) -> napi::Result<peer::NativeMediaStreamTrack> {
        let sequence = TRACK_CLONE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        Ok(peer::NativeMediaStreamTrack::new(
            self.factory()?.clone_media_stream_track(
                &format!("ackerdb-clone-{sequence}"),
                &track.media_track()?,
            ),
        ))
    }

    #[napi]
    pub fn get_rtp_sender_capabilities(
        &self,
        kind: String,
    ) -> napi::Result<peer::NativeRtpCapabilities> {
        Ok(peer::native_rtp_capabilities(
            self.factory()?
                .get_rtp_sender_capabilities(media_type(&kind)?),
        ))
    }

    #[napi]
    pub fn get_rtp_receiver_capabilities(
        &self,
        kind: String,
    ) -> napi::Result<peer::NativeRtpCapabilities> {
        Ok(peer::native_rtp_capabilities(
            self.factory()?
                .get_rtp_receiver_capabilities(media_type(&kind)?),
        ))
    }

    fn factory(&self) -> napi::Result<PeerConnectionFactory> {
        self.factory
            .clone()
            .ok_or_else(|| napi::Error::from_reason("WebRTC engine is closed"))
    }

    fn queue_budget(&self) -> napi::Result<&QueueBudget> {
        self.queue_budget
            .as_ref()
            .ok_or_else(|| napi::Error::from_reason("WebRTC engine is closed"))
    }
}

impl Default for NativeRtcEngine {
    fn default() -> Self {
        Self::new(None).expect("default WebRTC network configuration is valid")
    }
}

fn network_ignore_mask(types: Vec<String>) -> napi::Result<i32> {
    types.into_iter().try_fold(0, |mask, kind| {
        let value = match kind.as_str() {
            "unknown" => 0,
            "ethernet" => 1 << 0,
            "wifi" => 1 << 1,
            "cellular" => 1 << 2,
            "vpn" => 1 << 3,
            "loopback" => 1 << 4,
            "any" => 1 << 5,
            "cellular-2g" => 1 << 6,
            "cellular-3g" => 1 << 7,
            "cellular-4g" => 1 << 8,
            "cellular-5g" => 1 << 9,
            _ => {
                return Err(napi::Error::from_reason(format!(
                    "unsupported ignored adapter type \"{kind}\"",
                )));
            }
        };
        Ok(mask | value)
    })
}

fn media_type(kind: &str) -> napi::Result<MediaType> {
    match kind {
        "audio" => Ok(MediaType::Audio),
        "video" => Ok(MediaType::Video),
        _ => Err(napi::Error::from_reason("kind must be audio or video")),
    }
}
