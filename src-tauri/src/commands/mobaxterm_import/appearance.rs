//! Per-session terminal appearance, session logging and scrollback from
//! MobaXterm's terminal-settings block (#4854, #4881).
//!
//! The fourth `#` block of a session line is a `%`-separated list of terminal
//! settings. MobaXterm does not document it; the positions below follow the
//! open-source Sessionator generator (`src/Formats/MobaXterm/TerminalSettings.php`
//! and its `Settings.md`), which reads and writes this block:
//!
//! | Index | Setting | termiHub |
//! |-------|---------|----------|
//! | 0 | font family (`MobaFont` = built-in, default) | `fontFamily`, unless default |
//! | 1 | font size in points (default 10) | `fontSize` in pixels, unless default |
//! | 5 | character set (`15` = UTF-8) | note when not UTF-8 |
//! | 6 / 7 / 8 | foreground / background / cursor `R,G,B` | note when not the defaults |
//! | 9 | cursor type (0–5, default 0) | `cursorStyle` + `cursorBlink`, unless default |
//! | 11 | log terminal output (`-1` = enabled, default `0`) | `logToFile` when enabled |
//! | 12 | log folder (empty = MobaXterm's default, `<>` = its program folder) | note when set |
//! | 13 | terminal type (`xterm`, `vt100`, …) | Telnet `terminalType`; note otherwise |
//! | 16 | colour scheme (`_Std_Colors_0_` = global theme) | note when custom |
//! | 17 / 18 / 19 | fixed columns / rows / enabled (`-1`) | note when enabled |
//! | 28 | expert settings, a `,` list; entry 11 = scrollback lines (empty = 360 000) | `scrollbackBuffer`, unless default |
//!
//! Best-effort, not verified against MobaXterm itself:
//! - The font size is treated as typographic points (MobaXterm is a Windows
//!   app) and converted at 96 DPI (`px = pt × 4/3`); termiHub sizes are pixels.
//! - Sessionator names indices 17/18 "rows"/"columns" but defaults them to
//!   80/24, so they are read here as columns × rows.
//! - A custom colour scheme expands index 16 into sixteen fields and shifts
//!   every later index by fifteen; indices after 16 are read through
//!   `shifted`. Sessionator documents the expansion but does not decode it,
//!   so a custom scheme is recognised by index 16 not being the
//!   `_Std_Colors_0_` marker.
//! - The scrollback entry position inside the expert-settings list
//!   (`terminalScrollbackLines`, entry 11) comes from Sessionator's writer;
//!   Sessionator does not read that list back.
//! - Session logging is mapped to termiHub's own "Log Session Output" option,
//!   which writes to termiHub's log folder, never to the MobaXterm folder: a
//!   path from another machine must not make termiHub write files elsewhere.
//!
//! Settings left at MobaXterm's factory defaults (`MobaFont`, 10 pt, a
//! non-blinking block cursor) are not written as per-connection overrides, so
//! such a session keeps following termiHub's global appearance settings; and
//! they produce no note, so the preview is not filled with noise.

use crate::connection::config::TerminalOptions;

use super::parser::decode_escapes;

/// MobaXterm session types whose terminal block is real: SSH, Telnet,
/// Serial, Shell and WSL. Other types carry a truncated stub.
pub fn has_terminal_block(code: u32) -> bool {
    matches!(code, 0 | 1 | 8 | 10 | 14)
}

/// termiHub's per-connection font-size range (Settings → Appearance).
const FONT_SIZE_PX: std::ops::RangeInclusive<u32> = 8..=32;

/// MobaXterm's default font size (points) and cursor type (non-blinking
/// block). A session at these values gets no per-connection override, so it
/// keeps following termiHub's global appearance settings.
const DEFAULT_FONT_SIZE_PT: &str = "10";
const DEFAULT_CURSOR: &str = "0";

/// termiHub's per-connection scrollback range (lines).
const SCROLLBACK_LINES: std::ops::RangeInclusive<u32> = 100..=1_000_000;

/// MobaXterm's scrollback when the expert-settings entry is empty.
const DEFAULT_SCROLLBACK_LINES: u64 = 360_000;

/// Index of the colour scheme, and the expert-settings list (before any
/// colour-scheme shift).
const COLOR_SCHEME_IDX: usize = 16;
const EXPERT_SETTINGS_IDX: usize = 28;

/// Entry of the scrollback line count in the expert-settings list.
const EXPERT_SCROLLBACK_ENTRY: usize = 11;

/// Extra fields a custom colour scheme inserts: index 16 becomes sixteen.
const CUSTOM_SCHEME_EXTRA_FIELDS: usize = 15;

