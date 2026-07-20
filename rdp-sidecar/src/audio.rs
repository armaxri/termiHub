//! Audio output redirection (MS-RDPEAUDIO / `rdpsnd`) for the RDP sidecar
//! (#1764).
//!
//! IronRDP's [`Rdpsnd`](ironrdp::rdpsnd::client::Rdpsnd) static virtual channel
//! decodes the server's audio stream and drives an
//! [`RdpsndClientHandler`](ironrdp::rdpsnd::client::RdpsndClientHandler): the
//! handler advertises the [`AudioFormat`]s it can play via
//! [`get_formats`](RdpsndClientHandler::get_formats), and the channel calls
//! [`wave`](RdpsndClientHandler::wave) with each decoded audio buffer in one of
//! those formats. [`RdpAudioBackend`] plays those buffers on a **host audio
//! output device**, so the remote session's sound is heard locally.
//!
//! ## Where playback happens
//!
//! Playback stays entirely inside the sidecar process — the decoded PCM never
//! crosses the IPC boundary to the desktop app. A dedicated OS thread owns the
//! [`rodio`] output stream and sink (both `!Send`, and callback-driven), fed
//! decoded samples over a channel; the handler only holds the `Send` sender, so
//! nothing audio-related touches the async session future.
//!
//! ## Scope (v1, PCM only)
//!
//! The handler advertises a **single** PCM format — 44.1 kHz, 16-bit, stereo —
//! and plays `wave` PDUs in it. One format is deliberate: IronRDP 0.9's
//! `wave(format_no, …)` reports an index into the *intersection* of the client
//! and server format lists, which IronRDP builds from a `HashSet` (non-deterministic
//! order) and does not expose to the handler — so with more than one advertised
//! format the handler cannot reliably map `format_no` back to a concrete format.
//! Advertising exactly one keeps that mapping unambiguous (`format_no` is always
//! `0`). Multi-format negotiation, ADPCM/Opus decode, and jitter/latency tuning
//! are follow-ups (see #1764).
//!
//! ## Platforms
//!
//! Audible playback is compiled for **macOS, Windows and Linux** — the three
//! platforms the bundle CI builds the sidecar for. On Linux [`rodio`] uses
//! [`cpal`]'s ALSA backend, which links `libasound2-dev` at build time (the
//! bundle CI installs it on its native `ubuntu` sidecar legs, #1772) and loads
//! `libasound.so.2` at runtime — present on every desktop Linux. Any other
//! target `cpal` cannot build for degrades to the no-op sink below (advertising
//! no formats, so the server streams nothing) rather than failing to compile.

use std::borrow::Cow;

use ironrdp::rdpsnd::client::RdpsndClientHandler;
use ironrdp::rdpsnd::pdu::{AudioFormat, PitchPdu, VolumePdu, WaveFormat};

/// Channels in the advertised PCM format (stereo).
const AUDIO_CHANNELS: u16 = 2;
/// Sample rate of the advertised PCM format, in Hz (CD quality).
const AUDIO_SAMPLE_RATE: u32 = 44_100;
/// Bit depth of the advertised PCM format (16-bit signed little-endian).
const AUDIO_BITS_PER_SAMPLE: u16 = 16;

/// Build the single PCM [`AudioFormat`] the handler advertises. Every field must
/// match a format the server offers verbatim (IronRDP intersects the two lists
/// by structural equality), so the derived `nBlockAlign` / `nAvgBytesPerSec`
/// follow the standard PCM formulas a Windows `rdpsnd` server uses.
fn pcm_format() -> AudioFormat {
    let block_align = AUDIO_CHANNELS * (AUDIO_BITS_PER_SAMPLE / 8);
    AudioFormat {
        format: WaveFormat::PCM,
        n_channels: AUDIO_CHANNELS,
        n_samples_per_sec: AUDIO_SAMPLE_RATE,
        n_avg_bytes_per_sec: AUDIO_SAMPLE_RATE * u32::from(block_align),
        n_block_align: block_align,
        bits_per_sample: AUDIO_BITS_PER_SAMPLE,
        data: None,
    }
}

