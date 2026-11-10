//! Tests for the multi-monitor PDU encoding (#3696).

use super::*;
use ironrdp_connector::{
    encode_x224_packet, ClientConnector, ClientConnectorState, Config as ConnectorConfig,
    Sequence as _,
};
use ironrdp_core::{decode, encode_vec, WriteBuf};
use ironrdp_displaycontrol::pdu::DisplayControlPdu;
use ironrdp_pdu::gcc::{ClientEarlyCapabilityFlags, ClientGccBlocks, ConferenceCreateRequest};
use ironrdp_pdu::mcs::ConnectInitial;
use ironrdp_pdu::nego::{ConnectionConfirm, ResponseFlags, SecurityProtocol};
use ironrdp_pdu::x224::{X224Data, X224};
use termihub_core::backends::rdp_sidecar::config::RdpConfig;

/// A primary 1920x1080 with a 1280x1024 monitor to its left, 56 px higher.
fn desk() -> MonitorLayout {
    MonitorLayout::normalize(&[
        MonitorRect::new(0, 0, 1280, 1024),
        MonitorRect {
            primary: true,
            ..MonitorRect::new(1280, 56, 1920, 1080)
        },
    ])
    .expect("two monitors")
}

#[test]
fn gcc_monitor_data_uses_inclusive_edges_and_flags_the_primary() {
    let (data, extended) = gcc_blocks(desk().monitors());
    assert_eq!(
        data.monitors,
        vec![
            Monitor {
                left: -1280,
                top: -56,
                right: -1,
                bottom: 967,
                flags: MonitorFlags::empty(),
            },
            Monitor {
                left: 0,
                top: 0,
                right: 1919,
                bottom: 1079,
                flags: MonitorFlags::PRIMARY,
            },
        ]
    );
    // Nothing is scaled, so the extended block is left out.
    assert!(extended.is_none());
}

#[test]
fn gcc_extended_monitor_data_carries_the_scale() {
    let mut monitors = desk().monitors().to_vec();
    monitors[1].scale = 150;
    let (_, extended) = gcc_blocks(&monitors);
    let info = extended.expect("a scaled monitor needs TS_UD_CS_MONITOR_EX");
    assert_eq!(info.extended_monitors_info.len(), 2);
    assert_eq!(info.extended_monitors_info[0].desktop_scale_factor, 100);
    assert_eq!(info.extended_monitors_info[1].desktop_scale_factor, 150);
    assert_eq!(info.extended_monitors_info[1].device_scale_factor, 100);
}

// ── The Connect Initial (#5141) ─────────────────────────────────────
//
// Until #5141 the sidecar drove the connector's Basic Settings Exchange send
// step itself: it let the connector build the Connect Initial with no monitor
// layout, added the GCC monitor blocks and re-encoded the PDU. The tests below
// keep that path as `legacy_connect_initial` and prove the connector, given the
// same blocks through its `Config`, puts the same bytes on the wire.

/// What Windows Server answers in its RDP Negotiation Response.
const WINDOWS_FLAGS: ResponseFlags = ResponseFlags::EXTENDED_CLIENT_DATA_SUPPORTED
    .union(ResponseFlags::DYNVC_GFX_PROTOCOL_SUPPORTED)
    .union(ResponseFlags::RDP_NEG_RSP_RESERVED)
    .union(ResponseFlags::RESTRICTED_ADMIN_MODE_SUPPORTED);

/// A connector at its Basic Settings Exchange send step, after a server
/// confirmed TLS with `flags` in its RDP Negotiation Response (the connector
/// keeps the flags; `EXTENDED_CLIENT_DATA_SUPPORTED` gates extended blocks).
fn connector_at_basic_settings(config: ConnectorConfig, flags: ResponseFlags) -> ClientConnector {
    let mut connector = ClientConnector::new(config, "127.0.0.1:0".parse().unwrap());
    connector.state = ClientConnectorState::ConnectionInitiationWaitConfirm {
        requested_protocol: SecurityProtocol::SSL,
    };
    let confirm = encode_vec(&X224(ConnectionConfirm::Response {
        flags,
        protocol: SecurityProtocol::SSL,
    }))
    .unwrap();
    connector
        .step(&confirm, None, &mut WriteBuf::new())
        .expect("connection confirm");
    // TLS-only: the security upgrade leads straight to the basic settings.
    connector.mark_security_upgrade_as_done();
    assert!(matches!(
        connector.state,
        ClientConnectorState::BasicSettingsExchangeSendInitial { .. }
    ));
    connector
}

