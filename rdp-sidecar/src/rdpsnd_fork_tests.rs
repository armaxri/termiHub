//! Regression tests for the fixes ported into the vendored `ironrdp-rdpsnd`
//! fork from upstream IronRDP after 0.9.0 (#3499). The vendored crate is built
//! with `test = false`, so its behaviour is exercised here through the public
//! `ironrdp::rdpsnd` re-export the sidecar actually links.

use std::borrow::Cow;
use std::sync::{Arc, Mutex};

use ironrdp::core::{decode, encode_vec};
use ironrdp::rdpsnd::client::{Rdpsnd, RdpsndClientHandler};
use ironrdp::rdpsnd::pdu::{
    self, AudioFormat, ClientAudioOutputPdu, PitchPdu, ServerAudioFormatPdu, ServerAudioOutputPdu,
    TrainingPdu, VolumePdu, Wave2Pdu, WaveDataPdu, WaveFormat, WavePdu,
};
use ironrdp::svc::{SvcMessage, SvcProcessor};

fn pcm(channels: u16, rate: u32) -> AudioFormat {
    AudioFormat {
        format: WaveFormat::PCM,
        n_channels: channels,
        n_samples_per_sec: rate,
        n_avg_bytes_per_sec: rate * u32::from(channels) * 2,
        n_block_align: channels * 2,
        bits_per_sample: 16,
        data: None,
    }
}

/// Every `wave` call as `(format, data)`.
type Waves = Arc<Mutex<Vec<(AudioFormat, Vec<u8>)>>>;

/// Records every `wave` call into [`Waves`].
#[derive(Debug)]
struct Recorder {
    formats: Vec<AudioFormat>,
    waves: Waves,
}

impl RdpsndClientHandler for Recorder {
    fn get_formats(&self) -> &[AudioFormat] {
        &self.formats
    }

    fn wave(&mut self, format: &AudioFormat, _ts: u32, data: Cow<'_, [u8]>) {
        self.waves
            .lock()
            .unwrap()
            .push((format.clone(), data.into_owned()));
    }

    fn set_volume(&mut self, _volume: VolumePdu) {}

    fn set_pitch(&mut self, _pitch: PitchPdu) {}

    fn close(&mut self) {}
}

fn server_pdu(pdu: &ServerAudioOutputPdu<'_>) -> Vec<u8> {
    encode_vec(pdu).unwrap()
}

fn single_response(responses: &[SvcMessage]) -> ClientAudioOutputPdu {
    assert_eq!(responses.len(), 1, "expected exactly one response");
    let bytes = responses[0].encode_unframed_pdu().unwrap();
    decode(&bytes).unwrap()
}

/// A client that negotiated `server_formats` (V8) with a handler advertising
/// `client_formats`, and completed training — i.e. in the Ready state.
fn ready_client(
    server_formats: Vec<AudioFormat>,
    client_formats: Vec<AudioFormat>,
) -> (Rdpsnd, Waves) {
    let waves = Waves::default();
    let mut client = Rdpsnd::new(Box::new(Recorder {
        formats: client_formats,
        waves: Arc::clone(&waves),
    }));
    let formats = ServerAudioOutputPdu::AudioFormat(ServerAudioFormatPdu {
        version: pdu::Version::V8,
        formats: server_formats,
    });
    client.process(&server_pdu(&formats)).unwrap();
    let training = ServerAudioOutputPdu::Training(TrainingPdu {
        timestamp: 1,
        data: vec![],
    });
    let confirm = single_response(&client.process(&server_pdu(&training)).unwrap());
    assert!(matches!(confirm, ClientAudioOutputPdu::TrainingConfirm(_)));
    (client, waves)
}

fn wave2(format_no: u16, block_no: u8, data: &[u8]) -> Vec<u8> {
    server_pdu(&ServerAudioOutputPdu::Wave2(Wave2Pdu {
        timestamp: 7,
        format_no,
        block_no,
        audio_timestamp: 0,
        data: Cow::Borrowed(data),
    }))
}

