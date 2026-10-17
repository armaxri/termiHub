//! Regression tests for the upstream IronRDP fixes ported into the vendored
//! `ironrdp-pdu` fork (#4461). The vendored crate's own unit tests need
//! dev-dependencies the excluded sidecar graph does not lock, so the ported
//! behaviour is exercised here through the `ironrdp::pdu` re-export the sidecar
//! actually links.

use ironrdp::core::{decode, encode_vec};
use ironrdp::pdu::gcc::{
    ServerCoreData, ServerCoreOptionalData, ServerGccBlocks, ServerNetworkData, ServerSecurityData,
};
use ironrdp::pdu::rdp::headers::{
    ShareControlHeader, ShareControlPdu, ShareDataHeader, ShareDataPdu,
};
use ironrdp::pdu::rdp::server_error_info::{
    ErrorInfo, ProtocolIndependentCode, ServerSetErrorInfoPdu,
};
use ironrdp::pdu::rdp::session_info::ServerAutoReconnect;

/// A Data PDU (Share Control + Share Data headers, 18 bytes) with the given
/// `pduType2` and a zero `totalLength`, which the tests then patch.
fn data_pdu(pdu_type2: u8) -> [u8; 18] {
    [
        0x00, 0x00, // totalLength
        0x17, 0x00, // pduType (Data PDU) + protocolVersion
        0xE9, 0x03, // pduSource
        0xDD, 0xCC, 0xBB, 0xAA, // shareId
        0x00, // pad1
        0x04, // streamId (Medium)
        0x00, 0x00, // uncompressedLength
        pdu_type2, 0x00, // pduType2, compressedType
        0x00, 0x00, // compressedLength
    ]
}

/// Upstream 33506e61: a frame whose declared length is smaller than its own
/// header is refused instead of being handed to the framed reader.
#[test]
fn find_size_rejects_undersized_frames() {
    assert!(
        ironrdp::pdu::find_size(&[0x00, 0x01]).is_err(),
        "fast-path, 1 byte"
    );
    assert!(
        ironrdp::pdu::find_size(&[0x00, 0x80, 0x02]).is_err(),
        "fast-path, long form"
    );
    assert!(
        ironrdp::pdu::find_size(&[0x03, 0x00, 0x00, 0x06]).is_err(),
        "TPKT under 7"
    );
    // A well-formed minimal TPKT still sizes.
    let info = ironrdp::pdu::find_size(&[0x03, 0x00, 0x00, 0x07])
        .unwrap()
        .unwrap();
    assert_eq!(info.length, 7);
}

/// Upstream 33506e61: an empty Update / Pointer PDU with `totalLength` 0 is a
/// no-op; any other zero-length Data PDU is still refused.
#[test]
fn zero_length_empty_output_pdus_are_no_ops() {
    for pdu_type2 in [0x02, 0x1B] {
        let decoded: ShareControlHeader = decode(&data_pdu(pdu_type2)).expect("empty output PDU");
        assert!(matches!(
            decoded.share_control_pdu,
            ShareControlPdu::Data(_)
        ));
    }
    assert!(decode::<ShareControlHeader>(&data_pdu(0x25)).is_err());
}

/// Upstream 9b04c90c / e496b7b8: VirtualBox VRDP declares a Server Font Map as
/// its two headers only (18 bytes), with or without the 8-byte body present.
#[test]
fn vrdp_under_declared_font_map_decodes() {
    let mut with_body = [0u8; 26];
    with_body[..18].copy_from_slice(&data_pdu(0x28));
    with_body[0] = 18;
    let mut header_only = data_pdu(0x28);
    header_only[0] = 18;

    for bytes in [&with_body[..], &header_only[..]] {
        let decoded: ShareControlHeader = decode(bytes).expect("VRDP Font Map");
        assert!(matches!(
            decoded.share_control_pdu,
            ShareControlPdu::Data(ShareDataHeader {
                share_data_pdu: ShareDataPdu::FontMap(_),
                ..
            })
        ));
    }
}

/// The under-declaration carve-out stays limited to the Font Map.
#[test]
fn other_under_declared_data_pdus_are_refused() {
    let mut shutdown_denied = data_pdu(0x25);
    shutdown_denied[0] = 17;
    assert!(decode::<ShareControlHeader>(&shutdown_denied).is_err());

    for pdu_type2 in [0x02, 0x1B] {
        for total_length in 1u16..18 {
            let mut bytes = data_pdu(pdu_type2);
            bytes[..2].copy_from_slice(&total_length.to_le_bytes());
            assert!(
                decode::<ShareControlHeader>(&bytes).is_err(),
                "{pdu_type2:#04x}/{total_length}"
            );
        }
    }
}

/// Upstream 629a8024: a server user-data block IronRDP does not model is
/// skipped instead of failing the GCC Conference Create Response.
#[test]
fn unknown_server_gcc_block_is_skipped() {
    let blocks = ServerGccBlocks {
        core: ServerCoreData {
            version: ironrdp::pdu::gcc::RdpVersion::V5_PLUS,
            optional_data: ServerCoreOptionalData::default(),
        },
        network: ServerNetworkData {
            channel_ids: vec![1004],
            io_channel: 1003,
        },
        security: ServerSecurityData::no_security(),
        message_channel: None,
        multi_transport_channel: None,
    };
    let mut bytes = encode_vec(&blocks).unwrap();
    bytes.extend_from_slice(&[0xFF, 0xC0, 0x08, 0x00, 0x01, 0x02, 0x03, 0x04]);

    let decoded: ServerGccBlocks = decode(&bytes).expect("unknown block is skipped");
    assert_eq!(decoded, blocks);
}

/// Upstream d2bb7376: ERRINFO_SERVER_SHUTDOWN / ERRINFO_SERVER_REBOOT decode, so a
/// server going down reports why instead of failing with a decode error.
#[test]
fn server_shutdown_and_reboot_error_info_decode() {
    for (code, expected) in [
        (0x19u8, ProtocolIndependentCode::ServerShutdown),
        (0x1A, ProtocolIndependentCode::ServerReboot),
    ] {
        let decoded: ServerSetErrorInfoPdu = decode(&[code, 0x00, 0x00, 0x00]).unwrap();
        assert_eq!(
            decoded,
            ServerSetErrorInfoPdu(ErrorInfo::ProtocolIndependentCode(expected))
        );
    }
}

/// Upstream d0948faa: the auto-reconnect random is credential material and
/// must not reach logs through `Debug`.
#[test]
fn server_auto_reconnect_random_is_redacted() {
    let cookie = ServerAutoReconnect {
        logon_id: 42,
        random_bits: [0xAB; 16],
    };
    let rendered = format!("{cookie:?}");
    assert!(!rendered.contains("171"), "leaked the random: {rendered}");
    assert!(rendered.contains("42"));
}
