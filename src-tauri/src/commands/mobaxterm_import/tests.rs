//! Parser, mapping, placeholder and discovery tests for the MobaXterm import
//! (#4850). Every fixture is synthetic: documentation IP ranges, example.com
//! hosts and made-up names only.

use std::path::{Path, PathBuf};

use serde_json::json;

use super::discovery::{candidate_paths, existing_candidates, CandidateSource, DiscoveryEnv};
use super::parser::{decode, decode_escapes, parse_bookmarks, SourceEncoding};
use super::placeholders::{expand_path, PlaceholderEnv};
use super::trusted_hosts::NothingTrusted;
use super::{preview_file, preview_from_bytes, MobaxtermSession};

/// A placeholder environment with fixed, OS-native directories.
fn env() -> PlaceholderEnv {
    let home = PathBuf::from("/home/alice");
    PlaceholderEnv {
        profile_dir: Some(home.clone()),
        documents_dir: Some(home.join("Documents")),
        app_data_dir: Some(home.join("AppData")),
        desktop_dir: Some(home.join("Desktop")),
        current_drive: Some("D".to_string()),
    }
}

fn preview(ini: &str) -> Vec<MobaxtermSession> {
    preview_from_bytes(ini.as_bytes(), "/tmp/MobaXterm.ini", &env()).sessions
}

fn by_name<'a>(sessions: &'a [MobaxtermSession], name: &str) -> &'a MobaxtermSession {
    sessions
        .iter()
        .find(|s| s.name == name)
        .unwrap_or_else(|| panic!("session {name} present"))
}

fn setting<'a>(s: &'a MobaxtermSession, key: &str) -> &'a serde_json::Value {
    s.settings
        .as_ref()
        .and_then(|v| v.get(key))
        .unwrap_or(&serde_json::Value::Null)
}

/// A full synthetic configuration: global sections that must be ignored, a
/// root folder, two nested folders and one session of every type.
const FULL_INI: &str = "[Misc]\r\n\
SomePref=1\r\n\
[Bookmarks]\r\n\
SubRep=\r\n\
ImgNum=42\r\n\
Lab router=#109#0%10.0.0.1%22%netops%%-1%-1%%%%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%0%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1%-1#0# #-1\r\n\
Old switch=#98#1%192.0.2.10%2323%%%2%%%%%0%0%%1080%#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%0%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1%-1#0# #-1\r\n\
Console (USB)=#131#8%1%1009600%3%2%2%2%2%COM7  (USB Serial Device (COM7))#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%0%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1%-1#0# #-1\r\n\
Docs site=#151#11%https://docs.example.com%%#MobaFont%10#0# #-1\r\n\
[Bookmarks_1]\r\n\
SubRep=Lab\r\n\
ImgNum=41\r\n\
Desk RDP=#91#4%192.0.2.20%3390%carol%0%0%0%0%-1%0%0%-1%%%%%0%0%%-1%%-1%-1%0%-1%0%-1%0%0%0%0#MobaFont%10#0# #-1\r\n\
[Bookmarks_2]\r\n\
SubRep=Lab\\Switches\r\n\
ImgNum=41\r\n\
Viewer=#128#5%10.0.0.30%5901%-1%0%%%%%%%#MobaFont%10#0# #-1\r\n\
Files=#130#6%ftp.example.com%2121%dave%%%#MobaFont%10#0# #-1\r\n\
Secure files=#140#7%sftp.example.com%22%erin%%%#MobaFont%10#0# #-1\r\n\
Bash here=#129#10%1%%_MyDocuments_\\projects%%#MobaFont%10#0# #-1\r\n\
Fedora box=#151#14%Fedora-Remix-41%%%%%%0#MobaFont%10#0# #-1\r\n\
Xdmcp box=#99#3%10.0.0.40%177%#MobaFont%10#0# #-1\r\n\
[SSH_Hostkeys]\r\n\
ssh-ed25519@22:10.0.0.1=0x1234\r\n";

