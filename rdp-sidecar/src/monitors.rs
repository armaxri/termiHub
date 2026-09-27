//! Multi-monitor RDP sessions (#3696, audit PROD-018).
//!
//! Two wire paths carry the client's monitor layout:
//!
//! - **At connect** — the GCC Conference Create Request's client monitor data
//!   (MS-RDPBCGR `TS_UD_CS_MONITOR`, plus `TS_UD_CS_MONITOR_EX` when a monitor
//!   is scaled). IronRDP 0.10's connector always sends `monitor: None`, so
//!   [`send_basic_settings`] drives that one connector step itself: it lets the
//!   connector build its Connect Initial as usual, adds the monitor blocks, and
//!   sends the re-encoded PDU. The connector keeps the patched PDU in its state,
//!   so the rest of the sequence sees exactly what went on the wire. No vendored
//!   fork of `ironrdp-connector` is needed.
//! - **At runtime** — one Display Control monitor-layout PDU (MS-RDPEDISP) with
//!   every monitor ([`encode_layout`]); IronRDP only offers a single-monitor
//!   helper, so the multi-monitor PDU is built here from its public types.
//!
//! The layout arriving here is already normalized by
//! [`MonitorLayout::normalize`] (primary at the origin, sizes in range, at most
//! 16 monitors), so this module only converts it.

use anyhow::{anyhow, Result};
use ironrdp::connector::{
    encode_x224_packet, ClientConnector, ClientConnectorState, ConnectorError,
    ConnectorErrorExt as _, ConnectorResult, Sequence as _,
};
use ironrdp::core::WriteBuf;
use ironrdp::displaycontrol::client::DisplayControlClient;
use ironrdp::displaycontrol::pdu::{
    DeviceScaleFactor, DisplayControlMonitorLayout, DisplayControlPdu, MonitorLayoutEntry,
    MonitorOrientation as DisplayOrientation,
};
use ironrdp::pdu::gcc::{
    ClientMonitorData, ClientMonitorExtendedData, ConferenceCreateRequest, ExtendedMonitorInfo,
    Monitor, MonitorFlags, MonitorOrientation,
};
use ironrdp::session::ActiveStage;
use ironrdp::svc::ChannelFlags;
use termihub_core::connection::{MonitorLayout, MonitorRect};

/// Unscaled, in percent.
const UNSCALED: u32 = 100;

fn landscape(m: &MonitorRect) -> bool {
    m.width >= m.height
}

/// The GCC client monitor blocks for `monitors`: `TS_UD_CS_MONITOR` always,
/// and `TS_UD_CS_MONITOR_EX` only when some monitor is scaled (it carries
/// nothing else we set).
pub fn gcc_blocks(
    monitors: &[MonitorRect],
) -> (ClientMonitorData, Option<ClientMonitorExtendedData>) {
    let data = ClientMonitorData {
        monitors: monitors
            .iter()
            .map(|m| Monitor {
                left: m.x,
                top: m.y,
                // TS_MONITOR_DEF right/bottom are inclusive.
                right: m
                    .x
                    .saturating_add(i32::try_from(m.width).unwrap_or(i32::MAX))
                    - 1,
                bottom: m
                    .y
                    .saturating_add(i32::try_from(m.height).unwrap_or(i32::MAX))
                    - 1,
                flags: if m.primary {
                    MonitorFlags::PRIMARY
                } else {
                    MonitorFlags::empty()
                },
            })
            .collect(),
    };
    let scaled = monitors.iter().any(|m| m.scale != UNSCALED);
    let extended = scaled.then(|| ClientMonitorExtendedData {
        extended_monitors_info: monitors
            .iter()
            .map(|m| ExtendedMonitorInfo {
                physical_width: 0,
                physical_height: 0,
                orientation: if landscape(m) {
                    MonitorOrientation::Landscape
                } else {
                    MonitorOrientation::Portrait
                },
                desktop_scale_factor: m.scale,
                device_scale_factor: UNSCALED,
            })
            .collect(),
    });
    (data, extended)
}

