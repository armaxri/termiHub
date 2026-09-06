use super::{classify_info_flag, help_text, version_line, InfoFlag};

fn to_args(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}

#[test]
fn classify_version_long_and_short() {
    assert_eq!(
        classify_info_flag(&to_args(&["--version"])),
        Some(InfoFlag::Version)
    );
    assert_eq!(
        classify_info_flag(&to_args(&["-V"])),
        Some(InfoFlag::Version)
    );
}

#[test]
fn classify_help_long_and_short() {
    assert_eq!(
        classify_info_flag(&to_args(&["--help"])),
        Some(InfoFlag::Help)
    );
    assert_eq!(classify_info_flag(&to_args(&["-h"])), Some(InfoFlag::Help));
}

#[test]
fn classify_non_info_args_is_none() {
    // No args → normal launch.
    assert_eq!(classify_info_flag(&[]), None);
    // Known launch flags must not be captured as info flags.
    assert_eq!(classify_info_flag(&to_args(&["--workspace", "w"])), None);
    assert_eq!(classify_info_flag(&to_args(&["--list-workspaces"])), None);
    // Subcommands own their own flags (`spawn --help` is spawn's help).
    assert_eq!(classify_info_flag(&to_args(&["spawn", "--help"])), None);
    assert_eq!(
        classify_info_flag(&to_args(&["install-shell-integration"])),
        None
    );
}

#[test]
fn classify_only_inspects_first_arg() {
    // A trailing `--version` after a launch flag is not a top-level info request.
    assert_eq!(
        classify_info_flag(&to_args(&["--workspace", "--version"])),
        None
    );
}

#[test]
fn version_line_reports_crate_version() {
    let line = version_line();
    assert!(
        line.contains(env!("CARGO_PKG_VERSION")),
        "version line {line:?} should contain the crate version"
    );
}

#[test]
fn help_text_lists_real_flags_and_commands() {
    let help = help_text();
    for token in [
        "--version",
        "--help",
        "--list-workspaces",
        "--workspace",
        "spawn",
    ] {
        assert!(
            help.contains(token),
            "help text should mention {token:?}, got:\n{help}"
        );
    }
}