#[test]
fn parses_every_session_and_ignores_other_sections() {
    let sessions = preview(FULL_INI);
    let names: Vec<&str> = sessions.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "Lab router",
            "Old switch",
            "Console (USB)",
            "Docs site",
            "Desk RDP",
            "Viewer",
            "Files",
            "Secure files",
            "Bash here",
            "Fedora box",
            "Xdmcp box"
        ]
    );
    // Keys are unique and stable.
    let mut keys: Vec<&str> = sessions.iter().map(|s| s.key.as_str()).collect();
    keys.dedup();
    assert_eq!(keys.len(), sessions.len());
}

#[test]
fn folders_follow_sub_rep_including_nested_levels() {
    let sessions = preview(FULL_INI);
    assert!(by_name(&sessions, "Lab router").folder_path.is_empty());
    assert_eq!(by_name(&sessions, "Desk RDP").folder_path, ["Lab"]);
    assert_eq!(
        by_name(&sessions, "Viewer").folder_path,
        ["Lab", "Switches"]
    );
}

#[test]
fn ssh_maps_host_port_user_and_password_auth() {
    let sessions = preview(FULL_INI);
    let s = by_name(&sessions, "Lab router");
    assert_eq!(s.session_type, "SSH");
    assert_eq!(s.connection_type.as_deref(), Some("ssh"));
    assert_eq!(s.target, "netops@10.0.0.1");
    assert_eq!(setting(s, "host"), "10.0.0.1");
    assert_eq!(setting(s, "port"), 22);
    assert_eq!(setting(s, "username"), "netops");
    assert_eq!(setting(s, "authMethod"), "password");
    assert!(
        setting(s, "password").is_null(),
        "passwords are never imported"
    );
    assert!(setting(s, "proxyJump").is_null());
}

#[test]
fn ssh_key_path_placeholder_is_expanded() {
    let ini = "[Bookmarks]\nSubRep=\nKeyed=#109#0%host.example.com%2222%bob%%-1%-1%%%%%0%0%0%_ProfileDir_\\keys\\lab_key%%-1%0%0%0%%1080%%0%0%1#MobaFont#0# #-1\n";
    let sessions = preview(ini);
    let s = &sessions[0];
    assert_eq!(setting(s, "authMethod"), "key");
    let expected = Path::new("/home/alice").join("keys").join("lab_key");
    assert_eq!(setting(s, "keyPath"), &json!(expected.to_string_lossy()));
    assert_eq!(s.target, "bob@host.example.com:2222");
    assert!(s.notes.is_empty(), "{:?}", s.notes);
}

#[test]
fn ssh_gateway_list_becomes_a_jump_host_chain() {
    let ini = "[Bookmarks]\nSubRep=\nBehind bastions=#109#0%10.0.0.5%22%app%%-1%-1%%edge.example.com__PIPE__10.0.0.2%22__PIPE__2200%eve__PIPE__<default>%0%0%0%%_CurrentDrive_:\\keys\\edge__PIPE__%-1%0%0%0%%1080%%0%0%1#MobaFont#0# #-1\n";
    let sessions = preview(ini);
    let hops = setting(&sessions[0], "proxyJump")
        .as_array()
        .expect("proxyJump array");
    assert_eq!(hops.len(), 2);
    assert_eq!(hops[0]["host"], "edge.example.com");
    assert_eq!(hops[0]["port"], 22);
    assert_eq!(hops[0]["username"], "eve");
    assert_eq!(hops[0]["authMethod"], "key");
    assert_eq!(hops[0]["keyPath"], "D:\\keys\\edge");
    assert_eq!(hops[1]["host"], "10.0.0.2");
    assert_eq!(hops[1]["port"], 2200);
    assert_eq!(hops[1]["username"], "");
    assert_eq!(hops[1]["authMethod"], "password");
}

