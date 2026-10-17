//! Tests for MobaXterm's global `[Colors]`, `[Font]` and `[Cursor]` sections
//! (#4880). Every fixture is synthetic: made-up colours and font names.

use std::path::PathBuf;

use super::global_appearance::parse_global_appearance;
use super::placeholders::PlaceholderEnv;
use super::{preview_from_bytes, MobaxtermGlobalAppearance};
use crate::connection::settings::CursorStyle;

/// A complete synthetic configuration in the published key layout.
const FULL: &str = "[Bookmarks]\r\n\
SubRep=\r\n\
ImgNum=42\r\n\
[Font]\r\n\
Font2=Example Mono\r\n\
FontIsBold2=0\r\n\
FontHeight2=12\r\n\
FontCharset2=0\r\n\
FontQuality2=3\r\n\
Charset2=UTF-8\r\n\
\r\n\
[Colors]\r\n\
DefaultColorScheme=0\r\n\
Black=1,2,3\r\n\
BoldBlack=11,12,13\r\n\
Red=200,0,0\r\n\
BoldRed=255,0,0\r\n\
Green=0,200,0\r\n\
BoldGreen=0,255,0\r\n\
Yellow=200,200,0\r\n\
BoldYellow=255,255,0\r\n\
Blue=0,0,200\r\n\
BoldBlue=0,0,255\r\n\
Magenta=200,0,200\r\n\
BoldMagenta=255,0,255\r\n\
Cyan=0,200,200\r\n\
BoldCyan=0,255,255\r\n\
White=200,200,200\r\n\
BoldWhite=255,255,255\r\n\
ForegroundColour=236,236,236\r\n\
BackgroundColour=30,30,30\r\n\
CursorColour=180,180,192\r\n\
SyntaxType=1\r\n\
\r\n\
[Cursor]\r\n\
CursorType=2\r\n\
CursorBlinks=1\r\n";

fn parse(text: &str) -> (Option<MobaxtermGlobalAppearance>, Vec<String>) {
    let mut notes = Vec::new();
    let out = parse_global_appearance(text, &mut notes);
    (out, notes)
}

fn hex(s: &str) -> Option<String> {
    Some(s.to_string())
}

#[test]
fn full_sections_map_to_colours_font_and_cursor() {
    let (global, notes) = parse(FULL);
    let global = global.expect("global appearance");
    assert!(notes.is_empty(), "{notes:?}");

    let colors = global.colors.expect("colours");
    assert_eq!(colors.foreground, hex("#ececec"));
    assert_eq!(colors.background, hex("#1e1e1e"));
    assert_eq!(colors.cursor, hex("#b4b4c0"));
    assert_eq!(colors.ansi.len(), 16);
    assert_eq!(colors.ansi[0], hex("#010203"), "black");
    assert_eq!(colors.ansi[1], hex("#c80000"), "red");
    assert_eq!(colors.ansi[7], hex("#c8c8c8"), "white");
    assert_eq!(colors.ansi[8], hex("#0b0c0d"), "bright black = BoldBlack");
    assert_eq!(colors.ansi[15], hex("#ffffff"), "bright white = BoldWhite");

    assert_eq!(
        global.font_family.as_deref(),
        Some("\"Example Mono\", monospace")
    );
    assert_eq!(global.font_size, Some(16), "12 pt = 16 px");
    assert_eq!(global.cursor_style, Some(CursorStyle::Bar));
    assert_eq!(global.cursor_blink, Some(true));
}

#[test]
fn section_and_key_names_are_case_insensitive_and_crlf_safe() {
    let text = "[colors]\nforegroundcolour=1,1,1\n[FONT]\nfontheight2=9\n";
    let (global, _) = parse(text);
    let global = global.expect("global appearance");
    assert_eq!(global.colors.expect("colours").foreground, hex("#010101"));
    assert_eq!(global.font_size, Some(12));
}

#[test]
fn moba_font_offers_no_family_but_keeps_the_size() {
    let text = "[Font]\r\nFont2=MobaFont\r\nFontHeight2=10\r\n";
    let (global, _) = parse(text);
    let global = global.expect("global appearance");
    assert!(global.font_family.is_none());
    assert_eq!(global.font_size, Some(13));
}

