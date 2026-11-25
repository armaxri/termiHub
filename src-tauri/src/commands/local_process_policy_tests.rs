//! The rule of what a "Run local process" step may start (#5994).

use super::*;
#[cfg(unix)]
use tempfile::TempDir;

fn settings(list: &[&str]) -> AppSettings {
    AppSettings {
        experimental_features_enabled: Some(true),
        workflow_local_process_enabled: true,
        workflow_local_process_allowlist: list.iter().map(|s| s.to_string()).collect(),
        ..AppSettings::default()
    }
}

/// A command of the user's own automations.
fn own(_: &Path) -> Standing {
    Standing::Own
}

fn env() -> SearchEnv {
    SearchEnv {
        path: Some("/usr/bin:/bin".into()),
        cwd: Some("/".into()),
        windows: false,
    }
}

#[cfg(unix)]
fn windows() -> SearchEnv {
    SearchEnv {
        windows: true,
        ..env()
    }
}

#[cfg(unix)]
fn executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
fn listed(list: &[&str], program: &str, env: &SearchEnv) -> bool {
    judge(Some(&settings(list)), program, env)
        .unwrap()
        .listed
        .is_ok()
}

#[test]
#[cfg(unix)]
fn existing_lists_keep_working() {
    // What the window matched until now: the program as written.
    assert!(listed(&["/usr/bin/true"], "/usr/bin/true", &env()));
    assert!(listed(&["true"], "true", &env()));
    assert!(
        listed(&["other", " true "], "true", &env()),
        "the start trimmed too"
    );
    assert!(listed(&["true"], " true ", &env()));
}

#[test]
#[cfg(unix)]
fn a_resolved_path_on_the_list_allows_the_bare_name_and_pins_it() {
    let dir = TempDir::new().unwrap();
    let (a, b) = (dir.path().join("a"), dir.path().join("b"));
    for d in [&a, &b] {
        std::fs::create_dir(d).unwrap();
        executable(&d.join("tool"));
    }
    let entry = b.join("tool");
    let entry = entry.to_str().unwrap();
    let with_path = |dirs: &[&Path]| SearchEnv {
        path: Some(std::env::join_paths(dirs).unwrap()),
        ..env()
    };
    assert!(listed(&[entry], "tool", &with_path(&[&b])));
    // A program planted earlier on PATH is another file: not allowed.
    let planted = with_path(&[&a, &b]);
    assert!(!listed(&[entry], "tool", &planted));
    // An old bare entry is the name only: it is not pinned (documented).
    assert!(listed(&["tool"], "tool", &planted));
}

#[test]
#[cfg(unix)]
fn no_other_spelling_of_an_allowed_file_matches() {
    let dir = TempDir::new().unwrap();
    let tool = dir.path().join("tool");
    executable(&tool);
    std::os::unix::fs::symlink(&tool, dir.path().join("link")).unwrap();
    std::fs::hard_link(&tool, dir.path().join("hard")).unwrap();
    std::fs::create_dir(dir.path().join("sub")).unwrap();
    let base = dir.path().display().to_string();
    let entry = format!("{base}/tool");
    assert!(listed(&[&entry], &entry, &env()));
    for other in [
        format!("{base}/sub/../tool"),
        format!("{base}/./tool"),
        format!("{base}//tool"),
        format!("{base}/link"),
        format!("{base}/hard"),
    ] {
        assert!(!listed(&[&entry], &other, &env()), "{other}");
    }
    // Another case is another name, also where the file system ignores it.
    if let Ok(judged) = judge(Some(&settings(&[&entry])), &format!("{base}/TOOL"), &env()) {
        assert!(judged.listed.is_err());
    }
    // An allowed link does not allow what it points to (a multi-call binary).
    let link = format!("{base}/link");
    assert!(listed(&[&link], &link, &env()));
    assert!(!listed(&[&link], &entry, &env()));
    // No prefix, pattern or argument in an entry.
    for entry in [
        format!("{base}/*"),
        format!("{base}/"),
        base.clone(),
        format!("{base}/tool -x"),
        String::new(),
        " ".into(),
    ] {
        assert!(
            !listed(&[&entry], &format!("{base}/tool"), &env()),
            "{entry}"
        );
    }
}

