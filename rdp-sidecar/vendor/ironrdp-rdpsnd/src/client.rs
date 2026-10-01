use std::borrow::Cow;

use ironrdp_core::{Decode as _, Encode as _, EncodeResult, ReadCursor, cast_length, impl_as_any};
use ironrdp_pdu::gcc::ChannelName;
use ironrdp_pdu::{PduResult, encode_err, pdu_other_err};
use ironrdp_svc::{CompressionCondition, SvcClientProcessor, SvcMessage, SvcProcessor};
use tracing::{debug, error, warn};

use crate::pdu::{self, AudioFormat, PitchPdu, ServerAudioFormatPdu, TrainingPdu, VolumePdu};
use crate::server::RdpsndSvcMessages;

pub trait RdpsndClientHandler: Send + core::fmt::Debug {
    fn get_flags(&self) -> pdu::AudioFormatFlags {
        pdu::AudioFormatFlags::empty()
    }

    fn get_formats(&self) -> &[AudioFormat];

    // termiHub vendored-fork change (#1812): whether the handler can play a
    // server-advertised `format`. Compressed formats (ADPCM/Opus) are advertised
    // by the server with a server-chosen block layout (`n_block_align`,
    // `wSamplesPerBlock`, coefficient `data`) the client cannot predict, so the
    // exact-equality intersection used for PCM in `client_formats()` can never
    // select one. Overriding this lets a handler accept a server format by codec
    // regardless of its block layout; `client_formats()` then echoes that exact
    // `AudioFormat` back, so `wave` still receives concrete, decodable parameters.
    // The default preserves the pre-#1812 exact-match behaviour (accept only what
    // `get_formats()` advertises verbatim).
    fn accepts_format(&self, format: &AudioFormat) -> bool {
        self.get_formats().contains(format)
    }

    // termiHub vendored-fork change (#1773): the handler receives the concrete
    // negotiated `AudioFormat` instead of a bare `format_no` index. See the note
    // in this crate's Cargo.toml — upstream passed only the index into the
    // non-deterministically-ordered, then-discarded client-format list, so a
    // multi-format handler could not map a `wave` buffer back to its rate.
    fn wave(&mut self, format: &AudioFormat, ts: u32, data: Cow<'_, [u8]>);

    fn set_volume(&mut self, volume: VolumePdu);

    fn set_pitch(&mut self, pitch: PitchPdu);

    fn close(&mut self);
}

#[derive(Debug)]
pub struct NoopRdpsndBackend;

impl RdpsndClientHandler for NoopRdpsndBackend {
    fn get_formats(&self) -> &[AudioFormat] {
        &[]
    }

    fn wave(&mut self, _format: &AudioFormat, _ts: u32, _data: Cow<'_, [u8]>) {}

    fn set_volume(&mut self, _volume: VolumePdu) {}

    fn set_pitch(&mut self, _pitch: PitchPdu) {}

    fn close(&mut self) {}
}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
enum RdpsndState {
    Start,
    WaitingForTraining,
    Ready,
    /// termiHub vendored-fork state (#3510, upstream `2d9a9bf1`): waiting for
    /// the bare Wave payload that follows a pre-v8 WaveInfo PDU.
    ExpectingWave,
    Stop,
}

/// Pre-v8 WaveInfo fields kept until the following bare Wave payload arrives
/// (termiHub vendored-fork change #3510, upstream `2d9a9bf1`).
#[derive(Debug, Clone)]
struct PendingWave {
    timestamp: u16,
    format_no: u16,
    block_no: u8,
    data_prefix: [u8; 4],
    /// Total audio length including the four-byte prefix (MS-RDPEA `n`).
    audio_length: u16,
}

/// Required for rdpdr to work: [\[MS-RDPEFS\] Appendix A<1>]
///
/// [\[MS-RDPEFS\] Appendix A<1>]: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpefs/fd28bfd9-dae2-4a78-abe1-b4efa208b7aa#Appendix_A_1
#[derive(Debug)]
pub struct Rdpsnd {
    handler: Box<dyn RdpsndClientHandler>,
    state: RdpsndState,
    server_format: Option<ServerAudioFormatPdu>,
    /// termiHub vendored-fork field (#1773): the exact, order-preserving list of
    /// formats sent to the server in `client_formats()`. The server's `Wave2`
    /// `format_no` indexes this list (the client-format list per MS-RDPEA), so
    /// remembering it is what lets `wave` recover the concrete `AudioFormat`
    /// rather than a bare index into a list the handler never sees.
    negotiated_formats: Vec<AudioFormat>,
    /// termiHub vendored-fork field (#3510): the WaveInfo awaiting its payload
    /// while in [`RdpsndState::ExpectingWave`].
    pending_wave: Option<PendingWave>,
}

impl Rdpsnd {
    pub const NAME: ChannelName = ChannelName::from_static(b"rdpsnd\0\0");