#[test]
fn partial_colours_leave_the_rest_unset() {
    // Some published configs carry only fg/bg/cursor.
    let text = "[Colors]\r\nForegroundColour=236,236,236\r\nBackgroundColour=0,0,0\r\n";
    let (global, notes) = parse(text);
    let colors = global.expect("global").colors.expect("colours");
    assert_eq!(colors.background, hex("#000000"));
    assert!(colors.cursor.is_none());
    assert!(colors.ansi.iter().all(Option::is_none));
    assert!(notes.is_empty());
}

#[test]
fn unreadable_colours_are_noted_and_skipped() {
    let text = "[Colors]\r\nRed=300,0,0\r\nGreen=1,2\r\nBlue=a,b,c\r\nCyan=0,1,2\r\n";
    let (global, notes) = parse(text);
    let colors = global.expect("global").colors.expect("colours");
    assert!(colors.ansi[1].is_none() && colors.ansi[2].is_none() && colors.ansi[4].is_none());
    assert_eq!(colors.ansi[6], hex("#000102"));
    assert_eq!(notes.len(), 1);
    assert!(notes[0].contains("Red, Green, Blue"), "{notes:?}");
}

#[test]
fn only_a_preset_index_offers_no_theme() {
    let (global, notes) = parse("[Colors]\r\nDefaultColorScheme=3\r\n");
    assert!(global.is_none());
    assert!(notes.is_empty());
}

#[test]
fn font_size_is_clamped_or_noted() {
    let (global, notes) = parse("[Font]\r\nFontHeight2=40\r\n");
    assert_eq!(global.expect("global").font_size, Some(32));
    assert!(notes[0].contains("outside termiHub's range"));

    let (global, notes) = parse("[Font]\r\nFontHeight2=big\r\n");
    assert!(global.is_none());
    assert!(notes[0].contains("could not be read"));
}

#[test]
fn bold_font_and_other_charsets_are_noted() {
    let (_, notes) = parse("[Font]\r\nFont2=X\r\nFontIsBold2=1\r\nCharset2=ISO-8859-1\r\n");
    assert_eq!(notes.len(), 2, "{notes:?}");
    assert!(notes[0].contains("bold"));
    assert!(notes[1].contains("ISO-8859-1"));
}

#[test]
fn cursor_types_map_and_unknown_ones_are_noted() {
    for (code, style) in [
        ("0", CursorStyle::Block),
        ("1", CursorStyle::Underline),
        ("2", CursorStyle::Bar),
    ] {
        let (global, _) = parse(&format!("[Cursor]\r\nCursorType={code}\r\n"));
        assert_eq!(global.expect("global").cursor_style, Some(style));
    }
    let (global, notes) = parse("[Cursor]\r\nCursorType=7\r\nCursorBlinks=0\r\n");
    let global = global.expect("global");
    assert!(global.cursor_style.is_none());
    assert_eq!(global.cursor_blink, Some(false));
    assert!(notes[0].contains("cursor type 7"));
}

#[test]
fn keys_outside_the_sections_are_ignored() {
    // The same keys in another section (or a session line) do not count.
    let text = "[Misc]\r\nForegroundColour=1,1,1\r\nCursorType=1\r\nFont2=Nope\r\n";
    let (global, notes) = parse(text);
    assert!(global.is_none());
    assert!(notes.is_empty());
}

#[test]
fn preview_carries_the_global_appearance_on_the_wire() {
    let env = PlaceholderEnv {
        profile_dir: Some(PathBuf::from("/home/alice")),
        documents_dir: None,
        app_data_dir: None,
        desktop_dir: None,
        current_drive: None,
    };
    let p = preview_from_bytes(FULL.as_bytes(), "/tmp/MobaXterm.ini", &env);
    let wire = serde_json::to_value(&p).expect("serialize");
    let global = &wire["globalAppearance"];
    assert_eq!(global["fontSize"], 16);
    assert_eq!(global["cursorStyle"], "bar");
    assert_eq!(global["cursorBlink"], true);
    assert_eq!(global["colors"]["background"], "#1e1e1e");
    assert_eq!(global["colors"]["ansi"][15], "#ffffff");

    let bare = preview_from_bytes(b"[Bookmarks]\r\nSubRep=\r\n", "/tmp/x.ini", &env);
    let wire = serde_json::to_value(&bare).expect("serialize");
    assert!(wire.get("globalAppearance").is_none());
}
