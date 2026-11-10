//! Multi-monitor RDP sessions (#3696, audit PROD-018).
//!
//! Two wire paths carry the client's monitor layout:
//!
//! - **At connect** — the GCC Conference Create Request's client monitor data
//!   (MS-RDPBCGR `TS_UD_CS_MONITOR`, plus `TS_UD_CS_MONITOR_EX` when a monitor
//!   is scaled). [`connector_layout`] converts the layout into the blocks, and
//!   the sidecar hands them to IronRDP's connector as `Config::monitor_layout` /
//!   `Config::monitor_extended_layout` (ironrdp-connector 0.11+, #5141). The
//!   connector sends them only when the server set `EXTENDED_CLIENT_DATA_SUPPORTED`
//!   in its RDP Negotiation Response, as MS-RDPBCGR 2.2.1.3 requires for
//!   extended client data blocks. Until #5141 the sidecar drove that connector
//!   step itself and added the blocks unconditionally (#3696).
//! - **At runtime** — one Display Control monitor-layout PDU (MS-RDPEDISP) with
//!   every monitor ([`encode_layout`]), built here from the layout and encoded
//!   by `ActiveStage::encode_monitor_layout`.
//!
//! The layout arriving here is already normalized by
//! [`MonitorLayout::normalize`] (primary at the origin, sizes in range, at most
//! 16 monitors), so this module only converts it.

use anyhow::{anyhow, Result};
use ironrdp_displaycontrol::pdu::{
    DeviceScaleFactor, DisplayControlMonitorLayout, MonitorLayoutEntry,
    MonitorOrientation as DisplayOrientation,
};
use ironrdp_pdu::gcc::{
    ClientMonitorData, ClientMonitorExtendedData, ExtendedMonitorInfo, Monitor, MonitorFlags,
    MonitorOrientation,
};
use ironrdp_session::ActiveStage;
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

/// The connector's `Config::monitor_layout` / `Config::monitor_extended_layout`
/// for a session: the GCC blocks of `layout` ([`gcc_blocks`]), or neither for a
/// single-monitor session (`None`), which keeps its Connect Initial free of
/// monitor blocks.
pub fn connector_layout(
    layout: Option<&MonitorLayout>,
) -> (Option<ClientMonitorData>, Option<ClientMonitorExtendedData>) {
    match layout {
        Some(layout) => {
            let (data, extended) = gcc_blocks(layout.monitors());
            (Some(data), extended)
        }
        None => (None, None),
    }
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
/// open yet or the server has not sent its capabilities (same contract as
/// `ActiveStage::encode_resize`). IronRDP fits the layout to the server's
/// capabilities (`DisplayControlMonitorLayout::fit_to_capabilities`: at most
/// its `MaxNumMonitors`, within its area) before encoding it (#5117).
pub fn encode_layout(stage: &mut ActiveStage, monitors: &[MonitorRect]) -> Option<Result<Vec<u8>>> {
    let layout = match layout_entries(monitors).and_then(|entries| {
        DisplayControlMonitorLayout::new(&entries)
            .map_err(|e| anyhow!("invalid monitor layout: {e}"))
    }) {
        Ok(layout) => layout,
        Err(e) => return Some(Err(e)),
    };
    stage
        .encode_monitor_layout(&layout)
        .map(|encoded| encoded.map_err(|e| anyhow!("encode monitor layout: {e}")))
}

#[cfg(test)]
#[path = "monitors_tests.rs"]
mod tests;
