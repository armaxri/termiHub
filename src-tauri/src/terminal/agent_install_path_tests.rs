//! The agent path a Windows deploy/setup records after installing (#5522):
//! the per-shell launch form, and when it may replace the stored path.

use super::*;

const POSIX_DEFAULT: &str = "~/.local/bin/termihub-agent";
const RESOLVED: &str = r"C:\Users\me\AppData\Local\termiHub\agent\termihub-agent.exe";
const ENCODED: &str = "C:/Users/me/AppData/Local/termiHub/agent/termihub-agent.exe";

#[test]
fn native_install_path_takes_the_resolved_path_after_a_banner() {
    let output = format!("Welcome to the host\r\n{RESOLVED}\r\n\r\n");
    for shell in [WindowsShell::Cmd, WindowsShell::PowerShell] {
        assert_eq!(native_install_path(shell, Some(&output)), RESOLVED);
    }
}

#[test]
fn native_install_path_falls_back_to_the_plan_form_of_each_shell() {
    for output in [None, Some(""), Some("  \r\n")] {
        assert_eq!(
            native_install_path(WindowsShell::Cmd, output),
            r"%LOCALAPPDATA%\termiHub\agent\termihub-agent.exe"
        );
        assert_eq!(
            native_install_path(WindowsShell::PowerShell, output),
            r"$env:LOCALAPPDATA\termiHub\agent\termihub-agent.exe"
        );
    }
}

#[test]
fn managed_install_path_matches_every_form() {
    for path in [
        RESOLVED,
        ENCODED,
        r"%LOCALAPPDATA%\termiHub\agent\termihub-agent.exe",
        r"$env:LOCALAPPDATA\termiHub\agent\termihub-agent.exe",
        r"c:\users\me\appdata\local\TERMIHUB\AGENT\TERMIHUB-AGENT.EXE",
    ] {
        assert!(is_managed_windows_install_path(path), "{path}");
    }
    for path in [
        POSIX_DEFAULT,
        "/home/me/termiHub/agent/termihub-agent.exe",
        r"C:\tools\termihub-agent.exe",
        r"C:\Users\me\termiHub\agent\other.exe",
    ] {
        assert!(!is_managed_windows_install_path(path), "{path}");
    }
}

#[test]
fn windows_install_replaces_an_unset_or_default_path() {
    for current in [None, Some(""), Some(POSIX_DEFAULT)] {
        assert_eq!(
            adopted_agent_path(current, ENCODED, POSIX_DEFAULT).as_deref(),
            Some(ENCODED),
            "{current:?}"
        );
    }
}

#[test]
fn windows_install_replaces_an_earlier_managed_path_in_another_form() {
    // The login shell changed from PowerShell to Git Bash: the backslash path
    // no longer launches there, the forward-slash one does.
    assert_eq!(
        adopted_agent_path(Some(RESOLVED), ENCODED, POSIX_DEFAULT).as_deref(),
        Some(ENCODED)
    );
}

#[test]
fn a_matching_path_is_not_rewritten() {
    assert_eq!(
        adopted_agent_path(Some(ENCODED), ENCODED, POSIX_DEFAULT),
        None
    );
}

#[test]
fn a_user_set_custom_path_is_kept() {
    for custom in [r"C:\tools\termihub-agent.exe", "/opt/termihub-agent"] {
        assert_eq!(
            adopted_agent_path(Some(custom), ENCODED, POSIX_DEFAULT),
            None,
            "{custom}"
        );
    }
}

#[test]
fn a_posix_install_never_changes_the_stored_path() {
    for current in [None, Some(POSIX_DEFAULT), Some(RESOLVED)] {
        assert_eq!(
            adopted_agent_path(current, "~/.local/bin/termihub-agent", POSIX_DEFAULT),
            None
        );
        assert_eq!(adopted_agent_path(current, "", POSIX_DEFAULT), None);
    }
}
