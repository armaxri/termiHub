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
    TrainingPdu, VolumePdu, Wave2Pdu, WaveFormat,
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
