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
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use std::collections::VecDeque;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use std::time::{Duration, Instant};

use ironrdp::rdpsnd::client::RdpsndClientHandler;
use ironrdp::rdpsnd::pdu::{AudioFormat, PitchPdu, VolumePdu, WaveFormat};

/// Channels in the advertised PCM format (stereo).
const AUDIO_CHANNELS: u16 = 2;
/// Sample rate of the advertised PCM format, in Hz (CD quality).
const AUDIO_SAMPLE_RATE: u32 = 44_100;
/// Bit depth of the advertised PCM format (16-bit signed little-endian).
const AUDIO_BITS_PER_SAMPLE: u16 = 16;

/// Target amount of audio to buffer ahead of the play head before playback
/// starts, and to rebuild after every underrun. This small cushion is what late
/// or bursty `wave` PDUs draw down instead of starving the output device, so
/// network jitter no longer causes audible dropouts (#1774). Kept modest so it
/// does not add perceptible latency beyond this window.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const TARGET_LATENCY: Duration = Duration::from_millis(80);

/// Hard cap on how far ahead of the play head audio may be queued. Once a buffer
/// would push the queue past this, it is dropped (tail-drop) — so a bursty
/// server can grow neither playback latency nor the sink's queued memory without
/// bound. Bounds total added latency to at most this window plus one buffer.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const MAX_LATENCY: Duration = Duration::from_millis(250);

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

/// Wall-clock duration of a decoded PCM buffer at the advertised channel count
/// and sample rate. Playback consumes exactly one frame per sample period, so
/// this is the time the buffer will occupy on the output device.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn samples_duration(sample_count: usize) -> Duration {
    let frames = sample_count / AUDIO_CHANNELS as usize;
    Duration::from_nanos((frames as u64 * 1_000_000_000) / u64::from(AUDIO_SAMPLE_RATE))
}

/// A bounded jitter / latency buffer sitting in front of the [`rodio`] sink.
///
/// RDP servers pace audio roughly in real time, but network jitter delivers
/// `wave` PDUs in late bursts. Feeding each buffer straight to the sink as it
/// arrives therefore either starves the device (audible dropouts) or, on a
/// burst, queues buffers faster than they drain and grows playback latency —
/// and the sink's queued memory — without bound (#1774).
///
/// This buffer smooths both ends against a model of the playback timeline
/// ([`playing_until`](Self::playing_until) is the instant the queued audio runs
/// out):
///
/// * **Prebuffer.** At start, and after every underrun, incoming buffers are
///   held until [`TARGET_LATENCY`] of audio has accumulated, then released
///   together. That cushion is what late frames draw down instead of the device
///   starving.
/// * **Underrun.** When the modelled play head reaches the end of the queued
///   audio the cushion is empty; the buffer re-enters the prebuffer state and
///   rebuilds it. The device plays silence in the gap — no glitch and no
///   busy-spin, since the playback thread simply blocks for the next PDU.
/// * **Overrun.** When releasing a buffer would push the queued audio past
///   [`MAX_LATENCY`] ahead of the play head, that buffer is dropped (tail-drop).
///   This is what bounds both latency and memory: the sink is never handed more
///   than ~`MAX_LATENCY` of audio, and this struct itself holds at most
///   ~`TARGET_LATENCY`.
///
/// The buffer never resamples or reshapes sample data — buffers pass through
/// byte-for-byte in the single negotiated PCM format — so it cannot introduce
/// pitch or rate errors.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
#[derive(Debug)]
struct JitterBuffer {
    /// Instant at which all audio released to the sink so far finishes playing.
    /// `None` until the first release and whenever the queue has drained; drives
    /// the backlog and underrun model.
    playing_until: Option<Instant>,
    /// Buffers held while (re)building the [`TARGET_LATENCY`] cushion.
    pending: VecDeque<Vec<i16>>,
    /// Total duration currently held in `pending`.
    pending_duration: Duration,
    /// Whether we are accumulating the initial / post-underrun cushion.
    filling: bool,
    /// Count of buffers tail-dropped for overrun (diagnostics).
    dropped: u64,
    /// Count of underruns observed (diagnostics).
    underruns: u64,
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
impl JitterBuffer {
    fn new() -> Self {
        Self {
            playing_until: None,
            pending: VecDeque::new(),
            pending_duration: Duration::ZERO,
            filling: true,
            dropped: 0,
            underruns: 0,
        }
    }