/// Upstream `c87ab68e` ("isolate malformed encrypted waves"): a malformed PDU
/// is ignored — not returned as an error, which fails the whole RDP session —
/// and the channel keeps playing later audio.
#[test]
fn malformed_encrypted_wave_is_ignored_and_audio_continues() {
    let format = pcm(2, 44_100);
    let (mut client, waves) = ready_client(vec![format.clone()], vec![format.clone()]);

    // SNDWAVECRYPT with its fixed part but without the mandatory v5 signature.
    let malformed_wave_encrypt = [
        0x09, 0x00, 0x08, 0x00, // SNDWAVECRYPT, body size 8
        0x00, 0x00, // wTimeStamp
        0x00, 0x00, // wFormatNo
        0x00, // cBlockNo
        0x00, 0x00, 0x00, // bPad
    ];
    let responses = client
        .process(&malformed_wave_encrypt)
        .expect("a malformed RDPSND PDU must not fail the session");
    assert!(responses.is_empty());

    let confirm = single_response(&client.process(&wave2(0, 1, &[1, 2, 3, 4])).unwrap());
    assert!(matches!(confirm, ClientAudioOutputPdu::WaveConfirm(_)));
    assert_eq!(*waves.lock().unwrap(), vec![(format, vec![1, 2, 3, 4])]);
}

#[test]
fn truncated_and_unknown_pdus_are_ignored() {
    let format = pcm(2, 48_000);
    let (mut client, waves) = ready_client(vec![format.clone()], vec![format.clone()]);
    for garbage in [
        &[][..],
        &[0x0D][..],
        &[0xFF, 0x00, 0x00, 0x00][..],
        &[0x0D, 0x00, 0xFF, 0xFF, 1][..],
    ] {
        assert!(client.process(garbage).unwrap().is_empty(), "{garbage:?}");
    }
    assert!(!client.process(&wave2(0, 2, &[9; 8])).unwrap().is_empty());
    assert_eq!(waves.lock().unwrap().len(), 1);
}

/// Upstream `2d9a9bf1`: unsupported optional PDUs keep the channel alive
/// (0.9.0 moved to the Stop state, silencing audio for the session).
#[test]
fn unsupported_crypt_key_does_not_stop_the_channel() {
    let format = pcm(1, 22_050);
    let (mut client, waves) = ready_client(vec![format.clone()], vec![format.clone()]);
    let crypt_key = server_pdu(&ServerAudioOutputPdu::CryptKey(pdu::CryptKeyPdu {
        seed: [0; 32],
    }));
    assert!(client.process(&crypt_key).unwrap().is_empty());
    assert!(!client.process(&wave2(0, 3, &[5; 4])).unwrap().is_empty());
    assert_eq!(
        waves.lock().unwrap().len(),
        1,
        "audio still plays after CryptKey"
    );
}

/// Upstream `2d9a9bf1`: `wFormatNo` (and `get_format`) index the *client*
/// format list. 0.9.0's `get_format` indexed the server's list instead.
#[test]
fn get_format_indexes_the_negotiated_client_list() {
    let only_client = pcm(2, 44_100);
    let dropped = pcm(1, 8_000);
    let (client, _) = ready_client(
        vec![dropped, only_client.clone()],
        vec![only_client.clone()],
    );
    assert_eq!(client.get_format(0).unwrap(), &only_client);
    assert!(client.get_format(1).is_err());
}

/// Pre-v8 `SNDC_WAVE` WaveInfo PDU (MS-RDPEA §2.2.3.3) for an `audio` sample:
/// the RDPSND header carries `BodySize = 8 + n`, but only the 12-byte WaveInfo
/// structure (with the first four audio bytes) is present in the message.
fn wave_info(format_no: u16, block_no: u8, timestamp: u16, audio: &[u8]) -> Vec<u8> {
    let body_size = u16::try_from(8 + audio.len()).unwrap();
    let mut bytes = vec![0x02, 0x00];
    bytes.extend_from_slice(&body_size.to_le_bytes());
    bytes.extend_from_slice(&timestamp.to_le_bytes());
    bytes.extend_from_slice(&format_no.to_le_bytes());
    bytes.push(block_no);
    bytes.extend_from_slice(&[0; 3]);
    bytes.extend_from_slice(&audio[..4]);
    bytes
}

