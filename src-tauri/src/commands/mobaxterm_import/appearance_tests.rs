//! Terminal-appearance tests for the MobaXterm import (#4854). Every fixture
//! is synthetic: documentation IP ranges, example.com hosts, made-up names.

use std::path::PathBuf;

use super::appearance::{global_appearance_sections, map_appearance};
use super::placeholders::PlaceholderEnv;
use super::{preview_from_bytes, MobaxtermImportPreview, MobaxtermSession};

fn env() -> PlaceholderEnv {
    PlaceholderEnv {
        profile_dir: Some(PathBuf::from("/home/alice")),
        documents_dir: None,
        app_data_dir: None,
        desktop_dir: None,
        current_drive: None,
    }
}

fn preview(ini: &str) -> MobaxtermImportPreview {
    preview_from_bytes(ini.as_bytes(), "/tmp/MobaXterm.ini", &env())
}

fn by_name<'a>(sessions: &'a [MobaxtermSession], name: &str) -> &'a MobaxtermSession {
    sessions
        .iter()
        .find(|s| s.name == name)
        .unwrap_or_else(|| panic!("session {name} present"))
}

/// A terminal block with MobaXterm's factory defaults, `%`-split.
fn default_block() -> Vec<String> {
    "MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%0%\
     _Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1%-1"
        .split('%')
        .map(str::to_string)
        .collect()
}

/// `default_block()` with field `idx` replaced.
fn block_with(changes: &[(usize, &str)]) -> Vec<String> {
    let mut block = default_block();
    for (idx, value) in changes {
        block[*idx] = (*value).to_string();
    }
    block
}

fn opts_json(block: &[String], code: u32, ty: &str) -> serde_json::Value {
    serde_json::to_value(map_appearance(block, code, ty).options).expect("serialize")
}

#[test]
fn a_session_at_mobaxterm_defaults_gets_no_overrides_or_notes() {
    let a = map_appearance(&default_block(), 0, "ssh");
    assert!(a.notes.is_empty(), "no notes for defaults: {:?}", a.notes);
    assert_eq!(a.terminal_type, None);
    // MobaFont, 10 pt and a non-blinking block cursor are MobaXterm's
    // defaults: the connection keeps following termiHub's global settings.
    assert!(a.options.is_none(), "no overrides: {:?}", a.options);
}

#[test]
fn a_customised_session_gets_overrides_for_the_changed_values_only() {
    let opts = opts_json(&block_with(&[(1, "12")]), 0, "ssh");
    assert_eq!(opts, serde_json::json!({"fontSize": 16}));

    let opts = opts_json(&block_with(&[(9, "4")]), 0, "ssh");
    assert_eq!(
        opts,
        serde_json::json!({"cursorStyle": "underline", "cursorBlink": true})
    );

    let opts = opts_json(
        &block_with(&[(0, "Fake Mono"), (1, "11"), (9, "2")]),
        0,
        "ssh",
    );
    assert_eq!(
        opts,
        serde_json::json!({
            "fontFamily": "\"Fake Mono\", monospace",
            "fontSize": 15,
            "cursorStyle": "bar",
            "cursorBlink": false
        })
    );
}

#[test]
fn custom_font_family_gets_a_monospace_fallback() {
    let opts = opts_json(&block_with(&[(0, "Fake Mono"), (1, "12")]), 0, "ssh");
    assert_eq!(opts["fontFamily"], "\"Fake Mono\", monospace");
    assert_eq!(opts["fontSize"], 16);
}

#[test]
fn font_size_is_clamped_to_termihub_range_with_a_note() {
    let a = map_appearance(&block_with(&[(1, "40")]), 0, "ssh");
    assert_eq!(a.options.and_then(|o| o.font_size), Some(32));
    assert!(a.notes.iter().any(|n| n.contains("40 pt")));

    let a = map_appearance(&block_with(&[(1, "big")]), 0, "ssh");
    assert_eq!(a.options.and_then(|o| o.font_size), None);
    assert!(a.notes.iter().any(|n| n.contains("\"big\"")));
}

#[test]
fn every_cursor_type_maps_to_style_and_blink() {
    // "0" (non-blinking block) is the default and is covered above.
    let cases = [
        ("1", "underline", false),
        ("2", "bar", false),
        ("3", "block", true),
        ("4", "underline", true),
        ("5", "bar", true),
    ];
    for (code, style, blink) in cases {
        let opts = opts_json(&block_with(&[(9, code)]), 0, "ssh");
        assert_eq!(opts["cursorStyle"], style, "cursor {code}");
        assert_eq!(opts["cursorBlink"], blink, "cursor {code}");
    }
    let a = map_appearance(&block_with(&[(9, "9")]), 0, "ssh");
    assert!(a.notes.iter().any(|n| n.contains("Unknown cursor type 9")));
}

#[test]
fn telnet_takes_a_terminfo_terminal_type_and_notes_keyboard_modes() {
    let a = map_appearance(&block_with(&[(13, "vt220")]), 1, "telnet");
    assert_eq!(a.terminal_type.as_deref(), Some("vt220"));
    assert!(a.notes.is_empty());

    let a = map_appearance(&block_with(&[(13, "SCO")]), 1, "telnet");
    assert_eq!(a.terminal_type, None);
    assert!(a.notes.iter().any(|n| n.contains("\"SCO\"")));
}

