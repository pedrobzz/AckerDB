use std::str::FromStr;

use libwebrtc::{
    ice_candidate::IceCandidate,
    peer_connection_factory::{
        ContinualGatheringPolicy, IceServer, IceTransportsType, RtcConfiguration,
    },
    session_description::{SdpType, SessionDescription},
};
use napi_derive::napi;

#[napi(object)]
#[derive(Clone, Debug)]
pub struct NativeIceServer {
    pub urls: Vec<String>,
    pub username: Option<String>,
    pub credential: Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug, Default)]
pub struct NativeRtcConfiguration {
    pub ice_servers: Option<Vec<NativeIceServer>>,
    pub ice_transport_policy: Option<String>,
    pub min_port: Option<u32>,
    pub max_port: Option<u32>,
    pub ice_connection_receiving_timeout_ms: Option<u32>,
    pub ice_backup_candidate_pair_ping_interval_ms: Option<u32>,
    pub ice_check_interval_strong_connectivity_ms: Option<u32>,
    pub ice_check_interval_weak_connectivity_ms: Option<u32>,
    pub ice_check_min_interval_ms: Option<u32>,
    pub ice_unwritable_timeout_ms: Option<u32>,
    pub ice_inactive_timeout_ms: Option<u32>,
    pub stun_candidate_keepalive_interval_ms: Option<u32>,
}

impl NativeRtcConfiguration {
    pub fn to_rtc(&self) -> napi::Result<RtcConfiguration> {
        let ice_transport_type = match self.ice_transport_policy.as_deref() {
            None | Some("all") => IceTransportsType::All,
            Some("relay") => IceTransportsType::Relay,
            Some(value) => {
                return Err(napi::Error::from_reason(format!(
                    "unsupported iceTransportPolicy \"{value}\""
                )));
            }
        };
        Ok(RtcConfiguration {
            ice_servers: self
                .ice_servers
                .clone()
                .unwrap_or_default()
                .into_iter()
                .map(|server| IceServer {
                    urls: server.urls,
                    username: server.username.unwrap_or_default(),
                    password: server.credential.unwrap_or_default(),
                })
                .collect(),
            // Match browser RTCPeerConnection behavior: finish one gathering
            // generation and use restartIce() for a new network generation.
            continual_gathering_policy: ContinualGatheringPolicy::GatherOnce,
            ice_transport_type,
            min_port: port(self.min_port, "minPort")?,
            max_port: port(self.max_port, "maxPort")?,
            ice_connection_receiving_timeout_ms: self.ice_connection_receiving_timeout_ms,
            ice_backup_candidate_pair_ping_interval_ms: self
                .ice_backup_candidate_pair_ping_interval_ms,
            ice_check_interval_strong_connectivity_ms: self
                .ice_check_interval_strong_connectivity_ms,
            ice_check_interval_weak_connectivity_ms: self.ice_check_interval_weak_connectivity_ms,
            ice_check_min_interval_ms: self.ice_check_min_interval_ms,
            ice_unwritable_timeout_ms: self.ice_unwritable_timeout_ms,
            ice_inactive_timeout_ms: self.ice_inactive_timeout_ms,
            stun_candidate_keepalive_interval_ms: self.stun_candidate_keepalive_interval_ms,
        })
    }
}

fn port(value: Option<u32>, name: &str) -> napi::Result<u16> {
    value
        .map(|value| {
            u16::try_from(value)
                .map_err(|_| napi::Error::from_reason(format!("{name} exceeds 65535")))
        })
        .transpose()
        .map(|value| value.unwrap_or_default())
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct NativeSessionDescription {
    pub r#type: String,
    pub sdp: String,
}

impl NativeSessionDescription {
    pub fn parse(self) -> napi::Result<SessionDescription> {
        let kind = SdpType::from_str(&self.r#type).map_err(napi::Error::from_reason)?;
        SessionDescription::parse(&self.sdp, kind)
            .map_err(|error| napi::Error::from_reason(error.to_string()))
    }
}

impl From<SessionDescription> for NativeSessionDescription {
    fn from(value: SessionDescription) -> Self {
        Self {
            r#type: value.sdp_type().to_string(),
            sdp: value.to_string(),
        }
    }
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct NativeIceCandidate {
    pub candidate: String,
    pub sdp_mid: String,
    pub sdp_m_line_index: i32,
}

impl NativeIceCandidate {
    pub fn parse(self) -> napi::Result<IceCandidate> {
        IceCandidate::parse(&self.sdp_mid, self.sdp_m_line_index, &self.candidate)
            .map_err(|error| napi::Error::from_reason(error.to_string()))
    }
}

impl From<IceCandidate> for NativeIceCandidate {
    fn from(value: IceCandidate) -> Self {
        Self {
            candidate: value.candidate(),
            sdp_mid: value.sdp_mid(),
            sdp_m_line_index: value.sdp_mline_index(),
        }
    }
}

pub fn rtc_error(error: impl ToString) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}