#[test]
fn ssh_default_user_login_command_and_proxy_are_noted() {
    let ini = "[Bookmarks]\nSubRep=\nNoted=#109#0%10.0.0.6%22%<default>%%-1%-1%uptime__PTVIRG__ df%%%%0%-1%0%%%-1%0%0%2%proxy.example.com%1080%%0%0%1#MobaFont#0# #-1\n";
    let s = &preview(ini)[0];
    assert_eq!(setting(s, "username"), "");
    assert_eq!(s.target, "10.0.0.6");
    assert_eq!(setting(s, "initialCommand"), "uptime; df");
    // The default user and the proxy stay notes; the login command is mapped.
    assert_eq!(s.notes.len(), 2, "{:?}", s.notes);
}

#[test]
fn ssh_login_command_maps_to_the_initial_command() {
    // Field 7 is `__PTVIRG__` / `__PIPE__`-escaped (#4866).
    let ini = "[Bookmarks]\nSubRep=\nCmd=#109#0%10.0.0.16%22%alice%%-1%-1%cd /srv__PTVIRG__ ls __PIPE__ head%%%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont#0# #-1\n";
    let s = &preview(ini)[0];
    assert_eq!(setting(s, "initialCommand"), "cd /srv; ls | head");
    assert!(s.notes.is_empty(), "{:?}", s.notes);
    // It runs on the first connect only; on-reconnect is a different trigger.
    assert!(setting(s, "onReconnectCommand").is_null());
}

#[test]
fn ssh_without_a_login_command_has_no_initial_command() {
    let ini = "[Bookmarks]\nSubRep=\nPlain=#109#0%10.0.0.19%22%alice%%-1%-1%%%%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont#0# #-1\n";
    let s = &preview(ini)[0];
    assert!(setting(s, "initialCommand").is_null());
    assert!(s.notes.is_empty(), "{:?}", s.notes);
}

#[test]
fn ssh_network_proxy_is_described_in_the_note() {
    let socks = "[Bookmarks]\nSubRep=\nP=#109#0%10.0.0.17%22%alice%%-1%-1%%%%%0%0%0%%%-1%0%0%2%proxy.example.com%1080%%0%0%1#MobaFont#0# #-1\n";
    let s = &preview(socks)[0];
    assert_eq!(s.notes.len(), 1, "{:?}", s.notes);
    assert!(
        s.notes[0].contains("SOCKS5 proxy proxy.example.com:1080 was not imported"),
        "{:?}",
        s.notes
    );

    let http = "[Bookmarks]\nSubRep=\nP=#109#0%10.0.0.18%22%alice%%-1%-1%%%%%0%0%0%%%-1%0%0%3%192.0.2.50%3128%alice%0%0%1#MobaFont#0# #-1\n";
    let s = &preview(http)[0];
    assert!(
        s.notes[0].contains("HTTP proxy 192.0.2.50:3128 (user alice)"),
        "{:?}",
        s.notes
    );

    // Type 0 is "no proxy", even when a stale host/port is still stored.
    let none = "[Bookmarks]\nSubRep=\nP=#109#0%10.0.0.19%22%alice%%-1%-1%%%%%0%0%0%%%-1%0%0%0%proxy.example.com%1080%%0%0%1#MobaFont#0# #-1\n";
    assert!(preview(none)[0].notes.is_empty());
}

#[test]
fn rdp_ssh_gateway_and_rd_gateway_stay_notes() {
    let ini = r"[Bookmarks]
SubRep=
Gated RDP=#91#4%192.0.2.21%3389%carol%0%0%0%0%-1%0%0%-1%%edge.example.com%2200%alice%0%0%_ProfileDir_\keys\edge%-1%rdgw.example.com%-1#MobaFont#0# #-1
";
    let s = &preview(ini)[0];
    assert_eq!(s.connection_type.as_deref(), Some("rdp"));
    assert_eq!(s.target, "carol@192.0.2.21");
    assert!(setting(s, "useSshTunnel").is_null());
    assert_eq!(s.notes.len(), 2, "{:?}", s.notes);
    assert!(
        s.notes[0].contains("SSH gateway edge.example.com:2200 was not imported"),
        "{:?}",
        s.notes
    );
    assert!(s.notes[1].contains("rdgw.example.com"), "{:?}", s.notes);
}

