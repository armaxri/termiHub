//! Multi-monitor layouts for graphical remote-desktop sessions (#3696,
//! audit PROD-018).
//!
//! A graphical connection either uses one monitor (the default, and the only
//! behavior before #3696) or spans several. The **Monitors** row of the
//! connection editor picks one of three modes:
//!
//! - **single** — one monitor, exactly as before.
//! - **all** — one remote monitor per local display. The frontend reads the
//!   local display geometry (Tauri monitor API) at connect time and stamps it
//!   into the connect settings as [`MONITOR_LAYOUT_KEY`].
//! - **custom** — [`MONITOR_COUNT_KEY`] monitors side by side. The frontend
//!   stamps a layout sized like the local primary display; without one, the
//!   backend falls back to `count` copies of its default desktop size.
//!
//! The session is rendered as **one combined surface**: the remote framebuffer
//! is the bounding box of every monitor, and the tab shows either all of it or
//! one monitor's region (the toolbar's viewport selector). A multi-monitor
//! session never follows the tab size — the layout is the size.
//!
//! [`MonitorLayout::normalize`] is the single place untrusted layouts are
//! validated: at most [`MAX_MONITORS`], every monitor within the MS-RDPEDISP
//! size range, exactly one primary at the origin, no overlaps, and the bounding
//! box within the shared frame bound.

use serde::{Deserialize, Serialize};

use super::schema::{Condition, FieldType, SelectOption, SettingsField};
use super::MAX_FRAMEBUFFER_DIMENSION;
use crate::connection::graphical_resolution::{MAX_FIXED_DIMENSION, MIN_FIXED_DIMENSION};

/// Settings key of the monitor-mode select.
pub const MONITORS_KEY: &str = "monitors";
/// Monitor mode: one monitor (default, pre-#3696 behavior).
pub const MONITORS_SINGLE: &str = "single";
/// Monitor mode: one remote monitor per local display.
pub const MONITORS_ALL: &str = "all";
/// Monitor mode: a user-chosen number of side-by-side monitors.
pub const MONITORS_CUSTOM: &str = "custom";
/// Settings key of the custom monitor count.
pub const MONITOR_COUNT_KEY: &str = "monitorCount";
/// Settings key of the concrete layout the frontend stamps at connect time.
/// Not part of the schema: it reflects the local displays, not a preference.
pub const MONITOR_LAYOUT_KEY: &str = "monitorLayout";

/// Most monitors a layout may carry — the MS-RDPBCGR `TS_UD_CS_MONITOR` and
/// MS-RDPEDISP limit.
pub const MAX_MONITORS: usize = 16;
/// Default monitor count pre-filled for the custom mode.
pub const DEFAULT_CUSTOM_MONITOR_COUNT: u8 = 2;
/// Default (and minimum) per-monitor scale factor, in percent.
pub const DEFAULT_MONITOR_SCALE: u32 = 100;
/// Largest per-monitor scale factor, in percent (MS-RDPEDISP).
pub const MAX_MONITOR_SCALE: u32 = 500;
/// Largest accepted monitor origin magnitude. Real desktops are far smaller;
/// this only keeps hostile coordinates out of the layout arithmetic.
const MAX_MONITOR_COORDINATE: i32 = 1 << 20;

/// The user's monitor-mode choice (see the module docs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonitorMode {
    /// One monitor.
    Single,
    /// One remote monitor per local display.
    AllLocal,
    /// `count` side-by-side monitors.
    Custom {
        /// Requested monitor count (2..=[`MAX_MONITORS`]).
        count: u8,
    },
}

impl MonitorMode {
    /// Parse the select value plus the custom count. Anything unknown / empty —
    /// including a connection saved before #3696 — is [`MonitorMode::Single`].
    pub fn from_settings(mode: &str, count: Option<u8>) -> Self {
        match mode.trim().to_ascii_lowercase().as_str() {
            MONITORS_ALL => MonitorMode::AllLocal,
            MONITORS_CUSTOM => MonitorMode::Custom {
                count: count
                    .unwrap_or(DEFAULT_CUSTOM_MONITOR_COUNT)
                    .clamp(2, MAX_MONITORS as u8),
            },
            _ => MonitorMode::Single,
        }
    }

    /// Whether this mode asks for more than one monitor.
    pub fn is_multi(self) -> bool {
        !matches!(self, MonitorMode::Single)
    }
}

