//! Compressed `rdpsnd` audio decoding: **MS-ADPCM** (`WAVE_FORMAT_ADPCM`, 0x0002)
//! and **IMA/DVI ADPCM** (`WAVE_FORMAT_DVI_ADPCM`, 0x0011) → 16-bit PCM (#1812,
//! follow-up to #1773).
//!
//! A Windows `rdpsnd` server can offer these block-compressed formats besides
//! plain PCM. Unlike PCM they cannot be advertised by structural equality — the
//! server picks the block layout (`n_block_align`, `wSamplesPerBlock`, and, for
//! MS-ADPCM, the coefficient table in the format's extra `data`) and the client
//! cannot predict it. The vendored `ironrdp-rdpsnd` fork therefore lets the
//! handler *accept a server format by codec* ([`can_decode`]) and echoes that
//! exact [`AudioFormat`] back, so [`decode`] here receives the server's concrete
//! block parameters.
//!
//! ## Decoder
//!
//! Decoding is delegated to [`symphonia_codec_adpcm`] — the pure-Rust ADPCM codec
//! from the widely-used Symphonia project — rather than hand-rolled (repo policy:
//! prefer maintained libraries). Symphonia decodes both MS-ADPCM and IMA-ADPCM to
//! signed samples; we drive it one `wave` payload at a time and convert its output
//! to the same interleaved 16-bit [`super::audio::PcmBuffer`] the PCM path
//! produces, at the format's own sample rate — so the #1773 "chipmunk audio"
//! invariant (play at the negotiated rate, never a fixed assumption) holds for
//! compressed formats too.
//!
//! Opus (`WAVE_FORMAT_OPUS`, 0x704F) is intentionally **not** handled here — its
//! maintained decoders link the native `libopus` C library, a cross-platform CI
//! cost deferred to a follow-up.

use ironrdp::rdpsnd::pdu::{AudioFormat, WaveFormat};
use symphonia_codec_adpcm::AdpcmDecoder;
use symphonia_core::audio::{Channels, SampleBuffer};
use symphonia_core::codecs::{
    CodecParameters, CodecType, Decoder, DecoderOptions, CODEC_TYPE_ADPCM_IMA_WAV,
    CODEC_TYPE_ADPCM_MS,
};
use symphonia_core::formats::Packet;

use crate::audio::PcmBuffer;

/// Bytes of block preamble per channel for MS-ADPCM (`bPredictor` + `iDelta` +
/// `iSamp1` + `iSamp2` = 1 + 2 + 2 + 2), which also carries the first two output
/// samples of the block. Used by the [`frames_per_block`] fallback formula.
const MS_PREAMBLE_BYTES_PER_CHANNEL: usize = 7;

/// Bytes of block preamble per channel for IMA/DVI ADPCM (`predictor` +
/// `step_index` + reserved = 2 + 1 + 1), which carries the first output sample of
/// the block. Used by the [`frames_per_block`] fallback formula.
const IMA_PREAMBLE_BYTES_PER_CHANNEL: usize = 4;

/// Map a supported ADPCM [`WaveFormat`] tag to its Symphonia [`CodecType`].
/// Returns `None` for any tag this module does not decode, so callers reject
/// unsupported formats rather than mis-decoding them.
fn codec_type(format: WaveFormat) -> Option<CodecType> {
    match format {
        WaveFormat::ADPCM => Some(CODEC_TYPE_ADPCM_MS),
        WaveFormat::DVI_ADPCM => Some(CODEC_TYPE_ADPCM_IMA_WAV),
        _ => None,
    }
}

/// Map an advertised channel count to a Symphonia channel mask. Only mono and
/// stereo are meaningful for `rdpsnd`; anything else is unsupported.
fn channel_mask(n_channels: u16) -> Option<Channels> {
    match n_channels {
        1 => Some(Channels::FRONT_LEFT),
        2 => Some(Channels::FRONT_LEFT | Channels::FRONT_RIGHT),
        _ => None,
    }
}