#[test]
fn vnc_single_ssh_gateway_becomes_the_ssh_tunnel() {
    let ini = r"[Bookmarks]
SubRep=
Tunnelled=#128#5%192.0.2.30%5901%-1%0%bastion.example.com%2222%alice%_ProfileDir_\keys\vnc%-1%0%0%%0%%1080%%#MobaFont#0# #-1
";
    let s = &preview(ini)[0];
    assert_eq!(s.connection_type.as_deref(), Some("vnc"));
    assert_eq!(setting(s, "host"), "192.0.2.30");
    assert_eq!(setting(s, "port"), 5901);
    assert_eq!(setting(s, "useSshTunnel"), true);
    assert_eq!(setting(s, "sshHost"), "bastion.example.com");
    assert_eq!(setting(s, "sshPort"), 2222);
    assert_eq!(setting(s, "sshUsername"), "alice");
    assert_eq!(setting(s, "sshAuthMethod"), "key");
    let key = Path::new("/home/alice").join("keys").join("vnc");
    assert_eq!(setting(s, "sshKeyPath"), &json!(key.to_string_lossy()));
    assert!(
        setting(s, "sshPassword").is_null(),
        "passwords are never imported"
    );
    assert!(s.notes.is_empty(), "{:?}", s.notes);
}

#[test]
fn vnc_gateway_without_key_or_user_uses_password_auth() {
    let ini = "[Bookmarks]\nSubRep=\nT=#128#5%192.0.2.32%5900%-1%0%192.0.2.60%%<default>%%-1%0%0%%0%%1080%%#MobaFont#0# #-1\n";
    let s = &preview(ini)[0];
    assert_eq!(setting(s, "useSshTunnel"), true);
    assert_eq!(setting(s, "sshHost"), "192.0.2.60");
    assert_eq!(setting(s, "sshPort"), 22);
    assert_eq!(setting(s, "sshUsername"), "");
    assert_eq!(setting(s, "sshAuthMethod"), "password");
    assert!(setting(s, "sshKeyPath").is_null());
}

#[test]
fn vnc_gateway_chain_and_proxy_stay_notes() {
    let ini = "[Bookmarks]\nSubRep=\nChained=#128#5%192.0.2.31%5900%-1%0%edge.example.com__PIPE__192.0.2.40%22__PIPE__2200%alice__PIPE__alice%%-1%0%0%%2%proxy.example.com%1080%alice%#MobaFont#0# #-1\n";
    let s = &preview(ini)[0];
    assert_eq!(s.connection_type.as_deref(), Some("vnc"));
    assert!(setting(s, "useSshTunnel").is_null());
    assert!(setting(s, "sshHost").is_null());
    assert_eq!(s.notes.len(), 2, "{:?}", s.notes);
    assert!(
        s.notes[0].contains("edge.example.com → 192.0.2.40:2200"),
        "{:?}",
        s.notes
    );
    assert!(
        s.notes[1].contains("SOCKS5 proxy proxy.example.com:1080 (user alice)"),
        "{:?}",
        s.notes
    );
}

#[test]
fn telnet_maps_host_and_custom_port() {
    let sessions = preview(FULL_INI);
    let s = by_name(&sessions, "Old switch");
    assert_eq!(s.connection_type.as_deref(), Some("telnet"));
    assert_eq!(setting(s, "host"), "192.0.2.10");
    assert_eq!(setting(s, "port"), 2323);
    assert_eq!(s.target, "192.0.2.10:2323");
}

#[test]
fn serial_maps_port_speed_and_line_settings() {
    let sessions = preview(FULL_INI);
    let s = by_name(&sessions, "Console (USB)");
    assert_eq!(s.connection_type.as_deref(), Some("serial"));
    assert_eq!(setting(s, "port"), "COM7");
    assert_eq!(setting(s, "baudRate"), "9600");
    assert_eq!(setting(s, "dataBits"), "8");
    assert_eq!(setting(s, "parity"), "even");
    assert_eq!(setting(s, "stopBits"), "2");
    assert_eq!(setting(s, "flowControl"), "hardware");
    assert_eq!(s.target, "COM7 @ 9600");
}