/// One monitor of a layout: its rectangle in desktop coordinates, whether it
/// is the primary monitor, and its scale factor in percent.
///
/// In a [`MonitorLayout`] the primary monitor sits at the origin and the others
/// may have negative coordinates (as in MS-RDPBCGR). Rectangles reported to the
/// frontend by [`GraphicalBackend::monitor_layout`](super::GraphicalBackend::monitor_layout)
/// are in **framebuffer** coordinates instead: `(0, 0)` is the top-left of the
/// combined framebuffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct MonitorRect {
    /// Left edge, in pixels.
    pub x: i32,
    /// Top edge, in pixels.
    pub y: i32,
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// Whether this is the primary monitor.
    #[serde(default)]
    pub primary: bool,
    /// Scale factor in percent (100 = unscaled).
    #[serde(default = "default_scale")]
    pub scale: u32,
}

fn default_scale() -> u32 {
    DEFAULT_MONITOR_SCALE
}

impl MonitorRect {
    /// A monitor of `width x height` at `(x, y)`, unscaled and not primary.
    pub fn new(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self {
            x,
            y,
            width,
            height,
            primary: false,
            scale: DEFAULT_MONITOR_SCALE,
        }
    }

    /// This monitor with its size clamped into the MS-RDPEDISP range (width
    /// even), its scale into 100..=500 and its origin into a sane range.
    fn clamped(self) -> Self {
        let min = u32::from(MIN_FIXED_DIMENSION);
        let max = u32::from(MAX_FIXED_DIMENSION);
        Self {
            x: self.x.clamp(-MAX_MONITOR_COORDINATE, MAX_MONITOR_COORDINATE),
            y: self.y.clamp(-MAX_MONITOR_COORDINATE, MAX_MONITOR_COORDINATE),
            width: self.width.clamp(min, max) & !1,
            height: self.height.clamp(min, max),
            primary: self.primary,
            scale: self.scale.clamp(DEFAULT_MONITOR_SCALE, MAX_MONITOR_SCALE),
        }
    }

    fn right(&self) -> i64 {
        i64::from(self.x) + i64::from(self.width)
    }

    fn bottom(&self) -> i64 {
        i64::from(self.y) + i64::from(self.height)
    }

    fn overlaps(&self, other: &MonitorRect) -> bool {
        i64::from(self.x) < other.right()
            && i64::from(other.x) < self.right()
            && i64::from(self.y) < other.bottom()
            && i64::from(other.y) < self.bottom()
    }
}

/// A validated multi-monitor layout (two or more monitors). Construct it only
/// through [`MonitorLayout::normalize`] or [`MonitorLayout::side_by_side`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonitorLayout {
    monitors: Vec<MonitorRect>,
}

/// The bounding box of a set of monitors, in desktop coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LayoutBounds {
    /// Leftmost edge.
    pub x: i32,
    /// Topmost edge.
    pub y: i32,
    /// Total width.
    pub width: u32,
    /// Total height.
    pub height: u32,
}

fn bounds_of(monitors: &[MonitorRect]) -> Option<LayoutBounds> {
    let left = monitors.iter().map(|m| i64::from(m.x)).min()?;
    let top = monitors.iter().map(|m| i64::from(m.y)).min()?;
    let right = monitors.iter().map(MonitorRect::right).max()?;
    let bottom = monitors.iter().map(MonitorRect::bottom).max()?;
    Some(LayoutBounds {
        x: i32::try_from(left).ok()?,
        y: i32::try_from(top).ok()?,
        width: u32::try_from(right - left).ok()?,
        height: u32::try_from(bottom - top).ok()?,
    })
}

fn fits_frame_bound(monitors: &[MonitorRect]) -> bool {
    bounds_of(monitors).is_some_and(|b| {
        b.width <= MAX_FRAMEBUFFER_DIMENSION && b.height <= MAX_FRAMEBUFFER_DIMENSION
    })
}

