//! Low-level reader for MobaXterm's bookmark format (#4850).
//!
//! `MobaXterm.ini` and `.mxtsessions` exports are INI-shaped, but their values
//! are not INI values in any useful sense: a session line packs `#`- and
//! `%`-separated fields, routinely contains `;` and `\`, and spells its own
//! delimiters out as `__DIEZE__`-style tokens. Generic INI crates (`rust-ini`,
//! `configparser`) treat `;`/`#` as comment starters and `\` as an escape, so
//! they mangle exactly the characters this format relies on. The section/line
//! split here is therefore a deliberately small, domain-specific reader; only
//! the text decoding is delegated to [`encoding_rs`].
//!
//! Layout (user-facing behaviour: `README.md` → "Importing from MobaXterm"):
//!
//! ```text
//! [Bookmarks]            <- root folder
//! SubRep=                <- folder path, `\`-separated; empty for the root
//! ImgNum=42              <- folder icon (ignored)
//! Name=#109#0%host%22%user%...#MobaFont%10%...#0# #-1
//! [Bookmarks_1]          <- one section per sub-folder
//! SubRep=Lab\Switches
//! ```
//!
//! A session value is `<prefix>#<icon>#<params>#<terminal>#<start>#<comment>#<color>`
//! where `<params>` is `%`-separated and its first field is the session-type
//! code (the `#<icon>#` number is only the picture shown in MobaXterm).

/// Which text encoding the source bytes were decoded from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceEncoding {
    /// Valid UTF-8 (with or without a byte-order mark).
    Utf8,
    /// Not valid UTF-8 — decoded as Windows-1252, MobaXterm's native codepage.
    Windows1252,
}

impl SourceEncoding {
    /// Stable wire label for the preview DTO.
    pub fn label(self) -> &'static str {
        match self {
            Self::Utf8 => "utf-8",
            Self::Windows1252 => "windows-1252",
        }
    }
}

/// Decode raw file bytes: UTF-8 when the bytes are valid UTF-8 (BOM stripped),
/// otherwise Windows-1252. Windows-1252 maps every byte, so this never fails.
pub fn decode(bytes: &[u8]) -> (String, SourceEncoding) {
    let without_bom = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    match std::str::from_utf8(without_bom) {
        Ok(text) => (text.to_string(), SourceEncoding::Utf8),
        Err(_) => {
            let (text, _had_errors) = encoding_rs::WINDOWS_1252.decode_without_bom_handling(bytes);
            (text.into_owned(), SourceEncoding::Windows1252)
        }
    }
}

/// One saved session line from a `[Bookmarks*]` section, split but not yet
/// interpreted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawSession {
    /// Display name (the INI key), escape tokens decoded.
    pub name: String,
    /// Folder path from the section's `SubRep`, one entry per level. Empty for
    /// the root folder.
    pub folder_path: Vec<String>,
    /// The session-type code (first `%` field of the params block), or `None`
    /// when the line is too short to carry one.
    pub type_code: Option<u32>,
    /// The `%`-separated params block, *raw* (escape tokens still encoded so a
    /// caller can split `__PIPE__` lists before decoding). Index 0 is the type.
    pub params: Vec<String>,
    /// The `%`-separated terminal-settings block (font, cursor, terminal type,
    /// …), raw like `params`; empty when absent (#4854).
    pub terminal: Vec<String>,
    /// The free-text comment block, decoded; empty when absent.
    pub comment: String,
}

/// Replace MobaXterm's spelled-out delimiter tokens with the characters they
/// stand for. `__POURCENT__` is the spelling some MobaXterm builds write for
/// `%` (French "pourcent"); both spellings are accepted.
pub fn decode_escapes(raw: &str) -> String {
    const TOKENS: [(&str, &str); 7] = [
        ("__PTVIRG__", ";"),
        ("__DBLQUO__", "\""),
        ("__DIEZE__", "#"),
        ("__PERCENT__", "%"),
        ("__POURCENT__", "%"),
        ("__EQUAL__", "="),
        ("__PIPE__", "|"),
    ];
    if !raw.contains("__") {
        return raw.to_string();
    }
    TOKENS
        .iter()
        .fold(raw.to_string(), |acc, (token, ch)| acc.replace(token, ch))
}

/// Split a `SubRep` value into folder levels (`A\B` → `["A", "B"]`), dropping
/// empty segments so a stray leading/trailing/double backslash is harmless.
fn split_sub_rep(value: &str) -> Vec<String> {
    value
        .split('\\')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(decode_escapes)
        .collect()
}

/// Whether a section header names a bookmark folder (`[Bookmarks]`,
/// `[Bookmarks_12]`). Case-insensitive, like MobaXterm itself.
fn is_bookmark_section(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    match lower.strip_prefix("bookmarks") {
        Some("") => true,
        Some(rest) => rest
            .strip_prefix('_')
            .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())),
        None => false,
    }
}

/// Split one session value into a [`RawSession`]. Short or truncated lines
/// still produce a session (with `type_code: None` or few params) so the
/// mapper can report them as skipped instead of silently dropping them.
fn split_session(name: &str, value: &str, folder_path: &[String]) -> RawSession {
    // The leading block (before the first `#`) is a bookmark flag (e.g.
    // `;  logout`), then the icon, then the params.
    let mut blocks = value.trim_start().split('#');
    let _prefix = blocks.next();
    let _icon = blocks.next();
    let params_block = blocks.next();
    let terminal_block = blocks.next();
    let _start_mode = blocks.next();
    let comment = blocks.next().map(decode_escapes).unwrap_or_default();

    let params: Vec<String> = params_block
        .map(|p| p.split('%').map(str::to_string).collect())
        .unwrap_or_default();
    let terminal: Vec<String> = terminal_block
        .filter(|t| !t.trim().is_empty())
        .map(|t| t.split('%').map(str::to_string).collect())
        .unwrap_or_default();
    let type_code = params.first().and_then(|t| t.trim().parse::<u32>().ok());

    RawSession {
        name: decode_escapes(name.trim()),
        folder_path: folder_path.to_vec(),
        type_code,
        params,
        terminal,
        comment: comment.trim().to_string(),
    }
}

/// Read every session from the `[Bookmarks*]` sections of `text`, in file
/// order. Everything outside those sections (global preferences, history,
/// `[SSH_Hostkeys]`, any password data) is ignored. CRLF and LF line endings
/// are both accepted.
pub fn parse_bookmarks(text: &str) -> Vec<RawSession> {
    let mut sessions = Vec::new();
    let mut in_bookmarks = false;
    let mut folder: Vec<String> = Vec::new();

    for raw_line in text.lines() {
        let line = raw_line.trim_end_matches('\r');
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(section) = trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            in_bookmarks = is_bookmark_section(section);
            folder.clear();
            continue;
        }
        if !in_bookmarks {
            continue;
        }
        // A line without `=` (or with an empty key) is not a session.
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key_trimmed = key.trim();
        if key_trimmed.is_empty() {
            continue;
        }
        match key_trimmed {
            "SubRep" => folder = split_sub_rep(value),
            "ImgNum" => {}
            _ => sessions.push(split_session(key_trimmed, value, &folder)),
        }
    }
    sessions
}