#[test]
fn serial_without_description_falls_back_to_name_and_flags_odd_speed() {
    let ini = "[Bookmarks]\nSubRep=\nCOM12=#131#8%0%7%3%0%0%1%2#MobaFont#0# #-1\n";
    let s = &preview(ini)[0];
    assert_eq!(setting(s, "port"), "COM12");
    // `7` is a legacy index, not a speed: default + note.
    assert_eq!(setting(s, "baudRate"), "115200");
    assert_eq!(setting(s, "flowControl"), "software");
    assert_eq!(s.notes.len(), 1, "{:?}", s.notes);
}

#[test]
fn serial_without_any_port_is_skipped() {
    let ini = "[Bookmarks]\nSubRep=\nNo port=#131#8%0%1115200%3%0%0%1%2%#MobaFont#0# #-1\n";
    let s = &preview(ini)[0];
    assert!(s.connection_type.is_none());
    assert!(s.skip_reason.as_deref().unwrap().contains("serial port"));
}

#[test]
fn rdp_vnc_ftp_sftp_shell_and_wsl_map_to_their_types() {
    let sessions = preview(FULL_INI);
    let rdp = by_name(&sessions, "Desk RDP");
    assert_eq!(rdp.connection_type.as_deref(), Some("rdp"));
    assert_eq!(rdp.target, "carol@192.0.2.20:3390");
    assert!(rdp.notes.is_empty(), "{:?}", rdp.notes);

    let vnc = by_name(&sessions, "Viewer");
    assert_eq!(vnc.connection_type.as_deref(), Some("vnc"));
    assert_eq!(setting(vnc, "port"), 5901);
    assert!(setting(vnc, "useSshTunnel").is_null());
    assert!(vnc.notes.is_empty(), "{:?}", vnc.notes);

    let ftp = by_name(&sessions, "Files");
    assert_eq!(ftp.connection_type.as_deref(), Some("ftp"));
    assert_eq!(ftp.target, "dave@ftp.example.com:2121");

    let sftp = by_name(&sessions, "Secure files");
    assert_eq!(sftp.connection_type.as_deref(), Some("ssh"));
    assert_eq!(sftp.notes.len(), 1);

    let shell = by_name(&sessions, "Bash here");
    assert_eq!(shell.connection_type.as_deref(), Some("local"));
    let dir = Path::new("/home/alice").join("Documents").join("projects");
    assert_eq!(
        setting(shell, "startingDirectory"),
        &json!(dir.to_string_lossy())
    );

    let wsl = by_name(&sessions, "Fedora box");
    assert_eq!(wsl.connection_type.as_deref(), Some("wsl"));
    assert_eq!(setting(wsl, "distribution"), "Fedora-Remix-41");
}

#[test]
fn unsupported_and_unknown_types_are_skipped_with_a_reason() {
    let sessions = preview(FULL_INI);
    for name in ["Docs site", "Xdmcp box"] {
        let s = by_name(&sessions, name);
        assert!(s.connection_type.is_none(), "{name}");
        assert!(s.settings.is_none(), "{name}");
        assert!(s.skip_reason.is_some(), "{name}");
    }
    assert_eq!(by_name(&sessions, "Docs site").session_type, "Browser");
    let unknown = preview("[Bookmarks]\nSubRep=\nFuture=#1#99%x#\n");
    assert_eq!(unknown[0].session_type, "Type 99");
    assert!(unknown[0].skip_reason.is_some());
}

#[test]
fn short_truncated_and_hostless_lines_are_skipped_not_dropped() {
    let ini = "[Bookmarks]\nSubRep=\nTruncated=#109\nEmpty=\nNo host=#109#0%%22%root\nShort wsl=#151#14\n";
    let sessions = preview(ini);
    assert_eq!(sessions.len(), 4);
    assert!(by_name(&sessions, "Truncated").skip_reason.is_some());
    assert!(by_name(&sessions, "Empty").skip_reason.is_some());
    assert!(by_name(&sessions, "No host").skip_reason.is_some());
    // A 3-field WSL line still imports, with a note to pick the distribution.
    let wsl = by_name(&sessions, "Short wsl");
    assert_eq!(wsl.connection_type.as_deref(), Some("wsl"));
    assert_eq!(wsl.notes.len(), 1);
}