impl MonitorLayout {
    /// Validate an untrusted layout (see the module docs). Returns `None` when
    /// fewer than two usable monitors remain — the session is then single-monitor.
    ///
    /// - Keeps at most [`MAX_MONITORS`], in the given order.
    /// - Clamps each size to 200..=8192 (width even) and scale to 100..=500.
    /// - Keeps exactly one primary: the first flagged one, else the first.
    /// - Replaces an overlapping arrangement (e.g. mixed-DPI local displays
    ///   converted to logical pixels) by a left-to-right row in the order of the
    ///   monitors' left edges, top-aligned.
    /// - Moves the layout so the primary monitor's top-left is `(0, 0)`
    ///   (required by MS-RDPBCGR and MS-RDPEDISP).
    /// - Drops monitors, last first, until the bounding box fits the shared
    ///   8192 x 8192 frame bound.
    pub fn normalize(rects: &[MonitorRect]) -> Option<Self> {
        let mut monitors: Vec<MonitorRect> = rects
            .iter()
            .take(MAX_MONITORS)
            .map(|m| m.clamped())
            .collect();
        if monitors.len() < 2 {
            return None;
        }
        let primary = monitors.iter().position(|m| m.primary).unwrap_or(0);
        for (i, m) in monitors.iter_mut().enumerate() {
            m.primary = i == primary;
        }

        let overlapping = monitors
            .iter()
            .enumerate()
            .any(|(i, a)| monitors[i + 1..].iter().any(|b| a.overlaps(b)));
        if overlapping {
            let mut order: Vec<usize> = (0..monitors.len()).collect();
            order.sort_by_key(|&i| (monitors[i].x, monitors[i].y));
            let mut cursor: i64 = 0;
            for i in order {
                // Bounded: at most 16 monitors of at most 8192 px each.
                monitors[i].x = i32::try_from(cursor).unwrap_or(i32::MAX);
                monitors[i].y = 0;
                cursor += i64::from(monitors[i].width);
            }
        }

        // Keep the primary, then every other monitor whose addition still fits
        // the frame bound (so a too-large layout loses its trailing monitors).
        let mut kept = vec![monitors[primary]];
        let mut kept_index = vec![primary];
        for (i, m) in monitors.iter().enumerate() {
            if i == primary {
                continue;
            }
            kept.push(*m);
            if fits_frame_bound(&kept) {
                kept_index.push(i);
            } else {
                kept.pop();
            }
        }
        if kept.len() < 2 {
            return None;
        }
        // Restore the caller's order (it defines the "Monitor N" labels).
        let mut ordered: Vec<(usize, MonitorRect)> = kept_index.into_iter().zip(kept).collect();
        ordered.sort_by_key(|(i, _)| *i);
        let mut monitors: Vec<MonitorRect> = ordered.into_iter().map(|(_, m)| m).collect();

        let origin = *monitors.iter().find(|m| m.primary)?;
        for m in &mut monitors {
            m.x -= origin.x;
            m.y -= origin.y;
        }
        Some(Self { monitors })
    }

    /// `count` monitors of `width x height` in one left-to-right row, the first
    /// primary. `None` when `count < 2`.
    pub fn side_by_side(count: u8, width: u16, height: u16) -> Option<Self> {
        let count = usize::from(count).min(MAX_MONITORS);
        let rects: Vec<MonitorRect> = (0..count)
            .map(|i| {
                let mut m = MonitorRect::new(
                    i32::try_from(i).unwrap_or(0) * i32::from(width),
                    0,
                    u32::from(width),
                    u32::from(height),
                );
                m.primary = i == 0;
                m
            })
            .collect();
        Self::normalize(&rects)
    }

    /// The monitors, in desktop coordinates (primary at the origin).
    pub fn monitors(&self) -> &[MonitorRect] {
        &self.monitors
    }

    /// The bounding box of every monitor, in desktop coordinates.
    pub fn bounds(&self) -> LayoutBounds {
        // Invariant: at least two monitors, bounding box within 8192.
        bounds_of(&self.monitors).unwrap_or(LayoutBounds {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        })
    }

    /// The combined desktop size — the remote framebuffer size.
    pub fn desktop_size(&self) -> (u16, u16) {
        let b = self.bounds();
        (
            u16::try_from(b.width).unwrap_or(MAX_FIXED_DIMENSION),
            u16::try_from(b.height).unwrap_or(MAX_FIXED_DIMENSION),
        )
    }

    /// The monitors in **framebuffer** coordinates: moved so the bounding box's
    /// top-left is `(0, 0)`. This is what the frontend's viewport selector uses.
    pub fn framebuffer_rects(&self) -> Vec<MonitorRect> {
        let b = self.bounds();
        self.monitors
            .iter()
            .map(|m| MonitorRect {
                x: m.x - b.x,
                y: m.y - b.y,
                ..*m
            })
            .collect()
    }
}