/// The bare, header-less Wave payload (MS-RDPEA §2.2.3.4) that follows a
/// WaveInfo PDU: four `bPad` bytes standing in for the prefix, then the rest.
fn bare_wave(audio: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0; 4];
    bytes.extend_from_slice(&audio[4..]);
    bytes
}

fn assert_wave_confirm(responses: &[SvcMessage], timestamp: u16, block_no: u8) {
    match single_response(responses) {
        ClientAudioOutputPdu::WaveConfirm(confirm) => {
            assert_eq!(confirm.timestamp, timestamp);
            assert_eq!(confirm.block_no, block_no);
        }
        other => panic!("expected WaveConfirm, got {other:?}"),
    }
}

/// #3510 (upstream `2d9a9bf1`): a pre-v8 server sends WaveInfo, then the rest
/// of the sample as a separate bare Wave message. The client must wait for the
/// payload, play the reassembled sample and confirm it — 0.9.0 got no audio.
#[test]
fn split_wave_info_and_wave_play_the_reassembled_sample() {
    let format = pcm(2, 22_050);
    let (mut client, waves) = ready_client(vec![format.clone()], vec![format.clone()]);
    let audio: Vec<u8> = (1..=12).collect();

    let after_info = client.process(&wave_info(0, 4, 0x1234, &audio)).unwrap();
    assert!(after_info.is_empty(), "WaveInfo alone is not confirmed yet");
    assert!(waves.lock().unwrap().is_empty());

    let responses = client.process(&bare_wave(&audio)).unwrap();
    assert_wave_confirm(&responses, 0x1234, 4);
    assert_eq!(*waves.lock().unwrap(), vec![(format.clone(), audio)]);

    // Back in the Ready state: the next header-carrying PDU is decoded again.
    assert_wave_confirm(&client.process(&wave2(0, 5, &[7; 4])).unwrap(), 7, 5);
    assert_eq!(waves.lock().unwrap().len(), 2);
}

/// Some stacks deliver WaveInfo and the bare Wave in one buffer; the trailing
/// bytes complete the pending wave immediately.
#[test]
fn concatenated_wave_info_and_wave_play_in_one_step() {
    let format = pcm(1, 44_100);
    let (mut client, waves) = ready_client(vec![format.clone()], vec![format.clone()]);
    let audio: Vec<u8> = (10..30).collect();

    let mut payload = wave_info(0, 9, 42, &audio);
    payload.extend_from_slice(&bare_wave(&audio));
    assert_wave_confirm(&client.process(&payload).unwrap(), 42, 9);
    assert_eq!(*waves.lock().unwrap(), vec![(format, audio)]);

    // Still Ready afterwards.
    assert!(!client.process(&wave2(0, 10, &[1; 4])).unwrap().is_empty());
}

/// A bare Wave shorter than the WaveInfo audio length is confirmed (so the
/// server's latency accounting advances) but not played, and the channel
/// returns to Ready.
#[test]
fn short_wave_payload_is_confirmed_without_playback() {
    let format = pcm(2, 44_100);
    let (mut client, waves) = ready_client(vec![format.clone()], vec![format.clone()]);
    let audio: Vec<u8> = (0..16).collect();

    assert!(client
        .process(&wave_info(0, 2, 99, &audio))
        .unwrap()
        .is_empty());
    let short = &bare_wave(&audio)[..6];
    assert_wave_confirm(&client.process(short).unwrap(), 99, 2);
    assert!(waves.lock().unwrap().is_empty());

    assert!(!client.process(&wave2(0, 3, &[2; 4])).unwrap().is_empty());
    assert_eq!(waves.lock().unwrap().len(), 1);
}