/// The formats the handler advertises to the server: one PCM format on platforms
/// with a compiled audio backend, empty elsewhere (so the server streams no
/// audio, matching the no-op behaviour).
fn advertised_formats() -> Vec<AudioFormat> {
    if AudioSink::SUPPORTED {
        vec![pcm_format()]
    } else {
        Vec::new()
    }
}

/// Decode a little-endian 16-bit PCM byte buffer into signed samples. A trailing
/// odd byte (a truncated sample) is dropped rather than misaligned.
fn pcm_bytes_to_i16(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect()
}

/// Map an [`RDPSND` volume PDU](VolumePdu) (per-channel `0..=0xFFFF`) to a
/// linear [`rodio`] gain where `1.0` is unity. Averages the two channels since
/// the sink applies a single scalar gain.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn volume_to_gain(volume: &VolumePdu) -> f32 {
    let avg = (u32::from(volume.volume_left) + u32::from(volume.volume_right)) as f32 / 2.0;
    avg / f32::from(u16::MAX)
}

/// The RDPSND client handler: advertises PCM and plays received `wave` buffers on
/// a host output device.
#[derive(Debug)]
pub struct RdpAudioBackend {
    formats: Vec<AudioFormat>,
    sink: AudioSink,
}

impl RdpAudioBackend {
    /// Create the backend, starting the host-audio playback path.
    pub fn new() -> Self {
        Self {
            formats: advertised_formats(),
            sink: AudioSink::new(),
        }
    }
}

impl Default for RdpAudioBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl RdpsndClientHandler for RdpAudioBackend {
    fn get_formats(&self) -> &[AudioFormat] {
        &self.formats
    }

    fn wave(&mut self, _format_no: usize, _ts: u32, data: Cow<'_, [u8]>) {
        // Only one PCM format is advertised, so `format_no` is always 0 and the
        // buffer is 16-bit LE PCM at the advertised channel/rate.
        let samples = pcm_bytes_to_i16(&data);
        if !samples.is_empty() {
            self.sink.play(samples);
        }
    }

    fn set_volume(&mut self, volume: VolumePdu) {
        self.sink.set_volume(&volume);
    }

    fn set_pitch(&mut self, _pitch: PitchPdu) {
        // Playback pitch shifting is not implemented; servers rarely send it.
    }

    fn close(&mut self) {
        self.sink.close();
    }
}

// --- Host playback sink: real on macOS/Windows, a no-op elsewhere. ---

/// A command sent to the playback thread.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
enum AudioCommand {
    /// Queue decoded samples for playback at the advertised channel/rate.
    Play(Vec<i16>),
    /// Set the output gain (`1.0` = unity).
    Volume(f32),
}

/// Host audio sink backed by a dedicated [`rodio`] playback thread.
///
/// The thread owns the `!Send` output stream and sink; this handle keeps only the
/// `Send` command sender, so the RDP session future stays `Send`-agnostic and no
/// audio object migrates across worker threads.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
#[derive(Debug)]
struct AudioSink {
    tx: Option<std::sync::mpsc::Sender<AudioCommand>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
impl AudioSink {
    const SUPPORTED: bool = true;

    fn new() -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<AudioCommand>();
        let thread = std::thread::Builder::new()
            .name("rdp-audio".to_string())
            .spawn(move || playback_loop(&rx))
            .ok();
        Self {
            tx: Some(tx),
            thread,
        }
    }

    fn play(&self, samples: Vec<i16>) {
        if let Some(tx) = &self.tx {
            // A send error means the playback thread has exited (no device); drop
            // the buffer silently rather than crashing the session.
            let _ = tx.send(AudioCommand::Play(samples));
        }
    }