    pub fn new(handler: Box<dyn RdpsndClientHandler>) -> Self {
        Self {
            handler,
            state: RdpsndState::Start,
            server_format: None,
            negotiated_formats: Vec::new(),
            pending_wave: None,
        }
    }

    /// The negotiated format a server `wFormatNo` refers to.
    ///
    /// termiHub vendored-fork change (#3499, upstream `2d9a9bf1`): MS-RDPEA's
    /// `wFormatNo` indexes the *client* format list; upstream 0.9.0 indexed the
    /// server's advertised list, which differs as soon as the client drops a
    /// format.
    pub fn get_format(&self, format_no: u16) -> PduResult<&AudioFormat> {
        self.negotiated_formats
            .get(usize::from(format_no))
            .ok_or_else(|| pdu_other_err!("invalid format"))
    }

    pub fn version(&self) -> PduResult<pdu::Version> {
        let server_format = self
            .server_format
            .as_ref()
            .ok_or_else(|| pdu_other_err!("invalid state - no version"))?;

        Ok(server_format.version)
    }

    pub fn client_formats(&mut self) -> PduResult<RdpsndSvcMessages> {
        // Windows seems to be confused if the client replies with more formats, or unknown formats (e.g.: opus).
        // We ensure to only send supported formats in common with the server.
        //
        // termiHub vendored-fork change (#1773, extended #1812): iterate the
        // server's advertised formats in order and keep the ones the handler
        // accepts. PCM formats match by structural equality (the handler
        // advertises a fixed table, so `accepts_format` defaults to a `contains`
        // check); compressed formats (ADPCM) cannot be predicted — the server
        // chooses the block layout — so a handler overriding `accepts_format`
        // accepts them by codec and we echo the server's exact `AudioFormat` back,
        // which is what gives `wave` concrete, decodable block parameters. This
        // also makes the sent list deterministic (server order) where upstream's
        // `HashSet` intersection was not.
        let server_formats = self
            .server_format
            .as_ref()
            .ok_or_else(|| pdu_other_err!("invalid state - no server format"))?
            .formats
            .clone();
        let formats: Vec<AudioFormat> = server_formats
            .into_iter()
            .filter(|format| self.handler.accepts_format(format))
            .collect();

        // termiHub vendored-fork change (#1773): remember the exact list we send,
        // in the exact order it is encoded, so a later `Wave2 { format_no }` can be
        // resolved to the concrete `AudioFormat` in `process()` below.
        self.negotiated_formats = formats.clone();

        let pdu = pdu::ClientAudioFormatPdu {
            version: self.version()?,
            flags: self.handler.get_flags() | pdu::AudioFormatFlags::ALIVE,
            formats,
            volume_left: 0xFFFF,
            volume_right: 0xFFFF,
            pitch: 0x00010000,
            dgram_port: 0,
        };
        Ok(RdpsndSvcMessages::new(vec![
            pdu::ClientAudioOutputPdu::AudioFormat(pdu).into(),
        ]))
    }

    pub fn quality_mode(&mut self) -> PduResult<RdpsndSvcMessages> {
        let pdu = pdu::QualityModePdu {
            quality_mode: pdu::QualityMode::High,
        };
        Ok(RdpsndSvcMessages::new(vec![
            pdu::ClientAudioOutputPdu::QualityMode(pdu).into(),
        ]))
    }