#[test]
#[cfg(unix)]
fn a_bare_name_is_never_found_in_the_working_directory() {
    let dir = TempDir::new().unwrap();
    executable(&dir.path().join("planted"));
    for path in [
        "",
        ":",
        ":/usr/bin",
        "/usr/bin:",
        ".",
        "relative:/usr/bin",
        "~/bin",
    ] {
        let env = SearchEnv {
            path: Some(path.into()),
            cwd: Some(dir.path().to_path_buf()),
            windows: false,
        };
        assert!(
            judge(Some(&settings(&["planted"])), "planted", &env).is_err(),
            "{path:?}"
        );
    }
    let no_path = SearchEnv {
        path: None,
        ..env()
    };
    assert!(judge(Some(&settings(&["true"])), "true", &no_path).is_err());
}

/// A relative entry of `PATH` is skipped, not only refused: it must not hide the
/// program that is really on `PATH`.
#[test]
#[cfg(unix)]
fn a_relative_path_entry_does_not_hide_the_real_program() {
    let dir = TempDir::new().unwrap();
    let (planted, real) = (dir.path().join("planted"), dir.path().join("real"));
    for d in [&planted, &real] {
        std::fs::create_dir(d).unwrap();
        executable(&d.join("tool"));
    }
    // The planted directory, relative to the working directory of this process.
    let up = std::env::current_dir().unwrap().components().count() - 1;
    let relative = format!(
        "{}{}",
        "../".repeat(up),
        &planted.display().to_string()[1..]
    );
    assert!(Path::new(&relative).join("tool").is_file());
    let env = SearchEnv {
        path: Some(format!("{relative}:{}", real.display()).into()),
        ..env()
    };
    let judged = judge(Some(&settings(&["tool"])), "tool", &env).unwrap();
    assert_eq!(judged.program.path, real.join("tool"));
}

#[test]
#[cfg(unix)]
fn a_relative_path_is_resolved_once_and_shown_in_full() {
    let dir = TempDir::new().unwrap();
    executable(&dir.path().join("tool"));
    let env = SearchEnv {
        cwd: Some(dir.path().to_path_buf()),
        ..env()
    };
    let full = dir.path().join("tool");
    let judged = judge(Some(&settings(&[full.to_str().unwrap()])), "./tool", &env).unwrap();
    assert_eq!(judged.program.path, full);
    assert!(judged.listed.is_ok(), "the resolved path is on the list");
    assert!(
        listed(&["./tool"], "./tool", &env),
        "an old entry keeps working"
    );
    let elsewhere = SearchEnv {
        cwd: Some("/".into()),
        ..env.clone()
    };
    assert!(judge(Some(&settings(&["./tool"])), "./tool", &elsewhere).is_err());
    let unknown = SearchEnv { cwd: None, ..env };
    assert!(judge(Some(&settings(&["./tool"])), "./tool", &unknown).is_err());
}

#[test]
#[cfg(unix)]
fn only_an_existing_file_is_a_program() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("plain"), "x").unwrap();
    std::fs::create_dir(dir.path().join("folder")).unwrap();
    let folder = dir.path().join("folder").display().to_string();
    let missing = dir.path().join("missing").display().to_string();
    for program in [
        folder.as_str(),
        missing.as_str(),
        "no-such-program-here",
        ".",
        "..",
        "/",
    ] {
        let refused = judge(Some(&settings(&[program])), program, &env());
        assert!(refused.is_err(), "{program}");
    }
    // A bare name finds only what can be executed.
    let env = SearchEnv {
        path: Some(dir.path().into()),
        ..env()
    };
    assert!(judge(Some(&settings(&["plain"])), "plain", &env).is_err());
}

/// A Windows app execution alias cannot be followed by reading it; a dangling link
/// stands in for one.
#[test]
#[cfg(unix)]
fn a_windows_app_alias_is_a_program() {
    let dir = TempDir::new().unwrap();
    let alias = dir.path().join("alias.exe");
    std::os::unix::fs::symlink(dir.path().join("only-the-os-knows"), &alias).unwrap();
    std::fs::create_dir(dir.path().join("folder.exe")).unwrap();
    assert!(is_program_file(&alias, true));
    assert!(
        !is_program_file(&alias, false),
        "elsewhere a dangling link is nothing"
    );
    for windows in [true, false] {
        assert!(!is_program_file(&dir.path().join("folder.exe"), windows));
        assert!(!is_program_file(&dir.path().join("missing.exe"), windows));
    }
}