/// Default foreground / background / cursor colours of MobaXterm's
/// "Dark background / Light text" preset.
const DEFAULT_COLORS: [&str; 3] = ["236,236,236", "30,30,30", "180,180,192"];

/// Terminal types that are real terminfo names and can be sent as-is in a
/// Telnet TERMINAL-TYPE negotiation. MobaXterm's other choices (`vt100+`,
/// `SCO`, `ESC[n~`, `Byobu`, …) are keyboard modes, not terminfo entries.
const TERMINFO_NAMES: [&str; 6] = [
    "xterm",
    "xterm-256color",
    "xterm-r6",
    "vt100",
    "vt220",
    "vt400",
];

/// What the terminal block contributes to one imported connection.
#[derive(Debug, Clone, Default)]
pub struct Appearance {
    /// Per-connection terminal options; `None` when nothing was mappable.
    pub options: Option<TerminalOptions>,
    /// The Telnet `terminalType` setting, when the connection is Telnet.
    pub terminal_type: Option<String>,
    /// Settings that were not carried over.
    pub notes: Vec<String>,
}

/// Field `idx` of the block, escape-decoded and trimmed; `None` when empty.
fn field(block: &[String], idx: usize) -> Option<String> {
    let value = decode_escapes(block.get(idx)?.trim());
    (!value.is_empty()).then_some(value)
}

/// Whether index 16 holds a custom colour scheme (sixteen fields) instead of
/// the `_Std_Colors_0_` "global theme" marker.
fn has_custom_scheme(block: &[String]) -> bool {
    field(block, COLOR_SCHEME_IDX).is_some_and(|s| !s.starts_with("_Std_Colors_0_"))
}

/// The real position of Sessionator index `idx` in this block: indices after
/// the colour scheme move by fifteen when the scheme is custom.
fn shifted(block: &[String], idx: usize) -> usize {
    if idx > COLOR_SCHEME_IDX && has_custom_scheme(block) {
        idx + CUSTOM_SCHEME_EXTRA_FIELDS
    } else {
        idx
    }
}

/// `Consolas` → `"Consolas", monospace`, so a font that is not installed here
/// falls back to a monospace face instead of a proportional one.
fn css_font_family(name: &str) -> String {
    let escaped = name.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\", monospace")
}

/// MobaXterm character-set codes Sessionator names; the rest are shown as
/// their number.
fn charset_label(code: &str) -> String {
    match code {
        "0" => "ISO-8859-1".to_string(),
        "1" => "ISO-8859-15".to_string(),
        "22" => "CP850".to_string(),
        other => format!("code {other}"),
    }
}

/// Map the terminal block of a session of type `code` that is being imported
/// as `connection_type`.
pub fn map_appearance(block: &[String], code: u32, connection_type: &str) -> Appearance {
    let mut out = Appearance::default();
    if !has_terminal_block(code) || block.is_empty() {
        return out;
    }
    out.options = mapped_options(block, &mut out.notes);
    terminal_type_mapping(block, connection_type, &mut out);
    unmapped_notes(block, &mut out.notes);
    out
}

/// Font family, font size, cursor, session logging and scrollback (indices 0,
/// 1, 9, 11, 28) that differ from MobaXterm's defaults; `None` when none does.
/// Unreadable values add a note.
fn mapped_options(block: &[String], notes: &mut Vec<String>) -> Option<TerminalOptions> {
    let mut opts = TerminalOptions::default();

    if let Some(font) = field(block, 0).filter(|f| !f.eq_ignore_ascii_case("MobaFont")) {
        opts.font_family = Some(css_font_family(&font));
    }

    if let Some(raw) = field(block, 1).filter(|v| v != DEFAULT_FONT_SIZE_PT) {
        match raw.parse::<f64>() {
            Ok(pt) if pt > 0.0 && pt < 1000.0 => {
                let px = (pt * 4.0 / 3.0).round() as u32;
                let clamped = px.clamp(*FONT_SIZE_PX.start(), *FONT_SIZE_PX.end());
                if clamped != px {
                    notes.push(format!(
                        "Font size {raw} pt is outside termiHub's range; using {clamped} px."
                    ));
                }
                opts.font_size = Some(clamped);
            }
            _ => notes.push(format!(
                "The font size \"{raw}\" could not be read; termiHub's default is used."
            )),
        }
    }

    if let Some(cursor) = field(block, 9).filter(|v| v != DEFAULT_CURSOR) {
        match cursor_style(&cursor) {
            Some((style, blink)) => {
                opts.cursor_style = Some(style.to_string());
                opts.cursor_blink = Some(blink);
            }
            None => notes.push(format!(
                "Unknown cursor type {cursor}; termiHub's default cursor is used."
            )),
        }
    }

    if field(block, 11).as_deref() == Some("-1") {
        opts.log_to_file = Some(true);
        if let Some(folder) = field(block, 12) {
            let folder = if folder == "<>" {
                "MobaXterm's program folder".to_string()
            } else {
                format!("\"{folder}\"")
            };
            notes.push(format!(
                "Session logging is kept, but not the MobaXterm log folder ({folder}): \
                 termiHub writes session logs to its own log folder."
            ));
        }
    }

    opts.scrollback_buffer = scrollback_lines(block, notes);

    let any = opts.font_family.is_some()
        || opts.font_size.is_some()
        || opts.cursor_style.is_some()
        || opts.log_to_file.is_some()
        || opts.scrollback_buffer.is_some();
    any.then_some(opts)
}