#[test]
fn odd_and_duplicate_names_are_kept_verbatim() {
    let ini = "[Bookmarks]\nSubRep=\nweb (1)=#109#0%10.0.0.7%22%a#\nweb (1)=#109#0%10.0.0.8%22%a#\n  spaced name  =#98#1%10.0.0.9%23#\nA__EQUAL__B=#98#1%10.0.0.10%23#\n";
    let sessions = preview(ini);
    assert_eq!(sessions[0].name, "web (1)");
    assert_eq!(sessions[1].name, "web (1)");
    assert_ne!(sessions[0].key, sessions[1].key);
    assert_eq!(sessions[2].name, "spaced name");
    assert_eq!(sessions[3].name, "A=B");
}

#[test]
fn bom_crlf_and_value_leading_space_are_tolerated() {
    let ini = "\u{FEFF}[Bookmarks]\r\nSubRep=\r\nSpaced= #109#0%10.0.0.11%22%root#\r\n";
    let preview = preview_from_bytes(ini.as_bytes(), "x", &env());
    assert_eq!(preview.encoding, "utf-8");
    assert_eq!(preview.sessions[0].target, "root@10.0.0.11");
}

#[test]
fn windows_1252_bytes_are_decoded() {
    // "Büro €" in Windows-1252: ü = 0xFC, € = 0x80 — invalid as UTF-8.
    let bytes =
        b"[Bookmarks]\r\nSubRep=Ger\xE4te\r\nB\xFCro \x80=#109#0%10.0.0.12%22%x#\r\n".to_vec();
    let (text, encoding) = decode(&bytes);
    assert_eq!(encoding, SourceEncoding::Windows1252);
    assert!(text.contains("Büro €"));
    let preview = preview_from_bytes(&bytes, "x", &env());
    assert_eq!(preview.encoding, "windows-1252");
    assert_eq!(preview.sessions[0].name, "Büro €");
    assert_eq!(preview.sessions[0].folder_path, ["Geräte"]);
}

#[test]
fn utf8_non_ascii_names_stay_utf8() {
    let (text, encoding) = decode("[Bookmarks]\nSubRep=Ünïcode\n".as_bytes());
    assert_eq!(encoding, SourceEncoding::Utf8);
    assert!(text.contains("Ünïcode"));
}

#[test]
fn escape_tokens_are_decoded() {
    assert_eq!(
        decode_escapes("a__PTVIRG__b__DIEZE__c__PERCENT__d__POURCENT__e__DBLQUO__f__PIPE__g"),
        "a;b#c%d%e\"f|g"
    );
    assert_eq!(decode_escapes("plain"), "plain");
}

#[test]
fn sections_are_case_insensitive_and_partial_exports_keep_their_root_folder() {
    let ini = "[bookmarks]\nSubRep=Shared\nOne=#98#1%10.0.0.13%23#\n[Bookmarks_x]\nTwo=#98#1%10.0.0.14%23#\n";
    let sessions = parse_bookmarks(ini);
    assert_eq!(sessions.len(), 1, "[Bookmarks_x] is not a bookmark section");
    assert_eq!(sessions[0].folder_path, ["Shared"]);
}

#[test]
fn placeholders_expand_or_report() {
    let e = env();
    let docs = expand_path("_MyDocuments_\\keys\\k", &e);
    assert_eq!(
        docs.path,
        Path::new("/home/alice")
            .join("Documents")
            .join("keys")
            .join("k")
            .to_string_lossy()
    );
    assert_eq!(expand_path("_CurrentDrive_:\\k", &e).path, "D:\\k");
    let plain = expand_path("/etc/ssh/key", &e);
    assert_eq!(plain.path, "/etc/ssh/key");
    assert!(plain.unresolved.is_none());

    let none = PlaceholderEnv::default();
    let unresolved = expand_path("_ProfileDir_\\k", &none);
    assert_eq!(unresolved.path, "_ProfileDir_\\k");
    assert_eq!(unresolved.unresolved.as_deref(), Some("_ProfileDir_"));
    let drive = expand_path("_CurrentDrive_:\\k", &none);
    assert_eq!(drive.unresolved.as_deref(), Some("_CurrentDrive_"));
    let unknown = expand_path("_SomethingNew_\\k", &e);
    assert_eq!(unknown.unresolved.as_deref(), Some("_SomethingNew_"));
}

