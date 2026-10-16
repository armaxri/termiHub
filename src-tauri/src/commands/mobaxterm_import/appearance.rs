//! Per-session terminal appearance from MobaXterm's terminal-settings block
//! (#4854).
//!
//! The fourth `#` block of a session line is a `%`-separated list of terminal
//! settings. MobaXterm does not document it; the positions below follow the
//! open-source Sessionator generator (`src/Formats/MobaXterm/TerminalSettings.php`
//! and its `Settings.md`), which reads and writes this block:
//!
//! | Index | Setting | termiHub |
//! |-------|---------|----------|
//! | 0 | font family (`MobaFont` = built-in) | `fontFamily`, unless `MobaFont` |
//! | 1 | font size in points | `fontSize`, converted to pixels |
//! | 5 | character set (`15` = UTF-8) | note when not UTF-8 |
//! | 6 / 7 / 8 | foreground / background / cursor `R,G,B` | note when not the defaults |
//! | 9 | cursor type (0–5) | `cursorStyle` + `cursorBlink` |
//! | 13 | terminal type (`xterm`, `vt100`, …) | Telnet `terminalType`; note otherwise |
//! | 16 | colour scheme (`_Std_Colors_0_` = global theme) | note when custom |
//! | 17 / 18 / 19 | fixed columns / rows / enabled (`-1`) | note when enabled |
//!
//! Best-effort, not verified against MobaXterm itself:
//! - The font size is treated as typographic points (MobaXterm is a Windows
//!   app) and converted at 96 DPI (`px = pt × 4/3`); termiHub sizes are pixels.
//! - Sessionator names indices 17/18 "rows"/"columns" but defaults them to
//!   80/24, so they are read here as columns × rows.
//! - Only indices before 16 are mapped: a custom colour scheme expands index
//!   16 into sixteen fields and shifts everything after it.
//!
//! Settings left at MobaXterm's factory defaults produce no note, so a session
//! nobody customised does not fill the preview with noise.

use crate::connection::config::TerminalOptions;

use super::parser::decode_escapes;

/// MobaXterm session types whose terminal block is real: SSH, Telnet,
/// Serial, Shell and WSL. Other types carry a truncated stub.
pub fn has_terminal_block(code: u32) -> bool {
    matches!(code, 0 | 1 | 8 | 10 | 14)
}

/// termiHub's per-connection font-size range (Settings → Appearance).
const FONT_SIZE_PX: std::ops::RangeInclusive<u32> = 8..=32;

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
    let mut opts = TerminalOptions::default();
    let mut any = false;

    if let Some(font) = field(block, 0).filter(|f| !f.eq_ignore_ascii_case("MobaFont")) {
        opts.font_family = Some(css_font_family(&font));
        any = true;
    }

    if let Some(raw) = field(block, 1) {
        match raw.parse::<f64>() {
            Ok(pt) if pt > 0.0 && pt < 1000.0 => {
                let px = (pt * 4.0 / 3.0).round() as u32;
                let clamped = px.clamp(*FONT_SIZE_PX.start(), *FONT_SIZE_PX.end());
                if clamped != px {
                    out.notes.push(format!(
                        "Font size {raw} pt is outside termiHub's range; using {clamped} px."
                    ));
                }
                opts.font_size = Some(clamped);
                any = true;
            }
            _ => out.notes.push(format!(
                "The font size \"{raw}\" could not be read; termiHub's default is used."
            )),
        }
    }

    if let Some(cursor) = field(block, 9) {
        let mapped = match cursor.as_str() {
            "0" => Some(("block", false)),
            "1" => Some(("underline", false)),
            "2" => Some(("bar", false)),
            "3" => Some(("block", true)),
            "4" => Some(("underline", true)),
            "5" => Some(("bar", true)),
            _ => None,
        };
        match mapped {
            Some((style, blink)) => {
                opts.cursor_style = Some(style.to_string());
                opts.cursor_blink = Some(blink);
                any = true;
            }
            None => out.notes.push(format!(
                "Unknown cursor type {cursor}; termiHub's default cursor is used."
            )),
        }
    }

    terminal_type_mapping(block, connection_type, &mut out);

    if let Some(charset) = field(block, 5).filter(|c| c != "15") {
        out.notes.push(format!(
            "The character set ({}) was not imported: termiHub terminals always use UTF-8.",
            charset_label(&charset)
        ));
    }

    let custom_scheme = field(block, 16).is_some_and(|s| !s.starts_with("_Std_Colors_0_"));
    let custom_rgb = DEFAULT_COLORS
        .iter()
        .enumerate()
        .any(|(i, default)| field(block, 6 + i).is_some_and(|v| v.replace(' ', "") != *default));
    if custom_scheme || custom_rgb {
        out.notes.push(
            "The session's own colours were not imported: termiHub connections take their \
             colours from the theme (Settings → Appearance)."
                .to_string(),
        );
    }

    if field(block, 19).as_deref() == Some("-1") {
        let size = match (field(block, 17), field(block, 18)) {
            (Some(cols), Some(rows)) => format!(" ({cols}×{rows})"),
            _ => String::new(),
        };
        out.notes.push(format!(
            "The fixed terminal size{size} was not imported: termiHub terminals follow the \
             window size."
        ));
    }

    if any {
        out.options = Some(opts);
    }
    out
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

/// Global MobaXterm sections that hold appearance defaults, as found in the
/// file. Their key layout is undocumented, so they are reported, not mapped.
pub fn global_appearance_sections(text: &str) -> Vec<&'static str> {
    const SECTIONS: [&str; 3] = ["Font", "Colors", "Cursor"];
    let mut found = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        let Some(name) = trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')) else {
            continue;
        };
        if let Some(section) = SECTIONS
            .iter()
            .find(|s| s.eq_ignore_ascii_case(name.trim()))
        {
            if !found.contains(section) {
                found.push(*section);
            }
        }
    }
    found
}

/// The preview note for the global appearance sections, if any are present.
pub fn global_appearance_note(text: &str) -> Option<String> {
    let found = global_appearance_sections(text);
    if found.is_empty() {
        return None;
    }
    let list = found
        .iter()
        .map(|s| format!("[{s}]"))
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!(
        "MobaXterm's global appearance settings ({list}) were not imported; set termiHub's \
         font, colours and cursor under Settings → Appearance."
    ))
}
