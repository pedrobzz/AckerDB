mod media;
mod peer;
mod queue;
mod types;

use libwebrtc::{MediaType, peer_connection_factory::PeerConnectionFactory};
use napi::bindgen_prelude::ClassInstance;
use napi_derive::napi;
use std::sync::atomic::{AtomicU64, Ordering};

pub use media::{
    NativeAudioSourceHandle, NativeAudioStreamHandle, NativeVideoSourceHandle,
    NativeVideoStreamHandle,
};
pub use peer::NativePeerConnection;
pub use types::NativeRtcConfiguration;

static TRACK_CLONE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

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
}

#[napi(object)]
#[derive(Default)]
pub struct NativeRtcEngineOptions {
    pub ignored_interfaces: Option<Vec<String>>,
    pub ignored_adapter_types: Option<Vec<String>>,
}

#[napi]
impl NativeRtcEngine {
    #[napi(constructor)]
    pub fn new(options: Option<NativeRtcEngineOptions>) -> napi::Result<Self> {
        let options = options.unwrap_or_default();
        Ok(Self {
            factory: Some(PeerConnectionFactory::with_network_configuration(
                options.ignored_interfaces.unwrap_or_default(),
                network_ignore_mask(
                    options
                        .ignored_adapter_types
                        .unwrap_or_else(|| vec!["loopback".to_owned()]),
                )?,
            )),
        })
    }

    #[napi]
    pub fn close(&mut self) {
        self.factory.take();
    }

    #[napi]
    pub fn create_peer_connection(
        &self,
        configuration: Option<NativeRtcConfiguration>,
    ) -> napi::Result<NativePeerConnection> {
        NativePeerConnection::new(self.factory()?, configuration.unwrap_or_default())
    }

    #[napi]
    pub fn create_audio_source(
        &self,
        options: Option<media::NativeAudioSourceOptions>,
    ) -> napi::Result<NativeAudioSourceHandle> {
        NativeAudioSourceHandle::new(self.factory()?, options.unwrap_or_default())
    }

    #[napi]
    pub fn create_audio_stream(
        &self,
        track: napi::bindgen_prelude::ClassInstance<'_, peer::NativeMediaStreamTrack>,
        options: Option<media::NativeAudioStreamOptions>,
    ) -> napi::Result<NativeAudioStreamHandle> {
        self.factory()?;
        NativeAudioStreamHandle::new(&track, options.unwrap_or_default())
    }

    #[napi]
    pub fn create_video_source(
        &self,
        options: media::NativeVideoSourceOptions,
    ) -> napi::Result<NativeVideoSourceHandle> {
        NativeVideoSourceHandle::new(self.factory()?, options)
    }

    #[napi]
    pub fn create_video_stream(
        &self,
        track: napi::bindgen_prelude::ClassInstance<'_, peer::NativeMediaStreamTrack>,
        options: Option<media::NativeVideoStreamOptions>,
    ) -> napi::Result<NativeVideoStreamHandle> {
        self.factory()?;
        NativeVideoStreamHandle::new(&track, options.unwrap_or_default())
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
        self.factory.clone().ok_or_else(|| {
            napi::Error::from_reason("WebRTC engine is closed")
        })
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