/// The X.224-framed Connect Initial the sidecar sends for `cfg` (#5141): the
/// connector's own Basic Settings Exchange step.
fn connect_initial(cfg: &RdpConfig, flags: ResponseFlags) -> Vec<u8> {
    let config = crate::rdp::build_connector_config(cfg).expect("connector config");
    let mut connector = connector_at_basic_settings(config, flags);
    let mut buf = WriteBuf::new();
    connector.step_no_input(&mut buf).expect("connect initial");
    let sent = buf.filled().to_vec();
    // The connector keeps exactly what went on the wire for the rest of the
    // sequence (it reads the client blocks back on the Connect Response).
    let ClientConnectorState::BasicSettingsExchangeWaitResponse { connect_initial } =
        &connector.state
    else {
        panic!("connector must await the Connect Response");
    };
    let mut kept = WriteBuf::new();
    encode_x224_packet(connect_initial, &mut kept).unwrap();
    assert_eq!(kept.filled(), &sent[..]);
    sent
}

/// The Connect Initial as the sidecar sent it before #5141: the connector's
/// PDU with no monitor layout, patched by the removed `send_basic_settings`
/// (verbatim apart from its error type) for a multi-monitor session.
fn legacy_connect_initial(cfg: &RdpConfig, flags: ResponseFlags) -> Vec<u8> {
    let mut config = crate::rdp::build_connector_config(cfg).expect("connector config");
    config.monitor_layout = None;
    config.monitor_extended_layout = None;
    let mut connector = connector_at_basic_settings(config, flags);
    let mut buf = WriteBuf::new();
    connector.step_no_input(&mut buf).expect("connect initial");
    let Some(layout) = cfg.multi_monitor_layout() else {
        // Single-monitor sessions never took the hook.
        return buf.filled().to_vec();
    };
    let ClientConnectorState::BasicSettingsExchangeWaitResponse { connect_initial } =
        &mut connector.state
    else {
        panic!("connector must await the Connect Response");
    };
    let mut blocks = connect_initial
        .conference_create_request
        .gcc_blocks()
        .clone();
    let (monitor, monitor_extended) = gcc_blocks(layout.monitors());
    blocks.monitor = Some(monitor);
    blocks.monitor_extended = monitor_extended;
    connect_initial.conference_create_request =
        ConferenceCreateRequest::new(blocks).expect("conference create request");
    buf.clear();
    encode_x224_packet(&*connect_initial, &mut buf).unwrap();
    buf.filled().to_vec()
}

fn gcc_blocks_of(x224_bytes: &[u8]) -> ClientGccBlocks {
    let x224: X224<X224Data<'_>> = decode(x224_bytes).expect("x224 frame");
    let sent: ConnectInitial = decode(x224.0.data.as_ref()).expect("connect initial");
    sent.conference_create_request.gcc_blocks().clone()
}

fn single_monitor() -> RdpConfig {
    RdpConfig {
        host: "h".to_string(),
        ..Default::default()
    }
}

fn multi_monitor(monitors: Vec<MonitorRect>) -> RdpConfig {
    RdpConfig {
        host: "h".to_string(),
        monitors: "all".to_string(),
        monitor_layout: monitors,
        ..Default::default()
    }
}

fn scaled_desk() -> Vec<MonitorRect> {
    let mut monitors = desk().monitors().to_vec();
    monitors[1].scale = 150;
    monitors
}

#[test]
fn a_single_monitor_session_configures_no_monitor_layout() {
    let config = crate::rdp::build_connector_config(&single_monitor()).unwrap();
    assert!(config.monitor_layout.is_none());
    assert!(config.monitor_extended_layout.is_none());
}

#[test]
fn a_multi_monitor_session_configures_the_gcc_monitor_blocks() {
    let cfg = multi_monitor(scaled_desk());
    let config = crate::rdp::build_connector_config(&cfg).unwrap();
    let (data, extended) = gcc_blocks(cfg.multi_monitor_layout().unwrap().monitors());
    assert_eq!(config.monitor_layout, Some(data));
    assert_eq!(config.monitor_extended_layout, extended);
    // The connector requires the desktop to be the layout's bounding box.
    assert_eq!(
        (config.desktop_size.width, config.desktop_size.height),
        (3200, 1136)
    );
}

#[test]
fn the_connect_initial_is_byte_identical_to_the_pre_5141_path() {
    let cases = [
        ("single monitor", single_monitor()),
        ("two monitors", multi_monitor(desk().monitors().to_vec())),
        ("two monitors, one scaled", multi_monitor(scaled_desk())),
    ];
    for (label, cfg) in &cases {
        for flags in [ResponseFlags::EXTENDED_CLIENT_DATA_SUPPORTED, WINDOWS_FLAGS] {
            assert_eq!(
                connect_initial(cfg, flags),
                legacy_connect_initial(cfg, flags),
                "{label}, server flags {flags:?}"
            );
        }
    }
    // Single-monitor sessions never carried monitor blocks, with any server.
    let cfg = single_monitor();
    assert_eq!(
        connect_initial(&cfg, ResponseFlags::empty()),
        legacy_connect_initial(&cfg, ResponseFlags::empty())
    );
}