/// Frames (samples per channel) in one compressed block.
///
/// Prefers `wSamplesPerBlock` from the format's extra `data` — present in both
/// `ADPCMWAVEFORMAT` and `IMAADPCMWAVEFORMAT` as the first two little-endian
/// bytes — which is authoritative. Falls back to the standard formula derived
/// from `n_block_align` when the server sends no (or truncated) extra data.
///
/// The value is critical: Symphonia frames blocks by `frames_per_block`, so a
/// wrong value would desync every block, not just clip one.
fn frames_per_block(format: &AudioFormat) -> Option<usize> {
    if let Some(data) = &format.data {
        if data.len() >= 2 {
            let samples_per_block = u16::from_le_bytes([data[0], data[1]]) as usize;
            if samples_per_block >= 2 {
                return Some(samples_per_block);
            }
        }
    }

    let channels = usize::from(format.n_channels);
    let block_align = usize::from(format.n_block_align);
    if channels == 0 {
        return None;
    }
    let bytes_per_channel = block_align / channels;
    match format.format {
        // MS-ADPCM: 2 preamble samples, then each post-preamble byte is 2 samples.
        WaveFormat::ADPCM => {
            let data_bytes = bytes_per_channel.checked_sub(MS_PREAMBLE_BYTES_PER_CHANNEL)?;
            Some(data_bytes * 2 + 2)
        }
        // IMA/DVI ADPCM: 1 preamble sample, then each post-preamble byte is 2 samples.
        WaveFormat::DVI_ADPCM => {
            let data_bytes = bytes_per_channel.checked_sub(IMA_PREAMBLE_BYTES_PER_CHANNEL)?;
            Some(data_bytes * 2 + 1)
        }
        _ => None,
    }
}

/// Whether [`decode`] can turn this server-advertised compressed format into PCM.
///
/// The vendored `ironrdp-rdpsnd` fork calls this (via
/// `RdpsndClientHandler::accepts_format`) to decide whether to advertise the
/// server's ADPCM format back to it. Advertising is therefore gated on real
/// decodability: a supported codec tag, mono/stereo, a non-zero sample rate, and a
/// resolvable, sane block size — so we never advertise a format we would then drop.
pub fn can_decode(format: &AudioFormat) -> bool {
    codec_type(format.format).is_some()
        && channel_mask(format.n_channels).is_some()
        && format.n_samples_per_sec > 0
        && format.n_block_align > 0
        && frames_per_block(format).is_some_and(|frames| frames >= 2)
}

