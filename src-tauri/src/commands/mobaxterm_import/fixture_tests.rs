//! The committed MobaXterm fixtures (`tests/fixtures/mobaxterm/`, #4960) parse
//! into exactly the preview the integration grade of MT-APP-05
//! (`tests/system/tests/test_mobaxterm_import.py`) asserts, so a mapping change
//! that would break that grade fails here, per PR, first.

use std::path::{Path, PathBuf};

use super::placeholders::PlaceholderEnv;
use super::{preview_from_bytes, MobaxtermSession};

const INI: &str = include_str!("../../../../tests/fixtures/mobaxterm/MobaXterm.ini");
const MXTSESSIONS: &str = include_str!("../../../../tests/fixtures/mobaxterm/example.mxtsessions");

fn env() -> PlaceholderEnv {
    PlaceholderEnv {
        profile_dir: Some(PathBuf::from("/home/demo")),
        ..PlaceholderEnv::default()
    }
}

/// `(key, name, type, target, folder, connection type)` per session.
fn rows(text: &str) -> Vec<(String, String, String, String, String, Option<String>)> {
    preview_from_bytes(text.as_bytes(), "/fixture", &env())
        .sessions
        .iter()
        .map(|s: &MobaxtermSession| {
            (
                s.key.clone(),
                s.name.clone(),
                s.session_type.clone(),
                s.target.clone(),
                s.folder_path.join(" / "),
                s.connection_type.clone(),
            )
        })
        .collect()
}

#[test]
fn fixture_ini_previews_the_graded_rows() {
    let row = |k: &str, n: &str, t: &str, tg: &str, f: &str, c: Option<&str>| {
        (
            k.to_string(),
            n.to_string(),
            t.to_string(),
            tg.to_string(),
            f.to_string(),
            c.map(str::to_string),
        )
    };
    assert_eq!(
        rows(INI),
        [
            row(
                "moba-0",
                "Example Telnet",
                "Telnet",
                "192.0.2.10:2323",
                "",
                Some("telnet")
            ),
            row("moba-1", "Example Docs", "Browser", "", "", None),
            row(
                "moba-2",
                "Example SSH",
                "SSH",
                "demo@ssh.example.com:2222",
                "Example Lab",
                Some("ssh")
            ),
            row(
                "moba-3",
                "Example Serial",
                "Serial",
                "COM3 @ 115200",
                "Example Lab / Consoles",
                Some("serial")
            ),
        ]
    );
}

#[test]
fn fixture_ini_resolves_the_key_and_imports_no_password() {
    let preview = preview_from_bytes(INI.as_bytes(), "/fixture", &env());
    let ssh = &preview.sessions[2];
    let settings = ssh.settings.as_ref().expect("ssh settings");
    let expected = Path::new("/home/demo").join("keys").join("demo_ed25519");
    assert_eq!(settings["keyPath"], expected.to_string_lossy().as_ref());
    assert_eq!(settings["authMethod"], "key");
    let all = serde_json::to_string(&preview).expect("serialize");
    assert!(!all.contains("SYNTHETIC-NOT-A-PASSWORD-4960"));
    assert!(!all.contains("_ProfileDir_"));
}

#[test]
fn fixture_mxtsessions_previews_the_same_rows() {
    assert_eq!(rows(MXTSESSIONS), rows(INI));
}