#[test]
fn ssh_notes_a_non_xterm_terminal_type_and_serial_ignores_it() {
    let a = map_appearance(&block_with(&[(13, "vt100")]), 0, "ssh");
    assert_eq!(a.terminal_type, None);
    assert!(a.notes.iter().any(|n| n.contains("xterm-256color")));

    let a = map_appearance(&block_with(&[(13, "xterm-256color")]), 0, "ssh");
    assert!(a.notes.is_empty());

    let a = map_appearance(&block_with(&[(13, "vt100")]), 8, "serial");
    assert!(a.notes.is_empty());
}

#[test]
fn unmapped_non_default_settings_are_noted() {
    let a = map_appearance(
        &block_with(&[(5, "0"), (7, "0,0,0"), (17, "132"), (18, "43"), (19, "-1")]),
        0,
        "ssh",
    );
    assert!(a.notes.iter().any(|n| n.contains("ISO-8859-1")));
    assert!(a.notes.iter().any(|n| n.contains("colours")));
    assert!(a.notes.iter().any(|n| n.contains("132×43")));
}

#[test]
fn custom_colour_scheme_is_noted() {
    let a = map_appearance(&block_with(&[(16, "0,0,0")]), 0, "ssh");
    assert!(a.notes.iter().any(|n| n.contains("colours")));
}

#[test]
fn non_terminal_types_and_empty_blocks_contribute_nothing() {
    // RDP (4) carries only a stub block.
    let a = map_appearance(&block_with(&[(1, "14")]), 4, "rdp");
    assert!(a.options.is_none() && a.notes.is_empty());
    let a = map_appearance(&[], 0, "ssh");
    assert!(a.options.is_none() && a.notes.is_empty());
}

#[test]
fn global_sections_are_detected_case_insensitively_once() {
    let text = "[font]\r\nX=1\r\n[Colors]\r\n[Bookmarks]\r\n[Font]\r\n";
    assert_eq!(global_appearance_sections(text), ["Font", "Colors"]);
}

const INI: &str = "[Font]\r\n\
Font=Fake Mono\r\n\
[Colors]\r\n\
DefaultColorScheme=0\r\n\
[Bookmarks]\r\n\
SubRep=\r\n\
ImgNum=42\r\n\
Lab router=#109#0%10.0.0.1%22%netops%%-1%-1%%%%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#Fake Mono%12%0%0%-1%15%236,236,236%30,30,30%180,180,192%5%-1%0%%xterm%-1%0%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1%-1#0# #-1\r\n\
Old switch=#98#1%192.0.2.10%23%%%2%%%%%0%0%%1080%#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%1%-1%0%%vt100%-1%0%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1%-1#0# #-1\r\n\
Default shell=#129#10%1%%%%#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%0%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1%-1#0# #-1\r\n\
Desk RDP=#91#4%192.0.2.20%3389%carol%0%0%0%0%-1%0%0%-1%%%%%0%0%%-1%%-1%-1%0%-1%0%-1%0%0%0%0#MobaFont%10#0# #-1\r\n";

#[test]
fn preview_carries_terminal_options_and_telnet_terminal_type() {
    let p = preview(INI);
    let ssh = by_name(&p.sessions, "Lab router");
    let opts = serde_json::to_value(&ssh.terminal_options).expect("serialize");
    assert_eq!(
        opts,
        serde_json::json!({
            "fontFamily": "\"Fake Mono\", monospace",
            "fontSize": 16,
            "cursorStyle": "bar",
            "cursorBlink": true
        })
    );

    let telnet = by_name(&p.sessions, "Old switch");
    let settings = telnet.settings.as_ref().expect("settings");
    assert_eq!(settings["terminalType"], "vt100");
    assert_eq!(settings["host"], "192.0.2.10");
    let opts = serde_json::to_value(&telnet.terminal_options).expect("serialize");
    assert_eq!(opts["cursorStyle"], "underline");

    let rdp = by_name(&p.sessions, "Desk RDP");
    assert!(rdp.terminal_options.is_none());

    let default_shell = by_name(&p.sessions, "Default shell");
    assert!(default_shell.terminal_options.is_none());
    assert!(rdp
        .settings
        .as_ref()
        .expect("settings")
        .get("terminalType")
        .is_none());
}

#[test]
fn preview_notes_global_appearance_sections() {
    let p = preview(INI);
    assert_eq!(p.notes.len(), 1);
    assert!(p.notes[0].contains("[Font], [Colors]"));

    let p = preview("[Bookmarks]\r\nSubRep=\r\n");
    assert!(p.notes.is_empty());
}

#[test]
fn terminal_options_are_omitted_from_the_wire_when_absent() {
    let p = preview(INI);
    let rdp = serde_json::to_value(by_name(&p.sessions, "Desk RDP")).expect("serialize");
    assert!(rdp.get("terminalOptions").is_none());
}
