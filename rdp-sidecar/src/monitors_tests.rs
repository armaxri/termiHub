//! Tests for the multi-monitor PDU encoding (#3696).

use super::*;
use ironrdp::core::{decode, encode_vec};
use ironrdp::pdu::mcs::ConnectInitial;
use ironrdp::pdu::nego::SecurityProtocol;
use ironrdp::pdu::x224::{X224Data, X224};
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

fn connector_for(cfg: &RdpConfig) -> ClientConnector {
    let config = crate::rdp::build_connector_config(cfg).expect("connector config");
    let mut connector = ClientConnector::new(config, "127.0.0.1:0".parse().unwrap());
    connector.state = ClientConnectorState::BasicSettingsExchangeSendInitial {
        selected_protocol: SecurityProtocol::SSL,
    };
    connector
}

#[test]
fn the_connect_initial_carries_the_monitor_layout_and_the_combined_size() {
    let layout = desk();
    let cfg = RdpConfig {
        host: "h".to_string(),
        monitors: "all".to_string(),
        monitor_layout: layout.monitors().to_vec(),
        ..Default::default()
    };
    let mut connector = connector_for(&cfg);
    let mut buf = WriteBuf::new();
    let written = send_basic_settings(&mut connector, &mut buf, &layout).expect("encoded");
    assert_eq!(written, buf.filled().len());

    // What goes on the wire…
    let x224: X224<X224Data<'_>> = decode(buf.filled()).expect("x224 frame");
    let sent: ConnectInitial = decode(x224.0.data.as_ref()).expect("connect initial");
    let blocks = sent.conference_create_request.gcc_blocks();
    let monitors = &blocks.monitor.as_ref().expect("TS_UD_CS_MONITOR").monitors;
    assert_eq!(monitors.len(), 2);
    assert_eq!(monitors[1].flags, MonitorFlags::PRIMARY);
    // …declares the bounding box of the layout as the desktop size.
    assert_eq!(
        (blocks.core.desktop_width, blocks.core.desktop_height),
        (3200, 1136)
    );

    // The connector keeps the patched PDU for the rest of the sequence.
    let ClientConnectorState::BasicSettingsExchangeWaitResponse { connect_initial } =
        &connector.state
    else {
        panic!("connector must await the Connect Response");
    };
    assert_eq!(encode_vec(connect_initial).unwrap(), x224.0.data.as_ref());
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