#[test]
fn names_that_do_not_read_as_what_they_are_are_refused() {
    for (name, why) in [
        ("", "no program"),
        ("   ", "no program"),
        ("/usr/bin/true\0", "invisible"),
        ("/usr/bin/a\nb", "invisible"),
        ("/usr/bin/a\u{1b}[2K", "invisible"),
        ("/usr/bin/\u{202e}hs", "invisible"),
        ("/usr/bin/ma\u{200b}ke", "invisible"),
        ("ma\u{feff}ke", "invisible"),
    ] {
        // Also when it is on the list, and when it was approved.
        let reason =
            authorize(Some(&settings(&[name])), name, Some(name), &env(), own).unwrap_err();
        assert!(reason.contains(why), "{name:?}: {reason}");
        assert!(!reason.contains('\u{202e}'), "the name is not shown");
    }
}

#[test]
fn windows_names_that_mean_another_file_are_refused() {
    for name in [
        r"C:tool.exe",
        r"c:",
        r"\tool.exe",
        "/tool.exe",
        r"\\?\C:\x\tool.exe",
        r"\\.\C:\x\tool.exe",
        "//?/C:/x/tool.exe",
        r"C:\x\tool.exe.",
        r"C:\x\tool.exe. .",
        r"C:\x\build.bat .",
        r"C:\x.\tool.exe",
        r"C:\x \tool.exe",
        "tool.",
        r"C:\x\tool.exe:stream",
        "tool.exe:stream",
        r#"C:\x\a"b.exe"#,
        r"C:\x\*.exe",
        "a|b",
        "a>b",
    ] {
        assert!(ambiguous(name, true).is_some(), "{name}");
    }
    for name in [
        r"C:\Program Files\x\tool.exe",
        "C:/x/tool.exe",
        r"C:\x\..\tool.exe",
        r"\\server\share\tool.exe",
        "tool",
        "tool.exe",
        r".\tool.exe",
        r"..\tool.exe",
        r"C:\x\build.cmd",
    ] {
        assert_eq!(ambiguous(name, true), None, "{name}");
    }
    for name in [
        r"\\?\C:\x\tool.exe",
        r"\\.\C:\x\tool.exe",
        "//?/C:/x/tool.exe",
    ] {
        assert_eq!(
            ambiguous(name, true),
            Some("device paths are not supported")
        );
    }
    // Unix has no such forms: these are ordinary names there.
    for name in ["C:tool", r"\tool", "tool.", "a|b", "/x/tool ."] {
        assert_eq!(ambiguous(name, false), None, "{name}");
    }
}

/// A name without an extension is an `.exe` there, never a script that `PATHEXT`
/// would also offer, nor a file without an extension.
#[test]
#[cfg(unix)]
fn a_windows_name_without_an_extension_is_an_exe_only() {
    let dir = TempDir::new().unwrap();
    for file in ["tool", "tool.bat", "tool.cmd", "tool.com"] {
        executable(&dir.path().join(file));
    }
    let env = SearchEnv {
        path: Some(dir.path().into()),
        ..windows()
    };
    assert!(judge(Some(&settings(&["tool"])), "tool", &env).is_err());
    executable(&dir.path().join("tool.exe"));
    let judged = judge(Some(&settings(&["tool"])), "tool", &env).unwrap();
    assert_eq!(judged.program.path, dir.path().join("tool.exe"));
    assert!(judged.listed.is_ok());
}

#[test]
#[cfg(unix)]
fn every_switch_is_required_also_for_an_approved_program() {
    let p = "/usr/bin/true";
    for (experimental, enabled, names) in [
        (None, true, "Allow experimental features"),
        (Some(false), true, "Allow experimental features"),
        (Some(true), false, "Allow automations to run local programs"),
    ] {
        let off = AppSettings {
            experimental_features_enabled: experimental,
            workflow_local_process_enabled: enabled,
            ..settings(&[p])
        };
        let reason = authorize(Some(&off), p, Some(p), &env(), own).unwrap_err();
        assert!(reason.contains(names) && reason.contains(p), "{reason}");
    }
    assert!(authorize(None, p, Some(p), &env(), own)
        .unwrap_err()
        .contains("cannot be read"));
    assert!(authorize(Some(&settings(&[p])), p, None, &env(), own).is_ok());
}

