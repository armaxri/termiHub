//! Session-logging and scrollback tests for the MobaXterm import (#4881).
//! Every fixture is synthetic: documentation IP ranges, made-up names, no
//! real `MobaXterm.ini`.

use std::path::PathBuf;

use super::appearance::map_appearance;
use super::placeholders::PlaceholderEnv;
use super::{preview_from_bytes, MobaxtermSession};

/// Fields 0–27 of a terminal block at MobaXterm's factory defaults.
const DEFAULT_FIELDS: &str = "MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%\
     xterm%-1%0%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1%-1";

/// Sixteen `R,G,B` values standing in for a custom colour scheme at index 16.
fn custom_scheme() -> String {
    (0..16)
        .map(|i| format!("{i},{i},{i}"))
        .collect::<Vec<_>>()
        .join("%")
}

/// An expert-settings list (index 28) with `scrollback` as entry 11.
fn expert(scrollback: &str) -> String {
    format!("1001111111110000000000,x2,1,,,,,R,S,Any,0,{scrollback}")
}

fn split(block: &str) -> Vec<String> {
    block.split('%').map(str::to_string).collect()
}

/// The default block with field `idx` replaced and `extra` appended as
/// index 28 onwards.
fn block(changes: &[(usize, &str)], extra: Option<&str>) -> Vec<String> {
    let mut fields = split(DEFAULT_FIELDS);
    for (idx, value) in changes {
        fields[*idx] = (*value).to_string();
    }
    if let Some(extra) = extra {
        fields.push(extra.to_string());
    }
    fields
}

/// The default block with a custom colour scheme expanded at index 16, so
/// every later index moves by fifteen, plus `expert` at the shifted index 28.
fn custom_scheme_block(expert: &str, fixed_size: bool) -> Vec<String> {
    let mut fields = split(DEFAULT_FIELDS);
    if fixed_size {
        fields[17] = "132".to_string();
        fields[18] = "43".to_string();
        fields[19] = "-1".to_string();
    }
    let tail = fields.split_off(16);
    fields.extend(split(&custom_scheme()));
    fields.extend(tail.into_iter().skip(1));
    fields.push(expert.to_string());
    fields
}

fn opts(block: &[String]) -> serde_json::Value {
    serde_json::to_value(map_appearance(block, 0, "ssh").options).expect("serialize")
}

#[test]
fn logging_and_scrollback_at_defaults_add_nothing() {
    for extra in [
        None,
        Some(expert("").as_str()),
        Some(expert("360000").as_str()),
    ] {
        let a = map_appearance(&block(&[], extra), 0, "ssh");
        assert!(a.options.is_none(), "no overrides: {:?}", a.options);
        assert!(a.notes.is_empty(), "no notes: {:?}", a.notes);
    }
    // A short expert list without entry 11 is MobaXterm's default too.
    let a = map_appearance(&block(&[], Some("1001111111110000000000,x2")), 0, "ssh");
    assert!(a.options.is_none() && a.notes.is_empty());
}

#[test]
fn enabled_logging_maps_to_log_to_file() {
    let a = map_appearance(&block(&[(11, "-1")], None), 0, "ssh");
    assert_eq!(
        serde_json::to_value(&a.options).expect("serialize"),
        serde_json::json!({ "logToFile": true })
    );
    // MobaXterm's own default folder: nothing to report.
    assert!(a.notes.is_empty(), "{:?}", a.notes);
}

#[test]
fn a_log_folder_is_noted_never_used() {
    let a = map_appearance(
        &block(&[(11, "-1"), (12, "_MyDocuments_\\MobaLogs")], None),
        0,
        "ssh",
    );
    let json = serde_json::to_value(&a.options).expect("serialize");
    assert_eq!(json, serde_json::json!({ "logToFile": true }));
    assert_eq!(a.notes.len(), 1, "{:?}", a.notes);
    assert!(a.notes[0].contains("\"_MyDocuments_\\MobaLogs\""));
    assert!(a.notes[0].contains("termiHub writes session logs to its own log folder"));

    let a = map_appearance(&block(&[(11, "-1"), (12, "<>")], None), 0, "ssh");
    assert!(a.notes[0].contains("MobaXterm's program folder"));
}

