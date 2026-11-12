//! The encoded PowerShell deploy step for Windows hosts whose login shell is
//! neither `cmd.exe` nor PowerShell (#5449).

use base64::Engine;

use super::*;

/// Decode the script of a [`powershell_encoded_command`] line.
fn decode(command: &str) -> String {
    let encoded = command
        .strip_prefix(&format!(
            "{WINDOWS_POWERSHELL_EXE} -NoLogo -NoProfile -NonInteractive -EncodedCommand "
        ))
        .unwrap_or_else(|| panic!("not an encoded PowerShell command: {command}"));
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .expect("standard base64");
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|p| u16::from_le_bytes(*p))
        .collect();
    String::from_utf16(&units).expect("UTF-16LE")
}

#[test]
fn single_quote_doubles_every_quote_form() {
    assert_eq!(powershell_single_quote("plain"), "'plain'");
    assert_eq!(powershell_single_quote("it's"), "'it''s'");
    assert_eq!(
        powershell_single_quote("a\u{2019}b"),
        "'a\u{2019}\u{2019}b'"
    );
    assert_eq!(powershell_single_quote("$env:X `n"), "'$env:X `n'");
    assert_eq!(powershell_single_quote(""), "''");
}

#[test]
fn encoded_command_round_trips_and_needs_no_shell_quoting() {
    let script = r#"Move-Item -Path "$env:USERPROFILE\a b.exe"; 'it''s' | Out-Null"#;
    let command = powershell_encoded_command(script);
    assert_eq!(decode(&command), script);
    let payload = command.rsplit(' ').next().expect("payload");
    assert!(
        payload
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=')),
        "only base64 reaches the login shell: {payload}"
    );
    assert!(!payload.starts_with('/'), "MSYS would rewrite a leading /");
}

#[test]
fn classify_prefers_native_shells_and_fails_closed_without_powershell() {
    use WindowsDeployShell::*;
    assert_eq!(
        classify_windows_deploy_shell("AMD64", "", None),
        Some(Native(WindowsShell::Cmd))
    );
    assert_eq!(
        classify_windows_deploy_shell("%PROCESSOR_ARCHITECTURE%", "ARM64", None),
        Some(Native(WindowsShell::PowerShell))
    );
    // Git Bash: no `%VAR%` expansion, `$env:VAR` becomes `:VAR`.
    let bash = ("%PROCESSOR_ARCHITECTURE%", ":PROCESSOR_ARCHITECTURE");
    assert_eq!(classify_windows_deploy_shell(bash.0, bash.1, None), None);
    assert_eq!(
        classify_windows_deploy_shell(bash.0, bash.1, Some("Welcome\nAMD64\n")),
        Some(EncodedPowerShell)
    );
    for missing in ["", "bash: powershell.exe: command not found", "AMD64 extra"] {
        assert_eq!(
            classify_windows_deploy_shell(bash.0, bash.1, Some(missing)),
            None,
            "{missing:?}"
        );
    }
}

#[test]
fn encoded_plan_wraps_every_step_of_the_powershell_plan() {
    let native = windows_install_plan(WindowsShell::PowerShell);
    let encoded = windows_deploy_install_plan(WindowsDeployShell::EncodedPowerShell);
    let pairs = [
        (&encoded.install_command, &native.install_command),
        (&encoded.verify_command, &native.verify_command),
        (
            &encoded.backup_verify_command,
            &native.backup_verify_command,
        ),
        (&encoded.backup_command, &native.backup_command),
        (&encoded.restore_command, &native.restore_command),
        (
            &encoded.discard_backup_command,
            &native.discard_backup_command,
        ),
    ];
    for (wrapped, script) in pairs {
        assert_eq!(&decode(wrapped), script);
    }
    let cleanup = encoded.cleanup_stale_command.as_deref().expect("cleanup");
    assert_eq!(
        Some(decode(cleanup)),
        native.cleanup_stale_command,
        "stale-image cleanup is wrapped too"
    );
    assert_eq!(encoded.upload_path, native.upload_path);
    assert_eq!(encoded.install_path, native.install_path);
    assert_eq!(encoded.backup_path, native.backup_path);
}

#[test]
fn native_plans_are_unchanged() {
    for shell in [WindowsShell::Cmd, WindowsShell::PowerShell] {
        assert_eq!(
            windows_deploy_install_plan(WindowsDeployShell::Native(shell)),
            windows_install_plan(shell)
        );
    }
}

#[test]
fn resolve_script_quotes_the_install_location() {
    let script = decode(&encoded_resolve_command());
    assert!(
        script.contains(
            "Join-Path -Path $env:LOCALAPPDATA -ChildPath 'termiHub\\agent\\termihub-agent.exe'"
        ),
        "{script}"
    );
    assert!(script.contains("UTF8"), "{script}");
}

#[test]
fn encoded_install_path_is_returned_with_forward_slashes() {
    let out =
        "banner\r\nC:\\Users\\deploy\\AppData\\Local\\termiHub\\agent\\termihub-agent.exe\r\n";
    assert_eq!(
        parse_encoded_install_path(out).expect("valid"),
        "C:/Users/deploy/AppData/Local/termiHub/agent/termihub-agent.exe"
    );
    // A non-ASCII profile name is fine; the shell passes it through as a word.
    assert!(parse_encoded_install_path(
        r"D:\Users\Jörg\AppData\Local\termiHub\agent\termihub-agent.exe"
    )
    .is_ok());
}

#[test]
fn encoded_install_path_refuses_anything_unexpected() {
    let suffix = r"AppData\Local\termiHub\agent\termihub-agent.exe";
    for bad in [
        String::new(),
        "bash: powershell.exe: command not found".to_string(),
        format!(r"C:\Users\John Doe\{suffix}"),
        format!(r"C:\Users\a$b\{suffix}"),
        format!(r"C:\Users\a;b\{suffix}"),
        format!(r"C:\Users\a`b\{suffix}"),
        format!(r"C:\Users\a'b\{suffix}"),
        format!(r"C:\Users\..\{suffix}"),
        format!(r"\\server\share\{suffix}"),
        format!(r"Users\deploy\{suffix}"),
        format!(r"C:\Users\deploy\x:y\{suffix}"),
        r"C:\Users\deploy\AppData\Local\other\termihub-agent.exe".to_string(),
    ] {
        let err = parse_encoded_install_path(&bad).expect_err(&bad);
        assert!(err.to_string().contains("install path"), "{err}");
    }
}