/// Perform the connector's Basic Settings Exchange send step with the client
/// monitor blocks for `layout` added to the GCC Conference Create Request.
///
/// Call it only in [`ClientConnectorState::BasicSettingsExchangeSendInitial`];
/// `buf` receives the X.224-framed Connect Initial to write to the server.
/// Returns the number of bytes written.
pub fn send_basic_settings(
    connector: &mut ClientConnector,
    buf: &mut WriteBuf,
    layout: &MonitorLayout,
) -> ConnectorResult<usize> {
    buf.clear();
    // Let the connector build its Connect Initial (and advance its state).
    connector.step_no_input(buf)?;
    let ClientConnectorState::BasicSettingsExchangeWaitResponse { connect_initial } =
        &mut connector.state
    else {
        // Not the step this was meant for: send what the connector produced.
        return Ok(buf.filled().len());
    };
    let mut blocks = connect_initial
        .conference_create_request
        .gcc_blocks()
        .clone();
    let (monitor, monitor_extended) = gcc_blocks(layout.monitors());
    blocks.monitor = Some(monitor);
    blocks.monitor_extended = monitor_extended;
    connect_initial.conference_create_request =
        ConferenceCreateRequest::new(blocks).map_err(ConnectorError::decode)?;
    buf.clear();
    encode_x224_packet(&*connect_initial, buf)
}

/// Build the Display Control monitor-layout entries for `monitors`.
pub fn layout_entries(monitors: &[MonitorRect]) -> Result<Vec<MonitorLayoutEntry>> {
    monitors
        .iter()
        .map(|m| {
            let (w, h) = MonitorLayoutEntry::adjust_display_size(m.width, m.height);
            let entry = if m.primary {
                MonitorLayoutEntry::new_primary(w, h)
            } else {
                MonitorLayoutEntry::new_secondary(w, h)
            }
            .map_err(|e| anyhow!("invalid monitor size: {e}"))?
            .with_orientation(if landscape(m) {
                DisplayOrientation::Landscape
            } else {
                DisplayOrientation::Portrait
            });
            // The primary is at the origin (normalized); the entry rejects
            // anything else for it, which would mean a caller bug.
            let entry = entry
                .with_position(m.x, m.y)
                .map_err(|e| anyhow!("invalid monitor position: {e}"))?;
            if m.scale == UNSCALED {
                return Ok(entry);
            }
            Ok(entry
                .with_desktop_scale_factor(m.scale)
                .map_err(|e| anyhow!("invalid monitor scale: {e}"))?
                .with_device_scale_factor(DeviceScaleFactor::Scale100Percent))
        })
        .collect()
}

/// Encode a Display Control monitor-layout PDU carrying every monitor, ready
/// to write to the server. `None` while the Display Control channel is not
/// open yet (same contract as `ActiveStage::encode_resize`).
pub fn encode_layout(stage: &mut ActiveStage, monitors: &[MonitorRect]) -> Option<Result<Vec<u8>>> {
    let channel_id = stage.get_dvc::<DisplayControlClient>()?.channel_id()?;
    Some((|| {
        let entries = layout_entries(monitors)?;
        let pdu: DisplayControlPdu = DisplayControlMonitorLayout::new(&entries)
            .map_err(|e| anyhow!("invalid monitor layout: {e}"))?
            .into();
        let messages = ironrdp::dvc::encode_dvc_messages(
            channel_id,
            vec![Box::new(pdu)],
            ChannelFlags::empty(),
        )
        .map_err(|e| anyhow!("encode monitor layout: {e}"))?;
        stage
            .encode_dvc_messages(messages)
            .map_err(|e| anyhow!("encode monitor layout: {e}"))
    })())
}

#[cfg(test)]
#[path = "monitors_tests.rs"]
mod tests;