    pub fn training_confirm(&mut self, pdu: &TrainingPdu) -> PduResult<RdpsndSvcMessages> {
        let pack_size: EncodeResult<_> = cast_length!("wPackSize", pdu.data.len());
        let pack_size = pack_size.map_err(|e| encode_err!(e))?;
        let pdu = pdu::TrainingConfirmPdu {
            timestamp: pdu.timestamp,
            pack_size,
        };
        Ok(RdpsndSvcMessages::new(vec![
            pdu::ClientAudioOutputPdu::TrainingConfirm(pdu).into(),
        ]))
    }

    pub fn wave_confirm(&mut self, timestamp: u16, block_no: u8) -> PduResult<RdpsndSvcMessages> {
        let pdu = pdu::WaveConfirmPdu { timestamp, block_no };
        Ok(RdpsndSvcMessages::new(vec![
            pdu::ClientAudioOutputPdu::WaveConfirm(pdu).into(),
        ]))
    }

    /// Hand a wave block to the handler with the concrete negotiated format.
    ///
    /// termiHub vendored-fork change (#1773): `format_no` is resolved against the
    /// exact list advertised in `client_formats()`. An out-of-range `format_no`
    /// (a misbehaving server) is dropped rather than guessed; the caller still
    /// confirms the block.
    fn play_wave(&mut self, format_no: u16, ts: u32, data: Cow<'_, [u8]>) {
        match self.negotiated_formats.get(usize::from(format_no)) {
            Some(format) => self.handler.wave(format, ts, data),
            None => warn!(
                format_no,
                n_formats = self.negotiated_formats.len(),
                "Ignoring wave with out-of-range format_no"
            ),
        }
    }

    /// (Re)start format negotiation for a server Audio Formats PDU.
    fn begin_format_negotiation(&mut self, af: ServerAudioFormatPdu) -> PduResult<Vec<SvcMessage>> {
        self.server_format = Some(af);
        self.pending_wave = None;
        self.state = RdpsndState::WaitingForTraining;
        let mut msgs: Vec<SvcMessage> = self.client_formats()?.into();
        if self.version()? >= pdu::Version::V6 {
            let mut m = self.quality_mode()?.into();
            msgs.append(&mut m);
        }
        Ok(msgs)
    }

    /// Complete a pre-v8 transfer from the pending WaveInfo and the bare Wave
    /// payload bytes (termiHub vendored-fork change #3510, upstream `2d9a9bf1`).
    fn finish_pending_wave(&mut self, wave_payload: &[u8]) -> PduResult<Vec<SvcMessage>> {
        self.state = RdpsndState::Ready;
        let Some(pending) = self.pending_wave.take() else {
            warn!("Received Wave payload without a pending WaveInfo");
            return Ok(vec![]);
        };

        // The payload is bPad[4] followed by the audio after the WaveInfo `Data`
        // prefix; its total wire length equals the WaveInfo `audio_length` (`n`).
        // `WavePdu::decode` guarantees `audio_length >= 4`.
        let expected_len = usize::from(pending.audio_length);
        match wave_payload.get(4..expected_len) {
            Some(remaining) if wave_payload.len() >= expected_len => {
                let mut data = Vec::with_capacity(expected_len);
                data.extend_from_slice(&pending.data_prefix);
                data.extend_from_slice(remaining);
                self.play_wave(pending.format_no, u32::from(pending.timestamp), data.into());
            }
            _ => {
                // MS-RDPEA §3.2.5.2.1.6: still confirm so the server's latency
                // accounting advances.
                warn!(
                    got = wave_payload.len(),
                    expected = expected_len,
                    "Wave payload shorter than WaveInfo audio length; confirming without playback"
                );
            }
        }

        Ok(self.wave_confirm(pending.timestamp, pending.block_no)?.into())
    }
}

impl_as_any!(Rdpsnd);

impl SvcProcessor for Rdpsnd {
    fn channel_name(&self) -> ChannelName {
        Self::NAME
    }

    fn compression_condition(&self) -> CompressionCondition {
        CompressionCondition::Never
    }