#[test]
fn a_log_folder_without_logging_is_ignored() {
    let a = map_appearance(&block(&[(12, "D:\\Logs")], None), 0, "ssh");
    assert!(a.options.is_none() && a.notes.is_empty());
}

#[test]
fn scrollback_maps_and_clamps_to_termihub_range() {
    assert_eq!(
        opts(&block(&[], Some(&expert("5000")))),
        serde_json::json!({ "scrollbackBuffer": 5000 })
    );

    let a = map_appearance(&block(&[], Some(&expert("10"))), 0, "ssh");
    assert_eq!(a.options.and_then(|o| o.scrollback_buffer), Some(100));
    assert!(a
        .notes
        .iter()
        .any(|n| n.contains("10 lines") && n.contains("100")));

    let a = map_appearance(&block(&[], Some(&expert("99999999"))), 0, "ssh");
    assert_eq!(a.options.and_then(|o| o.scrollback_buffer), Some(1_000_000));
    assert!(a
        .notes
        .iter()
        .any(|n| n.contains("outside termiHub's range")));
}

#[test]
fn unreadable_scrollback_is_noted() {
    let a = map_appearance(&block(&[], Some(&expert("lots"))), 0, "ssh");
    assert!(a.options.is_none());
    assert!(a.notes.iter().any(|n| n.contains("\"lots\"")));
}

#[test]
fn a_custom_colour_scheme_shifts_the_expert_settings() {
    let a = map_appearance(&custom_scheme_block(&expert("20000"), false), 0, "ssh");
    assert_eq!(a.options.and_then(|o| o.scrollback_buffer), Some(20_000));
    // The colours themselves are still only noted.
    assert!(a.notes.iter().any(|n| n.contains("colours")));
}

#[test]
fn a_custom_colour_scheme_shifts_the_fixed_terminal_size() {
    let a = map_appearance(&custom_scheme_block(&expert(""), true), 0, "ssh");
    assert!(
        a.notes.iter().any(|n| n.contains("132×43")),
        "{:?}",
        a.notes
    );
    let a = map_appearance(&custom_scheme_block(&expert(""), false), 0, "ssh");
    assert!(!a.notes.iter().any(|n| n.contains("fixed terminal size")));
}

#[test]
fn without_a_custom_scheme_index_28_is_not_shifted() {
    // An expert list at the unshifted index is read; one past it is not.
    let mut fields = block(&[], Some(""));
    fields.extend(std::iter::repeat_n(String::new(), 14));
    fields.push(expert("20000"));
    let a = map_appearance(&fields, 0, "ssh");
    assert!(a.options.is_none(), "{:?}", a.options);
}

#[test]
fn preview_carries_logging_and_scrollback() {
    let ini = format!(
        "[Bookmarks]\r\nSubRep=\r\nImgNum=42\r\n\
         Logged box=#109#0%192.0.2.30%22%ops%%-1%-1%%%%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#{}#0# #-1\r\n",
        block(&[(11, "-1")], Some(&expert("50000"))).join("%")
    );
    let env = PlaceholderEnv {
        profile_dir: Some(PathBuf::from("/home/alice")),
        ..PlaceholderEnv::default()
    };
    let p = preview_from_bytes(ini.as_bytes(), "/tmp/MobaXterm.ini", &env);
    let session: &MobaxtermSession = p
        .sessions
        .iter()
        .find(|s| s.name == "Logged box")
        .expect("session present");
    assert_eq!(
        serde_json::to_value(&session.terminal_options).expect("serialize"),
        serde_json::json!({ "logToFile": true, "scrollbackBuffer": 50000 })
    );
}
