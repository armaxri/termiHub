//! Audio output redirection (MS-RDPEAUDIO / `rdpsnd`) for the RDP sidecar
//! (#1764, multi-format negotiation #1773).
//!
//! IronRDP's [`Rdpsnd`](ironrdp::rdpsnd::client::Rdpsnd) static virtual channel
//! decodes the server's audio stream and drives an
//! [`RdpsndClientHandler`](ironrdp::rdpsnd::client::RdpsndClientHandler): the
//! handler advertises the [`AudioFormat`]s it can play via
//! [`get_formats`](RdpsndClientHandler::get_formats), and the channel calls
//! [`wave`](RdpsndClientHandler::wave) with each decoded audio buffer, handing us
//! the **concrete negotiated [`AudioFormat`]** the buffer is in. [`RdpAudioBackend`]
//! plays those buffers on a **host audio output device**, so the remote session's
//! sound is heard locally.
//!
//! ## Where playback happens
//!
//! Playback stays entirely inside the sidecar process — the decoded PCM never
//! crosses the IPC boundary to the desktop app. A dedicated OS thread owns the
//! [`rodio`] output stream and sink (both `!Send`, and callback-driven), fed
//! decoded samples over a channel; the handler only holds the `Send` sender, so
//! nothing audio-related touches the async session future.
//!
//! ## Scope: multi-rate PCM negotiation (#1773)
//!
//! The handler advertises a **table** of common PCM formats (48/44.1/22.05/11.025
//! kHz, 16-bit, mono and stereo) and plays each `wave` PDU in whichever format the
//! server selected. This is only sound because termiHub vendors a patched
//! `ironrdp-rdpsnd` (see `vendor/ironrdp-rdpsnd/`): upstream 0.9.0 reported only a
//! `format_no` index into a non-deterministically-ordered, then-discarded list, so
//! more than one advertised format could not be mapped back to a concrete rate
//! (risking "chipmunk" audio — e.g. playing 22.05 kHz data at 44.1 kHz). The fork
//! passes the concrete [`AudioFormat`] to [`wave`](RdpsndClientHandler::wave), so
//! each buffer is decoded and played at its **own** channel count and sample rate;
//! [`rodio`] resamples to the device rate. Compressed formats (ADPCM/Opus) remain
//! a follow-up — see #1773.
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

/// Bit depth of the PCM formats the handler advertises (16-bit signed LE). Every
/// advertised format is 16-bit; [`decode_wave`] rejects anything else, so a
/// mismatched buffer is dropped rather than played at the wrong width.
const AUDIO_BITS_PER_SAMPLE: u16 = 16;

/// Sample rates advertised, in Hz. A broad-but-standard set so the intersection
/// with a typical Windows `rdpsnd` server's table is non-empty across servers;
/// [`rodio`] resamples whichever the server picks to the device rate.
const ADVERTISED_SAMPLE_RATES: [u32; 4] = [48_000, 44_100, 22_050, 11_025];

/// Channel counts advertised (mono and stereo).
const ADVERTISED_CHANNELS: [u16; 2] = [2, 1];

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

/// A decoded PCM buffer together with the playback parameters it must be played
/// at. Carrying `channels`/`sample_rate` per buffer is what makes multi-format
/// negotiation sound: the value the server negotiated travels with the samples,
/// so nothing downstream can guess (and mis-guess) the rate.
#[derive(Debug, Clone, PartialEq)]
struct PcmBuffer {
    samples: Vec<i16>,
    channels: u16,
    sample_rate: u32,
}

/// Build one PCM [`AudioFormat`]. Every field must match a format the server
/// offers verbatim (IronRDP intersects the two lists by structural equality), so
/// the derived `nBlockAlign` / `nAvgBytesPerSec` follow the standard PCM formulas
/// a Windows `rdpsnd` server uses.
fn pcm_format(channels: u16, sample_rate: u32) -> AudioFormat {
    let block_align = channels * (AUDIO_BITS_PER_SAMPLE / 8);
    AudioFormat {
        format: WaveFormat::PCM,
        n_channels: channels,
        n_samples_per_sec: sample_rate,
        n_avg_bytes_per_sec: sample_rate * u32::from(block_align),
        n_block_align: block_align,
        bits_per_sample: AUDIO_BITS_PER_SAMPLE,
        data: None,
    }
}

/// The formats the handler advertises to the server: the full PCM table on
/// platforms with a compiled audio backend, empty elsewhere (so the server
/// streams no audio, matching the no-op behaviour).
fn advertised_formats() -> Vec<AudioFormat> {
    if !AudioSink::SUPPORTED {
        return Vec::new();
    }
    let mut formats = Vec::with_capacity(ADVERTISED_SAMPLE_RATES.len() * ADVERTISED_CHANNELS.len());
    for &rate in &ADVERTISED_SAMPLE_RATES {
        for &channels in &ADVERTISED_CHANNELS {
            formats.push(pcm_format(channels, rate));
        }
    }
    formats
}