/// Scrollback line count from the expert-settings list (index 28, entry 11),
/// clamped to termiHub's range. `None` when absent, empty or MobaXterm's
/// 360 000 default, so the connection keeps termiHub's global scrollback.
fn scrollback_lines(block: &[String], notes: &mut Vec<String>) -> Option<u32> {
    let expert = block.get(shifted(block, EXPERT_SETTINGS_IDX))?;
    let raw = decode_escapes(expert.split(',').nth(EXPERT_SCROLLBACK_ENTRY)?.trim());
    if raw.is_empty() {
        return None;
    }
    match raw.parse::<u64>() {
        Ok(DEFAULT_SCROLLBACK_LINES) => None,
        Ok(lines) => {
            let (min, max) = (*SCROLLBACK_LINES.start(), *SCROLLBACK_LINES.end());
            let clamped = lines.clamp(u64::from(min), u64::from(max)) as u32;
            if u64::from(clamped) != lines {
                notes.push(format!(
                    "Scrollback of {lines} lines is outside termiHub's range; using {clamped}."
                ));
            }
            Some(clamped)
        }
        Err(_) => {
            notes.push(format!(
                "The scrollback size \"{raw}\" could not be read; termiHub's default is used."
            ));
            None
        }
    }
}

/// MobaXterm cursor type → (xterm.js cursor style, blink).
fn cursor_style(code: &str) -> Option<(&'static str, bool)> {
    match code {
        "0" => Some(("block", false)),
        "1" => Some(("underline", false)),
        "2" => Some(("bar", false)),
        "3" => Some(("block", true)),
        "4" => Some(("underline", true)),
        "5" => Some(("bar", true)),
        _ => None,
    }
}

/// Notes for non-default settings termiHub has no per-connection counterpart
/// for: character set, colours, fixed terminal size.
fn unmapped_notes(block: &[String], notes: &mut Vec<String>) {
    if let Some(charset) = field(block, 5).filter(|c| c != "15") {
        notes.push(format!(
            "The character set ({}) was not imported: termiHub terminals always use UTF-8.",
            charset_label(&charset)
        ));
    }

    let custom_scheme = has_custom_scheme(block);
    let custom_rgb = DEFAULT_COLORS
        .iter()
        .enumerate()
        .any(|(i, default)| field(block, 6 + i).is_some_and(|v| v.replace(' ', "") != *default));
    if custom_scheme || custom_rgb {
        notes.push(
            "The session's own colours were not imported: termiHub connections take their \
             colours from the theme (Settings → Appearance)."
                .to_string(),
        );
    }

    if field(block, shifted(block, 19)).as_deref() == Some("-1") {
        let size = match (
            field(block, shifted(block, 17)),
            field(block, shifted(block, 18)),
        ) {
            (Some(cols), Some(rows)) => format!(" ({cols}×{rows})"),
            _ => String::new(),
        };
        notes.push(format!(
            "The fixed terminal size{size} was not imported: termiHub terminals follow the \
             window size."
        ));
    }
}

/// Terminal type (index 13): Telnet negotiates it, so a terminfo name maps to
/// the Telnet `terminalType` setting. SSH and local shells always use
/// `xterm-256color`, which covers MobaXterm's default `xterm`; any other type
/// is noted. Serial has no terminal-type concept.
fn terminal_type_mapping(block: &[String], connection_type: &str, out: &mut Appearance) {
    let Some(term) = field(block, 13) else {
        return;
    };
    let is_terminfo = TERMINFO_NAMES.contains(&term.as_str());
    match connection_type {
        "telnet" if is_terminfo => out.terminal_type = Some(term),
        "telnet" => out.notes.push(format!(
            "Terminal type \"{term}\" is a MobaXterm keyboard mode, not a terminal name; \
             termiHub's default (xterm-256color) is used."
        )),
        "serial" => {}
        _ if term == "xterm" || term == "xterm-256color" => {}
        _ => out.notes.push(format!(
            "Terminal type \"{term}\" was not imported: termiHub always uses xterm-256color \
             for this connection type."
        )),
    }
}