#[test]
fn the_connect_initial_carries_the_monitor_layout_and_the_combined_size() {
    let cfg = multi_monitor(desk().monitors().to_vec());
    let blocks = gcc_blocks_of(&connect_initial(
        &cfg,
        ResponseFlags::EXTENDED_CLIENT_DATA_SUPPORTED,
    ));
    let monitors = &blocks.monitor.as_ref().expect("TS_UD_CS_MONITOR").monitors;
    assert_eq!(monitors.len(), 2);
    assert_eq!(monitors[1].flags, MonitorFlags::PRIMARY);
    // Nothing is scaled, so TS_UD_CS_MONITOR_EX stays out.
    assert!(blocks.monitor_extended.is_none());
    // The bounding box of the layout is the desktop size.
    assert_eq!(
        (blocks.core.desktop_width, blocks.core.desktop_height),
        (3200, 1136)
    );
    // Monitor Layout PDU support was advertised before #5141 too: the
    // connector sets it from the server's flags, not from the layout.
    let early = blocks.core.optional_data.early_capability_flags.unwrap();
    assert!(early.contains(ClientEarlyCapabilityFlags::SUPPORT_MONITOR_LAYOUT_PDU));
}

#[test]
fn the_connect_initial_carries_the_extended_monitor_data_for_a_scaled_layout() {
    let cfg = multi_monitor(scaled_desk());
    let blocks = gcc_blocks_of(&connect_initial(
        &cfg,
        ResponseFlags::EXTENDED_CLIENT_DATA_SUPPORTED,
    ));
    let extended = blocks.monitor_extended.expect("TS_UD_CS_MONITOR_EX");
    let scales: Vec<u32> = extended
        .extended_monitors_info
        .iter()
        .map(|m| m.desktop_scale_factor)
        .collect();
    assert_eq!(scales, vec![100, 150]);
}

/// The one wire difference from the pre-#5141 path: a server that did not set
/// `EXTENDED_CLIENT_DATA_SUPPORTED` no longer receives the monitor blocks,
/// which are extended client data (MS-RDPBCGR 2.2.1.2.1, 2.2.1.3.6). Everything
/// else in the PDU is unchanged.
#[test]
fn a_server_without_extended_client_data_gets_no_monitor_blocks() {
    for cfg in [
        multi_monitor(desk().monitors().to_vec()),
        multi_monitor(scaled_desk()),
    ] {
        let new = gcc_blocks_of(&connect_initial(&cfg, ResponseFlags::empty()));
        assert!(new.monitor.is_none());
        assert!(new.monitor_extended.is_none());
        let early = new.core.optional_data.early_capability_flags.unwrap();
        assert!(!early.contains(ClientEarlyCapabilityFlags::SUPPORT_MONITOR_LAYOUT_PDU));

        let mut legacy = gcc_blocks_of(&legacy_connect_initial(&cfg, ResponseFlags::empty()));
        assert!(
            legacy.monitor.is_some(),
            "the old path added them regardless"
        );
        legacy.monitor = None;
        legacy.monitor_extended = None;
        assert_eq!(new, legacy);
        // The desktop is still the layout's bounding box.
        assert_eq!(
            (new.core.desktop_width, new.core.desktop_height),
            (3200, 1136)
        );
    }
}

#[test]
fn display_control_entries_keep_positions_and_the_primary() {
    let entries = layout_entries(desk().monitors()).expect("entries");
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].position(), Some((-1280, -56)));
    assert!(!entries[0].is_primary());
    assert_eq!(entries[0].dimensions(), (1280, 1024));
    assert!(entries[1].is_primary());

    // They form a valid MS-RDPEDISP layout that survives an encode/decode.
    let pdu: DisplayControlPdu = DisplayControlMonitorLayout::new(&entries).unwrap().into();
    let bytes = encode_vec(&pdu).unwrap();
    match decode::<DisplayControlPdu>(&bytes).unwrap() {
        DisplayControlPdu::MonitorLayout(layout) => assert_eq!(layout.monitors(), &entries[..]),
        other => panic!("expected a monitor layout, got {other:?}"),
    }
}

#[test]
fn display_control_entries_carry_a_scale() {
    let mut monitors = desk().monitors().to_vec();
    monitors[0].scale = 200;
    let entries = layout_entries(&monitors).expect("entries");
    assert_eq!(entries[0].desktop_scale_factor(), Some(200));
    assert_eq!(entries[1].desktop_scale_factor(), None);
}
