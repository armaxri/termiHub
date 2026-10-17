//! MobaXterm's global `[Colors]`, `[Font]` and `[Cursor]` sections (#4880).
//!
//! MobaXterm does not document these sections. The layout below is taken from
//! public sources and is consistent across all of them:
//!
//! - `[Colors]`: the MobaXterm export template of iTerm2-Color-Schemes
//!   (`tools/templates/mobaxterm.ini`, published themes in `mobaxterm/*.ini`),
//!   which tells users to paste its `[Colors]` block into `MobaXterm.ini`.
//! - `[Font]` and `[Cursor]`: `MobaXterm.ini` files published in public
//!   repositories (dotfiles, Puppet templates, installer data), which all carry
//!   the same keys.
//!
//! ```text
//! [Colors]
//! DefaultColorScheme=0        <- preset index (ignored; the RGB keys win)
//! ForegroundColour=236,236,236
//! BackgroundColour=30,30,30
//! CursorColour=180,180,192
//! Black=0,0,0  BoldBlack=…    <- 16 ANSI colours, "Bold*" = bright
//! Red=…  Green=…  Yellow=…  Blue=…  Magenta=…  Cyan=…  White=…
//! [Font]
//! Font2=MobaFont              <- family; `MobaFont` = MobaXterm's built-in font
//! FontHeight2=10              <- size in points
//! FontIsBold2=0
//! Charset2=UTF-8
//! [Cursor]
//! CursorType=0
//! CursorBlinks=0
//! ```
//!
//! Best-effort, not verified against MobaXterm itself:
//! - `FontHeight2` is read as typographic points and converted at 96 DPI
//!   (`px = pt × 4/3`), as for the per-session font size.
//! - `CursorType` values 0/1/2 are read as block / underline / vertical bar,
//!   the order of the per-session cursor codes; every public sample uses `0`.
//!   Any other value is reported, not applied.
//!
//! Nothing here is applied by the backend: the preview carries the parsed
//! values and the frontend applies them only on the user's explicit opt-in.

use serde::Serialize;

use crate::connection::settings::CursorStyle;

/// termiHub's global font-size range (Settings → Appearance), in pixels.
const FONT_SIZE_PX: std::ops::RangeInclusive<u32> = 8..=32;

/// The sixteen ANSI colour keys of `[Colors]`, in termiHub's palette order
/// (normal black … white, then bright black … white).
const ANSI_KEYS: [&str; 16] = [
    "Black",
    "Red",
    "Green",
    "Yellow",
    "Blue",
    "Magenta",
    "Cyan",
    "White",
    "BoldBlack",
    "BoldRed",
    "BoldGreen",
    "BoldYellow",
    "BoldBlue",
    "BoldMagenta",
    "BoldCyan",
    "BoldWhite",
];

/// The terminal colours of MobaXterm's `[Colors]` section, as `#rrggbb`.
/// Every field is optional: a colour that is absent or unreadable keeps the
/// base theme's value.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct MobaxtermThemeColors {
    /// Terminal text colour (`ForegroundColour`).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub foreground: Option<String>,
    /// Terminal background colour (`BackgroundColour`).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub background: Option<String>,
    /// Cursor colour (`CursorColour`).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub cursor: Option<String>,
    /// The 16 ANSI colours: black, red, green, yellow, blue, magenta, cyan,
    /// white, then their bright variants. `null` where absent or unreadable.
    pub ansi: Vec<Option<String>>,
}

impl MobaxtermThemeColors {
    fn is_empty(&self) -> bool {
        self.foreground.is_none()
            && self.background.is_none()
            && self.cursor.is_none()
            && self.ansi.iter().all(Option::is_none)
    }
}

/// MobaXterm's global appearance defaults, parsed but not applied. The import
/// dialog offers each part behind its own opt-in.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct MobaxtermGlobalAppearance {
    /// Terminal colours from `[Colors]`; absent when none could be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub colors: Option<MobaxtermThemeColors>,
    /// CSS font family from `[Font]`; absent for MobaXterm's built-in font.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub font_family: Option<String>,
    /// Font size in pixels (converted from points, limited to 8–32).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub font_size: Option<u32>,
    /// Cursor shape from `[Cursor]`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub cursor_style: Option<CursorStyle>,
    /// Whether the cursor blinks, from `[Cursor]`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub cursor_blink: Option<bool>,
}

impl MobaxtermGlobalAppearance {
    /// Whether anything is offered for import.
    pub fn has_values(&self) -> bool {
        self.colors.is_some()
            || self.font_family.is_some()
            || self.font_size.is_some()
            || self.cursor_style.is_some()
            || self.cursor_blink.is_some()
    }
}

/// The `key=value` pairs of every section named `name` (case-insensitive), in
/// file order. Values are trimmed; keys keep their case.
fn section<'a>(text: &'a str, name: &str) -> Vec<(&'a str, &'a str)> {
    let mut pairs = Vec::new();
    let mut inside = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(header) = trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            inside = header.trim().eq_ignore_ascii_case(name);
            continue;
        }
        if !inside {
            continue;
        }
        if let Some((key, value)) = trimmed.split_once('=') {
            let key = key.trim();
            if !key.is_empty() {
                pairs.push((key, value.trim()));
            }
        }
    }
    pairs
}