/// A WaveInfo whose `wFormatNo` is outside the negotiated client list is still
/// confirmed, but nothing is handed to the handler (no guessing a format).
#[test]
fn wave_info_with_out_of_range_format_no_is_confirmed_not_played() {
    let format = pcm(2, 48_000);
    let (mut client, waves) = ready_client(vec![format.clone()], vec![format]);
    let audio = [3u8; 8];

    assert!(client
        .process(&wave_info(5, 6, 11, &audio))
        .unwrap()
        .is_empty());
    assert_wave_confirm(&client.process(&bare_wave(&audio)).unwrap(), 11, 6);
    assert!(waves.lock().unwrap().is_empty());
}

/// The pre-v8 `wFormatNo` resolves against the negotiated *client* list, like
/// `Wave2` (#1773): with a server format dropped, index 0 is the client's.
#[test]
fn wave_info_format_no_indexes_the_negotiated_client_list() {
    let only_client = pcm(2, 44_100);
    let dropped = pcm(1, 8_000);
    let (mut client, waves) = ready_client(
        vec![dropped, only_client.clone()],
        vec![only_client.clone()],
    );
    let audio = [4u8; 8];
    let mut payload = wave_info(0, 1, 1, &audio);
    payload.extend_from_slice(&bare_wave(&audio));
    assert_wave_confirm(&client.process(&payload).unwrap(), 1, 1);
    assert_eq!(*waves.lock().unwrap(), vec![(only_client, audio.to_vec())]);
}

/// A WaveInfo announcing fewer than the four prefix bytes is malformed and
/// ignored; the channel stays Ready rather than waiting for a payload.
#[test]
fn wave_info_shorter_than_its_prefix_is_ignored() {
    let format = pcm(2, 44_100);
    let (mut client, waves) = ready_client(vec![format.clone()], vec![format]);
    let mut bad = wave_info(0, 1, 1, &[0; 4]);
    bad[2..4].copy_from_slice(&10u16.to_le_bytes()); // BodySize 10 -> n = 2
    assert!(client.process(&bad).unwrap().is_empty());
    assert!(!client.process(&wave2(0, 2, &[1; 4])).unwrap().is_empty());
    assert_eq!(waves.lock().unwrap().len(), 1);
}

/// The re-typed `WavePdu` (WaveInfo only, `BodySize = 8 + n`) and the bare
/// `WaveDataPdu` encode exactly what a pre-v8 server puts on the wire, and the
/// client plays the two messages as one sample.
#[test]
fn encoded_wave_info_and_wave_data_round_trip_through_the_client() {
    let format = pcm(2, 44_100);
    let (mut client, waves) = ready_client(vec![format.clone()], vec![format.clone()]);
    let audio: Vec<u8> = (0..10).collect();

    let info = server_pdu(&ServerAudioOutputPdu::Wave(WavePdu {
        timestamp: 3,
        format_no: 0,
        block_no: 8,
        data_prefix: [0, 1, 2, 3],
        audio_length: 10,
    }));
    assert_eq!(info, wave_info(0, 8, 3, &audio));
    let data = encode_vec(&WaveDataPdu {
        data: audio[4..].to_vec(),
    })
    .unwrap();
    assert_eq!(data, bare_wave(&audio));

    assert!(client.process(&info).unwrap().is_empty());
    assert_wave_confirm(&client.process(&data).unwrap(), 3, 8);
    assert_eq!(*waves.lock().unwrap(), vec![(format, audio)]);

    // Encoding rejects an audio length that cannot hold the Data prefix.
    let too_short = ServerAudioOutputPdu::Wave(WavePdu {
        timestamp: 0,
        format_no: 0,
        block_no: 0,
        data_prefix: [0; 4],
        audio_length: 3,
    });
    assert!(encode_vec(&too_short).is_err());
}