#[test]
#[cfg(unix)]
fn a_refusal_names_the_program_the_file_and_where_to_allow_it() {
    let reason = authorize(Some(&settings(&[])), "true", None, &env(), own).unwrap_err();
    for part in [
        "\"true\"",
        "/usr/bin/true",
        "Always allow",
        "Settings ▸ Security",
    ] {
        assert!(reason.contains(part), "{part}: {reason}");
    }
}

#[test]
#[cfg(unix)]
fn an_approval_is_for_one_file() {
    let dir = TempDir::new().unwrap();
    let (a, b) = (dir.path().join("a"), dir.path().join("b"));
    for d in [&a, &b] {
        std::fs::create_dir(d).unwrap();
        executable(&d.join("tool"));
    }
    let shown = SearchEnv {
        path: Some(b.clone().into()),
        ..env()
    };
    let LocalProcessCheck::Ask { path, .. } = check(Some(&settings(&[])), "tool", &shown, own)
    else {
        panic!("not listed: ask");
    };
    let ok = authorize(Some(&settings(&[])), "tool", Some(&path), &shown, own).unwrap();
    assert_eq!(ok.path, b.join("tool"));
    assert_eq!(ok.bare_name.as_deref(), Some("tool"));
    // PATH changed while the question was open.
    let now = SearchEnv {
        path: Some(std::env::join_paths([&a, &b]).unwrap()),
        ..env()
    };
    let reason = authorize(Some(&settings(&[])), "tool", Some(&path), &now, own).unwrap_err();
    assert!(reason.contains("was approved"), "{reason}");
    // The approval of one program is none for another.
    assert!(authorize(
        Some(&settings(&[])),
        "/usr/bin/true",
        Some(&path),
        &shown,
        own
    )
    .is_err());
}

#[test]
#[cfg(unix)]
fn the_verdict_tells_the_frontend_what_to_do() {
    let allowed = check(Some(&settings(&["true"])), "true", &env(), own);
    assert_eq!(
        allowed,
        LocalProcessCheck::Allowed {
            path: "/usr/bin/true".into()
        }
    );
    let refused = check(None, "true", &env(), own);
    assert!(matches!(refused, LocalProcessCheck::Refused { .. }));
    let ask = serde_json::to_value(check(Some(&settings(&[])), "true", &env(), own)).unwrap();
    assert_eq!(ask["status"], "ask");
    assert_eq!(ask["path"], "/usr/bin/true");
    assert!(ask["reason"].as_str().unwrap().contains("true"));
}

/// The real thing on Windows: a bare name is the `.exe` on `PATH`, matched as
/// written or by its full path, and nothing else of it matches.
#[test]
#[cfg(windows)]
fn on_windows_a_bare_name_is_the_exe_on_path() {
    let env = SearchEnv::current();
    let judged = judge(Some(&settings(&["cmd"])), "cmd", &env).unwrap();
    assert!(judged.listed.is_ok());
    assert!(judged.program.path.is_absolute());
    let full = judged.program.path.to_str().unwrap().to_string();
    assert!(full.to_lowercase().ends_with("cmd.exe"));
    let by_path = judge(Some(&settings(&[&full])), "cmd", &env).unwrap();
    assert!(by_path.listed.is_ok());
    for other in [
        format!("{full}."),
        format!("{full} ."),
        format!("{full}::$DATA"),
        format!(r"\\?\{full}"),
    ] {
        assert!(
            judge(Some(&settings(&[&full])), &other, &env).is_err(),
            "{other}"
        );
    }
    // The same file under another spelling opens, but is not the entry.
    let dir = judged.program.path.parent().unwrap().display().to_string();
    for other in [
        full.to_uppercase(),
        full.to_lowercase(),
        format!(r"{dir}\.\cmd.exe"),
    ] {
        let judged = judge(Some(&settings(&[&full])), &other, &env).unwrap();
        assert_eq!(judged.listed.is_ok(), other == full, "{other}");
    }
}

fn unconfirmed(_: &Path) -> Standing {
    Standing::Unconfirmed {
        names: vec!["Outer".into(), "Inner".into()],
    }
}