    fn process(&mut self, payload: &[u8]) -> PduResult<Vec<SvcMessage>> {
        // termiHub vendored-fork change (#3510, upstream `2d9a9bf1`): the pre-v8
        // Wave payload has no RDPSND header (MS-RDPEA §2.2.3.4), so it must not be
        // decoded as a PDU.
        if self.state == RdpsndState::ExpectingWave {
            debug!(len = payload.len(), "Completing pending WaveInfo with Wave payload");
            return self.finish_pending_wave(payload);
        }

        // termiHub vendored-fork change (#3499, upstream `c87ab68e` "isolate
        // malformed encrypted waves"): a malformed audio PDU is dropped and the
        // channel state kept, so later valid audio still plays. Upstream 0.9.0
        // returned the decode error, which the session treats as fatal — one bad
        // RDPSND PDU tore down the whole desktop connection.
        let pdu = match pdu::ServerAudioOutputPdu::decode(&mut ReadCursor::new(payload)) {
            Ok(pdu) => pdu,
            Err(error) => {
                error!(?error, "Ignoring malformed RDPSND PDU");
                return Ok(vec![]);
            }
        };

        debug!(?pdu, ?self.state);
        let msg = match self.state {
            RdpsndState::Start => {
                let pdu::ServerAudioOutputPdu::AudioFormat(af) = pdu else {
                    error!("Invalid pdu");
                    self.state = RdpsndState::Stop;
                    return Ok(vec![]);
                };
                self.begin_format_negotiation(af)?
            }
            RdpsndState::WaitingForTraining => {
                let pdu::ServerAudioOutputPdu::Training(pdu) = pdu else {
                    error!("Invalid PDU");
                    self.state = RdpsndState::Stop;
                    return Ok(vec![]);
                };
                self.state = RdpsndState::Ready;
                self.training_confirm(&pdu)?.into()
            }
            RdpsndState::Ready => {
                match pdu {
                    // termiHub vendored-fork change (#3510, upstream `2d9a9bf1`):
                    // MS-RDPEA §2.2.3.3 WaveInfo only; the next SVC message is the
                    // bare Wave (§2.2.3.4). Some stacks concatenate the Wave after
                    // the WaveInfo in one buffer — finish at once when trailing
                    // bytes are present.
                    pdu::ServerAudioOutputPdu::Wave(pdu) => {
                        self.pending_wave = Some(PendingWave {
                            timestamp: pdu.timestamp,
                            format_no: pdu.format_no,
                            block_no: pdu.block_no,
                            data_prefix: pdu.data_prefix,
                            audio_length: pdu.audio_length,
                        });
                        self.state = RdpsndState::ExpectingWave;

                        // SNDPROLOG (4 bytes) + WaveInfo body; anything after it is
                        // a concatenated Wave payload.
                        let header_and_info = 4 + pdu.size();
                        if let Some(trailing) = payload.get(header_and_info..).filter(|t| !t.is_empty()) {
                            return self.finish_pending_wave(trailing);
                        }
                        return Ok(vec![]);
                    }
                    pdu::ServerAudioOutputPdu::Wave2(pdu) => {
                        self.play_wave(pdu.format_no, pdu.audio_timestamp, pdu.data);
                        return Ok(self.wave_confirm(pdu.timestamp, pdu.block_no)?.into());
                    }
                    pdu::ServerAudioOutputPdu::Volume(pdu) => {
                        self.handler.set_volume(pdu);
                    }
                    pdu::ServerAudioOutputPdu::Pitch(pdu) => {
                        self.handler.set_pitch(pdu);
                    }
                    pdu::ServerAudioOutputPdu::Close => {
                        self.handler.close();
                    }
                    pdu::ServerAudioOutputPdu::Training(pdu) => return Ok(self.training_confirm(&pdu)?.into()),
                    pdu::ServerAudioOutputPdu::AudioFormat(af) => {
                        self.handler.close();
                        return self.begin_format_negotiation(af);
                    }
                    // termiHub vendored-fork change (#3499, upstream `2d9a9bf1`):
                    // optional PDUs this client does not implement keep the
                    // channel alive instead of silencing audio for the session.
                    pdu::ServerAudioOutputPdu::CryptKey(_) | pdu::ServerAudioOutputPdu::WaveEncrypt(_) => {
                        warn!(?pdu, "Ignoring unsupported RDPSND PDU");
                    }
                }
                vec![]
            }
            state => {
                error!(?state, "Invalid state");
                vec![]
            }
        };

        Ok(msg)
    }
}

impl Drop for Rdpsnd {
    fn drop(&mut self) {
        self.handler.close();
    }
}

impl SvcClientProcessor for Rdpsnd {}