/// The last value of `key` (case-insensitive), `None` when absent or empty.
fn value<'a>(pairs: &[(&'a str, &'a str)], key: &str) -> Option<&'a str> {
    pairs
        .iter()
        .rev()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| *v)
        .filter(|v| !v.is_empty())
}

/// `236,236,236` → `#ececec`; `None` unless exactly three 0–255 components.
fn rgb_to_hex(raw: &str) -> Option<String> {
    let parts: Vec<u8> = raw
        .split(',')
        .map(|p| p.trim().parse::<u8>())
        .collect::<Result<_, _>>()
        .ok()?;
    match parts.as_slice() {
        [r, g, b] => Some(format!("#{r:02x}{g:02x}{b:02x}")),
        _ => None,
    }
}

/// Parse `[Colors]`; unreadable values are listed in `notes`.
fn parse_colors(text: &str, notes: &mut Vec<String>) -> Option<MobaxtermThemeColors> {
    let pairs = section(text, "Colors");
    if pairs.is_empty() {
        return None;
    }
    let mut bad = Vec::new();
    let mut read = |key: &str| {
        let raw = value(&pairs, key)?;
        let hex = rgb_to_hex(raw);
        if hex.is_none() {
            bad.push(key.to_string());
        }
        hex
    };
    let colors = MobaxtermThemeColors {
        foreground: read("ForegroundColour"),
        background: read("BackgroundColour"),
        cursor: read("CursorColour"),
        ansi: ANSI_KEYS.iter().map(|k| read(k)).collect(),
    };
    if !bad.is_empty() {
        notes.push(format!(
            "These MobaXterm colours could not be read and keep the base theme's value: {}.",
            bad.join(", ")
        ));
    }
    (!colors.is_empty()).then_some(colors)
}

/// `Consolas` → `"Consolas", monospace` (same rule as per-session fonts).
fn css_font_family(name: &str) -> String {
    let escaped = name.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\", monospace")
}

/// Parse `[Font]` into `out`; values not carried over are listed in `notes`.
fn parse_font(text: &str, out: &mut MobaxtermGlobalAppearance, notes: &mut Vec<String>) {
    let pairs = section(text, "Font");
    if pairs.is_empty() {
        return;
    }
    if let Some(font) = value(&pairs, "Font2").filter(|f| !f.eq_ignore_ascii_case("MobaFont")) {
        out.font_family = Some(css_font_family(font));
    }
    if let Some(raw) = value(&pairs, "FontHeight2") {
        match raw.parse::<f64>() {
            Ok(pt) if pt > 0.0 && pt < 1000.0 => {
                let px = (pt * 4.0 / 3.0).round() as u32;
                let clamped = px.clamp(*FONT_SIZE_PX.start(), *FONT_SIZE_PX.end());
                if clamped != px {
                    notes.push(format!(
                        "MobaXterm's font size {raw} pt is outside termiHub's range; \
                         {clamped} px is offered instead."
                    ));
                }
                out.font_size = Some(clamped);
            }
            _ => notes.push(format!(
                "MobaXterm's font size \"{raw}\" could not be read and is not offered."
            )),
        }
    }
    if value(&pairs, "FontIsBold2") == Some("1") {
        notes.push(
            "MobaXterm's bold terminal font is not imported: termiHub has no global bold setting."
                .to_string(),
        );
    }
    if let Some(charset) = value(&pairs, "Charset2").filter(|c| !c.eq_ignore_ascii_case("UTF-8")) {
        notes.push(format!(
            "MobaXterm's character set ({charset}) is not imported: termiHub terminals always \
             use UTF-8."
        ));
    }
}

/// Parse `[Cursor]` into `out`; an unknown cursor type is listed in `notes`.
fn parse_cursor(text: &str, out: &mut MobaxtermGlobalAppearance, notes: &mut Vec<String>) {
    let pairs = section(text, "Cursor");
    if pairs.is_empty() {
        return;
    }
    if let Some(raw) = value(&pairs, "CursorType") {
        match raw {
            "0" => out.cursor_style = Some(CursorStyle::Block),
            "1" => out.cursor_style = Some(CursorStyle::Underline),
            "2" => out.cursor_style = Some(CursorStyle::Bar),
            other => notes.push(format!(
                "MobaXterm's cursor type {other} is not known and is not offered."
            )),
        }
    }
    match value(&pairs, "CursorBlinks") {
        Some("1") | Some("-1") => out.cursor_blink = Some(true),
        Some("0") => out.cursor_blink = Some(false),
        _ => {}
    }
}

/// Parse MobaXterm's global appearance sections. Values that were found but
/// cannot be offered are added to `notes`; `None` when nothing is offered.
pub fn parse_global_appearance(
    text: &str,
    notes: &mut Vec<String>,
) -> Option<MobaxtermGlobalAppearance> {
    let mut out = MobaxtermGlobalAppearance {
        colors: parse_colors(text, notes),
        ..Default::default()
    };
    parse_font(text, &mut out, notes);
    parse_cursor(text, &mut out, notes);
    out.has_values().then_some(out)
}