    fn set_volume(&self, volume: &VolumePdu) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(AudioCommand::Volume(volume_to_gain(volume)));
        }
    }

    fn close(&mut self) {
        // Dropping the sender ends the playback loop; then join so the output
        // stream is torn down before we return.
        self.tx = None;
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
impl Drop for AudioSink {
    fn drop(&mut self) {
        self.close();
    }
}

/// The playback thread body: open a default output device and play every queued
/// PCM buffer through a [`rodio`] sink until the sender is dropped. Opening the
/// device can fail (headless host, no audio hardware); on failure the loop simply
/// drains and discards commands so the session keeps running without sound.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn playback_loop(rx: &std::sync::mpsc::Receiver<AudioCommand>) {
    let (_stream, handle) = match rodio::OutputStream::try_default() {
        Ok(pair) => pair,
        Err(e) => {
            tracing::warn!(error = %e, "rdpsnd: no audio output device; audio disabled");
            for _ in rx.iter() {}
            return;
        }
    };
    let sink = match rodio::Sink::try_new(&handle) {
        Ok(sink) => sink,
        Err(e) => {
            tracing::warn!(error = %e, "rdpsnd: failed to create audio sink; audio disabled");
            for _ in rx.iter() {}
            return;
        }
    };
    tracing::debug!("rdpsnd: audio playback thread started");
    for cmd in rx.iter() {
        match cmd {
            AudioCommand::Play(samples) => {
                sink.append(rodio::buffer::SamplesBuffer::new(
                    AUDIO_CHANNELS,
                    AUDIO_SAMPLE_RATE,
                    samples,
                ));
            }
            AudioCommand::Volume(gain) => sink.set_volume(gain),
        }
    }
    // `_stream` drops here, stopping the device.
    tracing::debug!("rdpsnd: audio playback thread stopped");
}

/// No-op sink for platforms without a compiled audio backend (any target other
/// than macOS/Windows/Linux — see the module docs). Advertises no formats, so
/// the server never streams.
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
#[derive(Debug)]
struct AudioSink;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
impl AudioSink {
    const SUPPORTED: bool = false;

    fn new() -> Self {
        AudioSink
    }

    fn play(&self, _samples: Vec<i16>) {}

    fn set_volume(&self, _volume: &VolumePdu) {}

    fn close(&mut self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_bytes_to_i16_decodes_little_endian_pairs() {
        // 0x0100 = 256, 0xFFFF = -1, 0x8000 = i16::MIN.
        let bytes = [0x00, 0x01, 0xFF, 0xFF, 0x00, 0x80];
        assert_eq!(pcm_bytes_to_i16(&bytes), vec![256, -1, i16::MIN]);
    }

    #[test]
    fn pcm_bytes_to_i16_drops_trailing_odd_byte() {
        // A truncated final sample is dropped, not misaligned.
        assert_eq!(pcm_bytes_to_i16(&[0x00, 0x01, 0x7F]), vec![256]);
        assert!(pcm_bytes_to_i16(&[]).is_empty());
        assert!(pcm_bytes_to_i16(&[0x42]).is_empty());
    }

    #[test]
    fn advertised_formats_are_empty_without_a_backend() {
        // On platforms without a compiled audio backend the handler advertises
        // nothing (so the server streams no audio); with one it advertises PCM.
        if AudioSink::SUPPORTED {
            assert_eq!(advertised_formats().len(), 1);
        } else {
            assert!(advertised_formats().is_empty());
        }
    }

    #[test]
    fn pcm_format_matches_standard_cd_quality_stereo() {
        // These exact field values must match a format the server offers, so pin
        // the standard PCM derivations (block align 4, avg 176 400 B/s).
        let f = pcm_format();
        assert_eq!(f.format, WaveFormat::PCM);
        assert_eq!(f.n_channels, 2);
        assert_eq!(f.n_samples_per_sec, 44_100);
        assert_eq!(f.bits_per_sample, 16);
        assert_eq!(f.n_block_align, 4);
        assert_eq!(f.n_avg_bytes_per_sec, 176_400);
        assert!(f.data.is_none());
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    #[test]
    fn volume_pdu_maps_to_unity_gain_at_max() {
        let full = VolumePdu {
            volume_left: u16::MAX,
            volume_right: u16::MAX,
        };
        assert!((volume_to_gain(&full) - 1.0).abs() < 1e-6);
        let silent = VolumePdu {
            volume_left: 0,
            volume_right: 0,
        };
        assert_eq!(volume_to_gain(&silent), 0.0);
    }
}