/// Decode a `wave` payload into a [`PcmBuffer`] using the **negotiated**
/// [`AudioFormat`] the server selected. Only 16-bit LE PCM is supported (every
/// advertised format is such); any other format is rejected with `None` so an
/// unexpected buffer is dropped rather than played at the wrong rate or width.
///
/// The channel count and sample rate come straight from `format`, so the buffer
/// is always played at exactly the rate it was negotiated at — this is the guard
/// against "chipmunk" audio.
fn decode_wave(format: &AudioFormat, data: &[u8]) -> Option<PcmBuffer> {
    if format.format != WaveFormat::PCM || format.bits_per_sample != AUDIO_BITS_PER_SAMPLE {
        tracing::warn!(
            ?format.format,
            bits = format.bits_per_sample,
            "rdpsnd: unsupported wave format, dropping buffer"
        );
        return None;
    }
    if format.n_channels == 0 || format.n_samples_per_sec == 0 {
        return None;
    }
    let samples = pcm_bytes_to_i16(data);
    if samples.is_empty() {
        return None;
    }
    Some(PcmBuffer {
        samples,
        channels: format.n_channels,
        sample_rate: format.n_samples_per_sec,
    })
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

/// Wall-clock duration of a decoded PCM buffer at the given channel count and
/// sample rate. Playback consumes exactly one frame per sample period, so this is
/// the time the buffer will occupy on the output device.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn samples_duration(sample_count: usize, channels: u16, sample_rate: u32) -> Duration {
    if channels == 0 || sample_rate == 0 {
        return Duration::ZERO;
    }
    let frames = sample_count / channels as usize;
    Duration::from_nanos((frames as u64 * 1_000_000_000) / u64::from(sample_rate))
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
/// The buffer never resamples or reshapes sample data — each [`PcmBuffer`] passes
/// through byte-for-byte in its own negotiated format, and its duration is
/// computed from that format — so it cannot introduce pitch or rate errors even
/// when the negotiated format changes mid-session.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
#[derive(Debug)]
struct JitterBuffer {
    /// Instant at which all audio released to the sink so far finishes playing.
    /// `None` until the first release and whenever the queue has drained; drives
    /// the backlog and underrun model.
    playing_until: Option<Instant>,
    /// Buffers held while (re)building the [`TARGET_LATENCY`] cushion.
    pending: VecDeque<PcmBuffer>,
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

    /// Wall-clock duration one [`PcmBuffer`] will occupy on the device.
    fn buffer_duration(buf: &PcmBuffer) -> Duration {
        samples_duration(buf.samples.len(), buf.channels, buf.sample_rate)
    }

    /// Admit one decoded buffer, returning the buffers (if any) to hand to the
    /// sink now, in order. `now` is the current wall clock, injected so the
    /// timeline model can be unit-tested without real time.
    fn push(&mut self, buf: PcmBuffer, now: Instant) -> Vec<PcmBuffer> {
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
            self.pending_duration += Self::buffer_duration(&buf);
            self.pending.push_back(buf);
            if self.pending_duration < TARGET_LATENCY {
                return Vec::new();
            }
            // Cushion is full: release it as a batch and start the timeline now.
            let released: Vec<PcmBuffer> = self.pending.drain(..).collect();
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
        let dur = Self::buffer_duration(&buf);
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
        vec![buf]
    }
}

/// The RDPSND client handler: advertises a PCM format table and plays received
/// `wave` buffers, each in its negotiated format, on a host output device.
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

    fn wave(&mut self, format: &AudioFormat, _ts: u32, data: Cow<'_, [u8]>) {
        // `format` is the concrete format the server negotiated (thanks to the
        // vendored ironrdp-rdpsnd fork), so the buffer is decoded and played at
        // exactly its own channel count and sample rate — never guessed.
        if let Some(buffer) = decode_wave(format, &data) {
            self.sink.play(buffer);
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

// --- Host playback sink: real on macOS/Windows/Linux, a no-op elsewhere. ---

/// A command sent to the playback thread.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
enum AudioCommand {
    /// Queue a decoded buffer for playback at its own channel count / sample rate.
    Play(PcmBuffer),
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

    fn play(&self, buffer: PcmBuffer) {
        if let Some(tx) = &self.tx {
            // A send error means the playback thread has exited (no device); drop
            // the buffer silently rather than crashing the session.
            let _ = tx.send(AudioCommand::Play(buffer));
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
            AudioCommand::Play(buffer) => {
                // Admit through the jitter buffer, which prebuffers a cushion,
                // caps latency/memory (tail-drop) and rides out underruns before
                // handing buffers to the sink. Each buffer plays at its own
                // negotiated channel count / sample rate; rodio resamples to the
                // device rate.
                for buf in jitter.push(buffer, Instant::now()) {
                    sink.append(rodio::buffer::SamplesBuffer::new(
                        buf.channels,
                        buf.sample_rate,
                        buf.samples,
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

    fn play(&self, _buffer: PcmBuffer) {}

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
    fn advertised_formats_cover_the_pcm_table() {
        // On platforms without a compiled audio backend the handler advertises
        // nothing (so the server streams no audio); with one it advertises the
        // full rate x channel PCM table, all 16-bit PCM with correct derivations.
        let formats = advertised_formats();
        if !AudioSink::SUPPORTED {
            assert!(formats.is_empty());
            return;
        }
        assert_eq!(
            formats.len(),
            ADVERTISED_SAMPLE_RATES.len() * ADVERTISED_CHANNELS.len()
        );
        for f in &formats {
            assert_eq!(f.format, WaveFormat::PCM);
            assert_eq!(f.bits_per_sample, 16);
            assert!(ADVERTISED_SAMPLE_RATES.contains(&f.n_samples_per_sec));
            assert!(ADVERTISED_CHANNELS.contains(&f.n_channels));
            // Standard PCM derivations must match what a Windows server offers.
            let block_align = f.n_channels * 2;
            assert_eq!(f.n_block_align, block_align);
            assert_eq!(
                f.n_avg_bytes_per_sec,
                f.n_samples_per_sec * u32::from(block_align)
            );
            assert!(f.data.is_none());
        }
        // The classic CD-quality stereo format is present.
        assert!(formats.contains(&pcm_format(2, 44_100)));
    }

    #[test]
    fn pcm_format_matches_standard_cd_quality_stereo() {
        // Pin the standard PCM derivations (block align 4, avg 176 400 B/s).
        let f = pcm_format(2, 44_100);
        assert_eq!(f.format, WaveFormat::PCM);
        assert_eq!(f.n_channels, 2);
        assert_eq!(f.n_samples_per_sec, 44_100);
        assert_eq!(f.bits_per_sample, 16);
        assert_eq!(f.n_block_align, 4);
        assert_eq!(f.n_avg_bytes_per_sec, 176_400);
        assert!(f.data.is_none());
    }

    /// The load-bearing format-correctness guard (#1773): a `wave` buffer must be
    /// decoded at *exactly* the negotiated format's channel count and sample
    /// rate, never a fixed assumption — otherwise a 22.05 kHz stream would play at
    /// 44.1 kHz ("chipmunk" audio). This is the regression test for that class of
    /// bug that multi-format negotiation introduces.
    #[test]
    fn decode_wave_uses_the_negotiated_rate_not_a_fixed_one() {
        // 0x0100 = 256, 0x0200 = 512.
        let bytes = [0x00, 0x01, 0x00, 0x02];

        // A 22.05 kHz mono buffer must report 22 050 Hz / 1 channel.
        let mono = pcm_format(1, 22_050);
        let decoded = decode_wave(&mono, &bytes).expect("mono PCM decodes");
        assert_eq!(decoded.sample_rate, 22_050);
        assert_eq!(decoded.channels, 1);
        assert_eq!(decoded.samples, vec![256, 512]);

        // The same bytes under a 48 kHz stereo format report 48 000 Hz / 2 —
        // proving the rate/channels come from the format, not the payload.
        let stereo = pcm_format(2, 48_000);
        let decoded = decode_wave(&stereo, &bytes).expect("stereo PCM decodes");
        assert_eq!(decoded.sample_rate, 48_000);
        assert_eq!(decoded.channels, 2);
        assert_eq!(decoded.samples, vec![256, 512]);
    }

    #[test]
    fn decode_wave_rejects_unsupported_formats() {
        let bytes = [0x00, 0x01, 0x00, 0x02];
        // Non-PCM (e.g. ADPCM tag) is dropped, not misplayed.
        let mut adpcm = pcm_format(2, 44_100);
        adpcm.format = WaveFormat::ADPCM;
        assert!(decode_wave(&adpcm, &bytes).is_none());
        // 8-bit PCM is not advertised, so it is rejected rather than mis-decoded.
        let mut eight_bit = pcm_format(2, 44_100);
        eight_bit.bits_per_sample = 8;
        assert!(decode_wave(&eight_bit, &bytes).is_none());
        // Empty payload yields nothing.
        assert!(decode_wave(&pcm_format(2, 44_100), &[]).is_none());
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

    /// A silent stereo 44.1 kHz PCM buffer occupying exactly `ms` milliseconds.
    fn buf_of(ms: u64) -> PcmBuffer {
        let channels = 2u16;
        let sample_rate = 44_100u32;
        let frames = (u64::from(sample_rate) * ms / 1000) as usize;
        PcmBuffer {
            samples: vec![0i16; frames * channels as usize],
            channels,
            sample_rate,
        }
    }

    #[test]
    fn samples_duration_matches_frame_count() {
        // One second of stereo audio = sample_rate frames = 2*sample_rate samples.
        let one_sec = 44_100 * 2;
        assert_eq!(samples_duration(one_sec, 2, 44_100), Duration::from_secs(1));
        // A lower rate stretches the same sample count over more time — the whole
        // point of per-buffer rate: 22 050 Hz mono => 2x the wall-clock duration.
        assert_eq!(samples_duration(22_050, 1, 22_050), Duration::from_secs(1));
        assert_eq!(samples_duration(0, 2, 44_100), Duration::ZERO);
        assert_eq!(samples_duration(100, 2, 0), Duration::ZERO);
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
        let mut payload = buf_of(100);
        payload.samples = (0..(payload.samples.len() as i32))
            .map(|i| i as i16)
            .collect();
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