#[test]
fn unresolved_key_placeholder_is_noted_on_the_session() {
    let ini = "[Bookmarks]\nSubRep=\nK=#109#0%10.0.0.15%22%x%%-1%-1%%%%%0%0%0%_Weird_\\k%#\n";
    let s = &preview(ini)[0];
    assert_eq!(setting(s, "keyPath"), "_Weird_\\k");
    assert_eq!(s.notes.len(), 1);
}

#[test]
fn preview_file_reads_from_disk_and_rejects_missing_paths() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("sessions.mxtsessions");
    std::fs::write(&path, FULL_INI).unwrap();
    let preview = preview_file(&path, &env(), &NothingTrusted).expect("preview");
    assert_eq!(preview.sessions.len(), 11);
    assert!(preview_file(&dir.path().join("missing.ini"), &env(), &NothingTrusted).is_err());
    assert!(
        preview_file(dir.path(), &env(), &NothingTrusted).is_err(),
        "a directory is not a file"
    );
}

#[test]
fn empty_or_non_moba_file_yields_no_sessions() {
    assert!(preview("").is_empty());
    assert!(preview("[Misc]\nA=1\n").is_empty());
    assert!(preview("not an ini at all").is_empty());
}

// ── Discovery ────────────────────────────────────────────────────────────────

fn discovery_env() -> DiscoveryEnv {
    let profile = PathBuf::from("/users/alice");
    DiscoveryEnv {
        app_data: Some(profile.join("AppData").join("Roaming")),
        user_profile: Some(profile.clone()),
        documents: Some(profile.join("Documents")),
    }
}

#[test]
fn candidate_paths_cover_installed_and_documents_locations_without_duplicates() {
    let profile = PathBuf::from("/users/alice");
    let paths = candidate_paths(&discovery_env());
    let ini = |base: PathBuf| base.join("MobaXterm").join("MobaXterm.ini");
    assert_eq!(
        paths,
        vec![
            (
                ini(profile.join("AppData").join("Roaming")),
                CandidateSource::Installed
            ),
            (ini(profile.join("Documents")), CandidateSource::Documents),
            (
                ini(profile.join("OneDrive").join("Documents")),
                CandidateSource::Documents
            ),
        ]
    );
}

#[test]
fn candidate_paths_tolerate_missing_environment() {
    assert!(candidate_paths(&DiscoveryEnv::default()).is_empty());
    let only_profile = DiscoveryEnv {
        user_profile: Some(PathBuf::from("/p")),
        ..DiscoveryEnv::default()
    };
    assert_eq!(candidate_paths(&only_profile).len(), 2);
}

#[test]
fn existing_candidates_keeps_only_present_files() {
    let dir = tempfile::TempDir::new().unwrap();
    let env = DiscoveryEnv {
        app_data: Some(dir.path().join("Roaming")),
        user_profile: Some(dir.path().join("profile")),
        documents: None,
    };
    let installed = dir.path().join("Roaming").join("MobaXterm");
    std::fs::create_dir_all(&installed).unwrap();
    std::fs::write(installed.join("MobaXterm.ini"), "[Bookmarks]\n").unwrap();
    let found = existing_candidates(candidate_paths(&env), Path::is_file);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].1, CandidateSource::Installed);
    assert_eq!(found[0].1.label(), "installed");
}

#[cfg(not(windows))]
#[test]
fn discovery_is_empty_off_windows() {
    assert!(super::discovery::discover().is_empty());
}
