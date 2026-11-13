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

// ── POSIX custom paths (#5532) ──────────────────────────────────────────

#[test]
fn every_form_of_the_posix_default_is_recognized() {
    for path in [
        ".local/bin/termihub-agent",
        "~/.local/bin/termihub-agent",
        "$HOME/.local/bin/termihub-agent",
        "  ~/.local/bin/termihub-agent ",
    ] {
        assert!(is_posix_default_install_path(path), "{path}");
    }
    for path in ["/opt/termihub-agent", "~/bin/termihub-agent", ""] {
        assert!(!is_posix_default_install_path(path), "{path}");
    }
}

#[test]
fn only_a_custom_posix_agent_path_is_an_update_target() {
    assert_eq!(
        custom_posix_agent_path(Some("/opt/termihub-agent")),
        Some("/opt/termihub-agent")
    );
    assert_eq!(
        custom_posix_agent_path(Some("~/bin/termihub-agent")),
        Some("~/bin/termihub-agent")
    );
    for path in [
        None,
        Some(""),
        Some("  "),
        Some(POSIX_DEFAULT),
        Some(ENCODED),
    ] {
        assert_eq!(custom_posix_agent_path(path), None, "{path:?}");
    }
}

#[test]
fn shell_safe_posix_paths_are_accepted() {
    for path in [
        "/opt/termihub-agent",
        "~/bin/termihub-agent",
        "$HOME/tools/termihub_agent-1.2+x",
        "bin/termihub-agent",
    ] {
        assert!(validate_posix_agent_path(path).is_ok(), "{path}");
    }
}

#[test]
fn shell_unsafe_posix_paths_are_refused() {
    for path in [
        "",
        "/opt/my agent",
        "/opt/a;rm -rf ~",
        "/opt/$(id)",
        "/opt/'x'",
        "/opt/x\"",
        "/opt/*",
        "/opt/dir/",
        "-rf",
        "~root/agent",
        "/opt/a`id`",
        "/opt/a\nb",
    ] {
        assert!(validate_posix_agent_path(path).is_err(), "{path:?}");
    }
}

#[test]
fn termihub_agent_version_output_is_recognized() {
    assert!(is_termihub_agent_version_output("termihub-agent 0.1.0"));
    assert!(is_termihub_agent_version_output(
        "\ntermihub-agent 0.2.0-beta.1 (branch: x)\n"
    ));
    for output in ["", "ls (GNU coreutils) 9.4", "0.1.0", "termihub-agent"] {
        assert!(!is_termihub_agent_version_output(output), "{output:?}");
    }
}

#[test]
fn an_explicit_posix_install_is_stored_only_over_a_replaceable_path() {
    for current in [None, Some(""), Some(POSIX_DEFAULT), Some(ENCODED)] {
        assert_eq!(
            adopted_agent_path(current, "/srv/termihub-agent", POSIX_DEFAULT).as_deref(),
            Some("/srv/termihub-agent"),
            "{current:?}"
        );
    }
    assert_eq!(
        adopted_agent_path(
            Some("/opt/termihub-agent"),
            "/srv/termihub-agent",
            POSIX_DEFAULT
        ),
        None,
        "a user-set custom path is kept"
    );
    assert_eq!(
        adopted_agent_path(
            Some("/opt/termihub-agent"),
            "/opt/termihub-agent",
            POSIX_DEFAULT
        ),
        None,
        "an update over the custom path changes nothing"
    );
}

#[test]
fn the_setup_wizard_path_is_stored_when_it_differs() {
    assert_eq!(
        setup_agent_path(None, "/opt/termihub-agent").as_deref(),
        Some("/opt/termihub-agent")
    );
    assert_eq!(
        setup_agent_path(Some("/usr/local/bin/termihub-agent"), "/opt/termihub-agent").as_deref(),
        Some("/opt/termihub-agent"),
        "the path chosen in the wizard is what the connect must run"
    );
    assert_eq!(
        setup_agent_path(Some("/opt/termihub-agent"), POSIX_DEFAULT).as_deref(),
        Some(POSIX_DEFAULT),
        "moving back to the default is stored too"
    );
    assert_eq!(
        setup_agent_path(Some(ENCODED), POSIX_DEFAULT).as_deref(),
        Some(POSIX_DEFAULT)
    );
}

#[test]
fn the_setup_wizard_path_is_not_stored_when_it_changes_nothing() {
    for (current, chosen) in [
        (None, POSIX_DEFAULT),
        (Some(""), "~/.local/bin/termihub-agent"),
        (Some(".local/bin/termihub-agent"), POSIX_DEFAULT),
        (Some("/opt/termihub-agent"), "/opt/termihub-agent"),
        (Some("/opt/termihub-agent"), "  "),
    ] {
        assert_eq!(
            setup_agent_path(current, chosen),
            None,
            "{current:?} {chosen:?}"
        );
    }
}