/// Parse a raw [`MONITOR_LAYOUT_KEY`] value leniently: every well-formed
/// monitor object is kept, anything else (wrong types, non-array) is ignored.
pub fn parse_monitor_rects(value: &serde_json::Value) -> Vec<MonitorRect> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .take(MAX_MONITORS)
                .filter_map(|item| serde_json::from_value(item.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// A `serde(deserialize_with)` helper for a config's monitor-layout field: a
/// malformed layout degrades to "no layout" instead of failing the connect.
pub fn deserialize_monitor_rects<'de, D>(deserializer: D) -> Result<Vec<MonitorRect>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(parse_monitor_rects(&value))
}

/// A `serde(deserialize_with)` helper for a config's custom monitor count:
/// accepts an integer, an integral float or a numeric string (form values),
/// and degrades anything else to "unset" instead of failing the connect.
pub fn deserialize_monitor_count<'de, D>(deserializer: D) -> Result<Option<u8>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    let number = match &value {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    Ok(number
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(|n| n.min(f64::from(u8::MAX)) as u8))
}

/// Resolve the multi-monitor layout a connection asks for, or `None` for a
/// single-monitor session.
///
/// A stamped `layout` wins; otherwise the custom mode lays out `count` monitors
/// of `per_monitor` size side by side. The all-displays mode without a stamped
/// layout (no local display information) stays single-monitor.
pub fn resolve_monitor_layout(
    mode: MonitorMode,
    layout: &[MonitorRect],
    per_monitor: (u16, u16),
) -> Option<MonitorLayout> {
    match mode {
        MonitorMode::Single => None,
        MonitorMode::AllLocal => MonitorLayout::normalize(layout),
        MonitorMode::Custom { count } => MonitorLayout::normalize(layout)
            .or_else(|| MonitorLayout::side_by_side(count, per_monitor.0, per_monitor.1)),
    }
}

/// Whether raw connection `settings` ask for more than one monitor.
///
/// Protocol-agnostic: the desktop's graphical session manager uses it to stop
/// forwarding tab-size resizes to a multi-monitor session (its layout, not the
/// tab, defines the remote size).
pub fn multi_monitor_requested(settings: &serde_json::Value) -> bool {
    let mode = settings
        .get(MONITORS_KEY)
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    MonitorMode::from_settings(mode, None).is_multi()
}

/// The multi-monitor capability a graphical backend advertises.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiMonitorCapability {
    /// Whether the backend can open (or expose) a multi-monitor session.
    pub supported: bool,
    /// Most monitors the backend can request (0 when unsupported).
    pub max_monitors: u32,
}

impl MultiMonitorCapability {
    /// No multi-monitor support.
    pub const fn unsupported() -> Self {
        Self {
            supported: false,
            max_monitors: 0,
        }
    }

    /// Up to [`MAX_MONITORS`] monitors.
    pub const fn supported() -> Self {
        Self {
            supported: true,
            max_monitors: MAX_MONITORS as u32,
        }
    }
}

/// The **Monitors** rows a multi-monitor-capable backend appends to its
/// **Display** group: the mode select plus the custom count (shown only for
/// the custom mode).
pub fn monitor_fields() -> Vec<SettingsField> {
    let option = |value: &str, label: &str| SelectOption {
        value: value.to_string(),
        label: label.to_string(),
    };
    vec![
        SettingsField {
            key: MONITORS_KEY.to_string(),
            label: "Monitors".to_string(),
            description: Some(
                "Single uses one monitor. All local displays gives the remote one monitor per \
                 display of this computer; Custom sets how many side-by-side monitors to use. \
                 A multi-monitor session keeps its layout size (it does not follow the tab); \
                 the toolbar switches between all monitors and one monitor. Servers without \
                 multi-monitor support show one monitor spanning the layout."
                    .to_string(),
            ),
            help_text: None,
            field_type: FieldType::Select {
                options: vec![
                    option(MONITORS_SINGLE, "Single"),
                    option(MONITORS_ALL, "All local displays"),
                    option(MONITORS_CUSTOM, "Custom count"),
                ],
            },
            required: false,
            default: Some(serde_json::json!(MONITORS_SINGLE)),
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        },
        SettingsField {
            key: MONITOR_COUNT_KEY.to_string(),
            label: "Monitor Count".to_string(),
            description: Some(format!(
                "Number of side-by-side monitors, 2–{MAX_MONITORS}, each the size of this \
                 computer's primary display."
            )),
            help_text: None,
            field_type: FieldType::Number {
                min: Some(2.0),
                max: Some(MAX_MONITORS as f64),
            },
            required: false,
            default: Some(serde_json::json!(DEFAULT_CUSTOM_MONITOR_COUNT)),
            placeholder: Some(DEFAULT_CUSTOM_MONITOR_COUNT.to_string()),
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: Some(Condition {
                field: MONITORS_KEY.to_string(),
                equals: serde_json::json!(MONITORS_CUSTOM),
            }),
        },
    ]
}

#[cfg(test)]
#[path = "graphical_monitors_tests.rs"]
mod tests;