/// Decode a compressed `wave` payload into an interleaved 16-bit [`PcmBuffer`] at
/// the format's own channel count and sample rate.
///
/// Returns `None` (drop the buffer, never mis-play it) when the format is not a
/// supported ADPCM codec, the parameters are unusable, the payload holds no whole
/// block, or the underlying decode fails.
pub fn decode(format: &AudioFormat, data: &[u8]) -> Option<PcmBuffer> {
    let codec = codec_type(format.format)?;
    let channels = channel_mask(format.n_channels)?;
    let sample_rate = format.n_samples_per_sec;
    if sample_rate == 0 {
        return None;
    }
    let block_align = usize::from(format.n_block_align);
    if block_align == 0 {
        return None;
    }
    let frames_per_block = frames_per_block(format)?;
    if frames_per_block < 2 {
        return None;
    }

    // Only decode whole blocks: a trailing partial block (a misbehaving server, or
    // a truncated PDU) is discarded rather than decoded past its end.
    let block_count = data.len() / block_align;
    if block_count == 0 {
        return None;
    }
    let total_frames = block_count.checked_mul(frames_per_block)?;
    let usable = &data[..block_count * block_align];

    let mut params = CodecParameters::new();
    params
        .for_codec(codec)
        .with_sample_rate(sample_rate)
        .with_channels(channels)
        .with_frames_per_block(frames_per_block as u64)
        .with_max_frames_per_packet(total_frames as u64);

    let mut decoder = AdpcmDecoder::try_new(&params, &DecoderOptions::default()).ok()?;
    // Symphonia frames the packet's blocks from `block_dur() / frames_per_block`,
    // so the packet duration must be the whole-block frame count.
    let packet = Packet::new_from_slice(0, 0, total_frames as u64, usable);
    let decoded = decoder.decode(&packet).ok()?;

    // Convert Symphonia's (signed 32-bit, planar) output to the interleaved 16-bit
    // samples the sink consumes. The ADPCM codec stores each sample as `(i16) <<
    // 16`, so the S32→S16 conversion (`>> 16`) recovers the exact 16-bit value.
    let spec = *decoded.spec();
    let mut sample_buf = SampleBuffer::<i16>::new(total_frames as u64, spec);
    sample_buf.copy_interleaved_ref(decoded);
    let samples = sample_buf.samples().to_vec();
    if samples.is_empty() {
        return None;
    }

    Some(PcmBuffer::new(samples, format.n_channels, sample_rate))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// MS-ADPCM mono block whose data nibbles are all zero. With block predictor
    /// index 0 (`coeff1 = 256`, `coeff2 = 0`) a zero nibble reproduces the previous
    /// sample exactly, so the decoded output is the two verbatim preamble samples
    /// (`iSamp2`, then `iSamp1`) followed by `iSamp1` repeated — a closed-form
    /// vector independent of the adaptation math.
    fn ms_mono_block(delta: i16, sample1: i16, sample2: i16, data_bytes: usize) -> Vec<u8> {
        let mut block = vec![0x00u8]; // bPredictor = 0
        block.extend_from_slice(&delta.to_le_bytes());
        block.extend_from_slice(&sample1.to_le_bytes());
        block.extend_from_slice(&sample2.to_le_bytes());
        block.extend(std::iter::repeat_n(0x00u8, data_bytes));
        block
    }

    fn ms_mono_format(n_block_align: u16, data: Option<Vec<u8>>) -> AudioFormat {
        AudioFormat {
            format: WaveFormat::ADPCM,
            n_channels: 1,
            n_samples_per_sec: 22_050,
            n_avg_bytes_per_sec: 11_155,
            n_block_align,
            bits_per_sample: 4,
            data,
        }
    }

    fn ima_mono_format(n_block_align: u16, data: Option<Vec<u8>>) -> AudioFormat {
        AudioFormat {
            format: WaveFormat::DVI_ADPCM,
            n_channels: 1,
            n_samples_per_sec: 11_025,
            n_avg_bytes_per_sec: 5_610,
            n_block_align,
            bits_per_sample: 4,
            data,
        }
    }

    #[test]
    fn ms_adpcm_mono_decodes_to_pcm_at_the_negotiated_rate() {
        // 10-byte block = 7 preamble + 3 data bytes -> 8 samples per block.
        let block = ms_mono_block(16, 100, 200, 3);
        assert_eq!(block.len(), 10);
        let format = ms_mono_format(10, None); // fall back to the block-align formula

        let pcm = decode(&format, &block).expect("MS-ADPCM mono decodes");

        // Rate/channels come from the format, never a fixed assumption (#1773 guard).
        assert_eq!(pcm.sample_rate(), 22_050);
        assert_eq!(pcm.channels(), 1);
        // iSamp2, iSamp1, then iSamp1 held by the zero nibbles.
        assert_eq!(pcm.samples(), &[200, 100, 100, 100, 100, 100, 100, 100]);
    }

    #[test]
    fn ms_adpcm_reads_frames_per_block_from_extra_data() {
        // Same block, but drive frames-per-block from wSamplesPerBlock in the extra
        // data (authoritative) rather than the block-align fallback.
        let block = ms_mono_block(16, 7, 9, 3);
        let extra = 8u16.to_le_bytes().to_vec(); // wSamplesPerBlock = 8
        let format = ms_mono_format(10, Some(extra));

        let pcm = decode(&format, &block).expect("MS-ADPCM mono decodes via extra data");
        assert_eq!(pcm.samples(), &[9, 7, 7, 7, 7, 7, 7, 7]);
    }

    #[test]
    fn ms_adpcm_decodes_multiple_blocks() {
        // Two concatenated blocks -> 16 samples, proving the block loop advances.
        let mut data = ms_mono_block(16, 100, 200, 3);
        data.extend(ms_mono_block(16, 5, 6, 3));
        let format = ms_mono_format(10, None);

        let pcm = decode(&format, &data).expect("two MS-ADPCM blocks decode");
        assert_eq!(pcm.samples().len(), 16);
        assert_eq!(
            &pcm.samples()[..8],
            &[200, 100, 100, 100, 100, 100, 100, 100]
        );
        assert_eq!(&pcm.samples()[8..], &[6, 5, 5, 5, 5, 5, 5, 5]);
    }

    #[test]
    fn ima_adpcm_mono_decodes_to_pcm_at_the_negotiated_rate() {
        // 8-byte block = 4 preamble + 4 data bytes -> 9 samples per block. IMA step
        // index 0 has step 7, so a zero nibble adds `(1*7)>>3 == 0`: the predictor
        // is held, giving the verbatim preamble sample repeated.
        let mut block = 500i16.to_le_bytes().to_vec(); // predictor = 500
        block.push(0x00); // step_index = 0
        block.push(0x00); // reserved
        block.extend(std::iter::repeat_n(0x00u8, 4));
        assert_eq!(block.len(), 8);
        let format = ima_mono_format(8, None);

        let pcm = decode(&format, &block).expect("IMA/DVI-ADPCM mono decodes");
        assert_eq!(pcm.sample_rate(), 11_025);
        assert_eq!(pcm.channels(), 1);
        assert_eq!(pcm.samples(), &[500; 9]);
    }

    #[test]
    fn frames_per_block_matches_the_standard_formulas() {
        // MS mono: (block_align - 7) * 2 + 2.
        assert_eq!(frames_per_block(&ms_mono_format(10, None)), Some(8));
        // MS stereo: (block_align/2 - 7) * 2 + 2.
        let mut ms_stereo = ms_mono_format(24, None);
        ms_stereo.n_channels = 2;
        assert_eq!(frames_per_block(&ms_stereo), Some(12));
        // IMA mono: (block_align - 4) * 2 + 1.
        assert_eq!(frames_per_block(&ima_mono_format(8, None)), Some(9));
        // IMA stereo: (block_align/2 - 4) * 2 + 1.
        let mut ima_stereo = ima_mono_format(20, None);
        ima_stereo.n_channels = 2;
        assert_eq!(frames_per_block(&ima_stereo), Some(13));
        // Extra data wins over the formula when present and sane.
        assert_eq!(
            frames_per_block(&ms_mono_format(10, Some(505u16.to_le_bytes().to_vec()))),
            Some(505)
        );
    }

    #[test]
    fn can_decode_accepts_supported_adpcm_and_rejects_the_rest() {
        assert!(can_decode(&ms_mono_format(10, None)));
        assert!(can_decode(&ima_mono_format(8, None)));

        // Unsupported codec tag.
        let mut opus = ms_mono_format(10, None);
        opus.format = WaveFormat::OPUS;
        assert!(!can_decode(&opus));
        // PCM is handled by the PCM path, not here.
        let mut pcm = ms_mono_format(10, None);
        pcm.format = WaveFormat::PCM;
        assert!(!can_decode(&pcm));
        // Unsupported channel count.
        let mut three = ms_mono_format(10, None);
        three.n_channels = 3;
        assert!(!can_decode(&three));
        // Zero sample rate / zero block align.
        let mut no_rate = ms_mono_format(10, None);
        no_rate.n_samples_per_sec = 0;
        assert!(!can_decode(&no_rate));
        let mut no_align = ms_mono_format(0, None);
        no_align.n_block_align = 0;
        assert!(!can_decode(&no_align));
    }

    #[test]
    fn decode_rejects_unusable_input() {
        // Unsupported tag -> None (dropped, not mis-decoded).
        let mut opus = ms_mono_format(10, None);
        opus.format = WaveFormat::OPUS;
        assert!(decode(&opus, &[0u8; 10]).is_none());
        // Fewer bytes than one whole block -> None.
        assert!(decode(&ms_mono_format(10, None), &[0u8; 9]).is_none());
        // Empty payload -> None.
        assert!(decode(&ms_mono_format(10, None), &[]).is_none());
    }
}