    /// Admit one decoded buffer, returning the buffers (if any) to hand to the
    /// sink now, in order. `now` is the current wall clock, injected so the
    /// timeline model can be unit-tested without real time.
    fn push(&mut self, samples: Vec<i16>, now: Instant) -> Vec<Vec<i16>> {
        // Has the modelled play head reached the end of the queued audio? If we
        // were streaming, that is an underrun: drop back to prebuffering so the
        // cushion is rebuilt before playback resumes.
        if let Some(until) = self.playing_until {
            if until <= now {
                if !self.filling {
                    self.underruns += 1;
                    self.filling = true;
                    tracing::debug!(
                        underruns = self.underruns,
                        "rdpsnd: audio underrun, rebuilding jitter buffer"
                    );
                }
                self.playing_until = None;
            }
        }

        if self.filling {
            self.pending_duration += samples_duration(samples.len());
            self.pending.push_back(samples);
            if self.pending_duration < TARGET_LATENCY {
                return Vec::new();
            }
            // Cushion is full: release it as a batch and start the timeline now.
            let released: Vec<Vec<i16>> = self.pending.drain(..).collect();
            self.playing_until = Some(now + self.pending_duration);
            self.pending_duration = Duration::ZERO;
            self.filling = false;
            return released;
        }

        // Steady state: `playing_until` is Some and in the future.
        let backlog = self
            .playing_until
            .map(|until| until.saturating_duration_since(now))
            .unwrap_or(Duration::ZERO);
        let dur = samples_duration(samples.len());
        if backlog + dur > MAX_LATENCY {
            // Overrun: tail-drop this buffer to cap latency and queued memory.
            self.dropped += 1;
            tracing::trace!(
                dropped = self.dropped,
                "rdpsnd: jitter buffer full, dropping buffer to cap latency"
            );
            return Vec::new();
        }
        let base = self.playing_until.unwrap_or(now).max(now);
        self.playing_until = Some(base + dur);
        vec![samples]
    }
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
    let mut jitter = JitterBuffer::new();
    for cmd in rx.iter() {
        match cmd {
            AudioCommand::Play(samples) => {
                // Admit through the jitter buffer, which prebuffers a cushion,
                // caps latency/memory (tail-drop) and rides out underruns before
                // handing buffers to the sink.
                for buf in jitter.push(samples, Instant::now()) {
                    sink.append(rodio::buffer::SamplesBuffer::new(
                        AUDIO_CHANNELS,
                        AUDIO_SAMPLE_RATE,
                        buf,
                    ));
                }
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

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
#[cfg(test)]
mod jitter_tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// A silent PCM buffer occupying exactly `ms` milliseconds at the advertised
    /// stereo 44.1 kHz format.
    fn buf_of(ms: u64) -> Vec<i16> {
        let frames = (u64::from(AUDIO_SAMPLE_RATE) * ms / 1000) as usize;
        vec![0i16; frames * AUDIO_CHANNELS as usize]
    }

    #[test]
    fn samples_duration_matches_frame_count() {
        // One second of stereo audio = sample_rate frames = 2*sample_rate samples.
        let one_sec = AUDIO_SAMPLE_RATE as usize * AUDIO_CHANNELS as usize;
        assert_eq!(samples_duration(one_sec), Duration::from_secs(1));
        assert_eq!(samples_duration(0), Duration::ZERO);
    }

    #[test]
    fn prebuffers_to_target_before_releasing() {
        // Buffers below TARGET_LATENCY are held; the one that crosses the target
        // releases the whole accumulated cushion at once — nothing plays early.
        let t = Instant::now();
        let mut jb = JitterBuffer::new();
        assert!(jb.push(buf_of(20), t).is_empty()); // 20ms held
        assert!(jb.push(buf_of(20), t).is_empty()); // 40ms held
        assert!(jb.push(buf_of(20), t).is_empty()); // 60ms held
        let released = jb.push(buf_of(20), t); // 80ms == target -> release 4
        assert_eq!(released.len(), 4);
        assert!(!jb.filling);
        // The play head is exactly TARGET_LATENCY ahead of `now`.
        assert_eq!(jb.playing_until, Some(t + TARGET_LATENCY));
    }

    #[test]
    fn passes_samples_through_without_reshaping() {
        // A ≥target buffer releases immediately and byte-for-byte: no resample,
        // no channel/rate mangling (guards the chipmunk-audio class of bug).
        let t = Instant::now();
        let mut jb = JitterBuffer::new();
        let payload: Vec<i16> = (0..(buf_of(100).len() as i32)).map(|i| i as i16).collect();
        let released = jb.push(payload.clone(), t);
        assert_eq!(released.len(), 1);
        assert_eq!(released[0], payload);
    }

    #[test]
    fn underrun_reenters_prebuffering() {
        let t = Instant::now();
        let mut jb = JitterBuffer::new();
        // Reach steady state: cushion released, play head TARGET_LATENCY ahead.
        assert_eq!(jb.push(buf_of(80), t).len(), 1);
        assert!(!jb.filling);
        // Advance the clock well past the queued audio -> the play head drained.
        let out = jb.push(buf_of(20), t + Duration::from_millis(500));
        assert!(out.is_empty()); // held again while the cushion rebuilds
        assert!(jb.filling);
        assert_eq!(jb.underruns, 1);
    }

    #[test]
    fn overrun_is_bounded_and_drops_tail() {
        // With the clock frozen, a flood cannot grow the queue past MAX_LATENCY:
        // once full, further buffers are tail-dropped, so both latency and the
        // memory handed to the sink stay bounded.
        let t = Instant::now();
        let mut jb = JitterBuffer::new();
        assert_eq!(jb.push(buf_of(80), t).len(), 1); // steady state, 80ms queued

        let mut appended = 0usize;
        for _ in 0..1000 {
            if !jb.push(buf_of(20), t).is_empty() {
                appended += 1;
            }
        }
        assert!(jb.dropped > 0, "a frozen-clock flood must drop buffers");
        // Accepted audio is capped: queue never exceeds MAX_LATENCY ahead.
        let backlog = jb.playing_until.unwrap() - t;
        assert!(
            backlog <= MAX_LATENCY,
            "backlog {backlog:?} exceeded cap {MAX_LATENCY:?}"
        );
        // Total accepted (initial cushion + steady-state) fits the window.
        assert!((appended + 1) as u32 * 20 <= MAX_LATENCY.as_millis() as u32 + 20);
    }
}