/// #6019: the list is for the user's own automations.
#[test]
#[cfg(unix)]
fn the_list_does_not_count_for_an_automation_that_is_not_ones_own() {
    let on = settings(&["true", "/usr/bin/true"]);
    let start = |standing: Standing, approved: Option<&str>| {
        authorize(Some(&on), "true", approved, &env(), |_| standing)
    };
    assert!(start(Standing::Own, None).is_ok());
    let reason = start(unconfirmed(Path::new("")), None).unwrap_err();
    assert!(
        reason.contains("“Outer” and “Inner” came from a file"),
        "{reason}"
    );
    assert!(reason.contains("/usr/bin/true"), "{reason}");
    let reason = start(Standing::Unknown, None).unwrap_err();
    assert!(
        reason.contains("does not belong to a saved automation"),
        "{reason}"
    );
    // The user's answer to the question, for this run and this file only.
    for standing in [unconfirmed(Path::new("")), Standing::Unknown] {
        assert!(start(standing.clone(), Some("/usr/bin/true")).is_ok());
        assert!(start(standing, Some("/usr/bin/false")).is_err());
    }
}

/// A confirmed command needs no entry of the list, but both switches.
#[test]
#[cfg(unix)]
fn a_confirmed_command_starts_without_being_listed() {
    let confirmed = |_: &Path| Standing::Confirmed;
    assert!(authorize(Some(&settings(&[])), "true", None, &env(), confirmed).is_ok());
    let off = AppSettings {
        workflow_local_process_enabled: false,
        ..settings(&["true"])
    };
    assert!(authorize(Some(&off), "true", None, &env(), confirmed).is_err());
    let not_experimental = AppSettings {
        experimental_features_enabled: None,
        ..settings(&["true"])
    };
    assert!(authorize(Some(&not_experimental), "true", None, &env(), confirmed).is_err());
}

/// The question is about the file that starts.
#[test]
#[cfg(unix)]
fn the_standing_is_asked_for_the_resolved_file() {
    let mut asked = None;
    let _ = authorize(Some(&settings(&[])), " true ", None, &env(), |path| {
        asked = Some(path.to_path_buf());
        Standing::Own
    });
    assert_eq!(asked.as_deref(), Some(Path::new("/usr/bin/true")));
}

#[test]
#[cfg(unix)]
fn the_check_says_what_always_would_remember() {
    let ask = |program: &str, standing: Standing| {
        serde_json::to_value(check(Some(&settings(&[])), program, &env(), |_| standing)).unwrap()
    };
    let mine = ask("true", Standing::Own);
    assert_eq!(mine["remember"], "program");
    assert_eq!(mine["imported"], serde_json::json!([]));
    assert_eq!(mine["interpreter"], false);
    let theirs = ask("sh", unconfirmed(Path::new("")));
    assert_eq!(theirs["status"], "ask");
    assert_eq!(theirs["remember"], "command");
    assert_eq!(theirs["imported"], serde_json::json!(["Outer", "Inner"]));
    assert_eq!(theirs["interpreter"], true);
    assert_eq!(ask("true", Standing::Unknown)["remember"], "nothing");
    // Listed, and still a question.
    let listed = check(Some(&settings(&["true"])), "true", &env(), unconfirmed);
    assert!(matches!(listed, LocalProcessCheck::Ask { .. }));
    assert!(matches!(
        check(Some(&settings(&[])), "true", &env(), |_| {
            Standing::Confirmed
        }),
        LocalProcessCheck::Allowed { .. }
    ));
}

#[test]
#[cfg(unix)]
fn an_entry_of_the_list_is_judged_by_its_file_or_else_by_its_name() {
    let dir = TempDir::new().unwrap();
    let shell = dir.path().join("dash");
    executable(&shell);
    std::os::unix::fs::symlink(&shell, dir.path().join("mine")).unwrap();
    let in_dir = SearchEnv {
        path: Some(dir.path().into()),
        ..env()
    };
    for (entry, expected) in [
        ("sh", true),
        (" /bin/sh ", true),
        ("/usr/bin/true", false),
        ("python3.99-gone", false),
        ("/gone/python3", true),
        ("gone-tool", false),
    ] {
        assert_eq!(is_interpreter_entry(entry, &env()), expected, "{entry}");
    }
    assert!(is_interpreter_entry("mine", &in_dir));
}
