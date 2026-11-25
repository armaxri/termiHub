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
        let reason = authorize(Some(&settings(&[name])), name, Some(name), &env()).unwrap_err();
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
        (Some(true), false, "Allow workflows to run local programs"),
    ] {
        let off = AppSettings {
            experimental_features_enabled: experimental,
            workflow_local_process_enabled: enabled,
            ..settings(&[p])
        };
        let reason = authorize(Some(&off), p, Some(p), &env()).unwrap_err();
        assert!(reason.contains(names) && reason.contains(p), "{reason}");
    }
    assert!(authorize(None, p, Some(p), &env())
        .unwrap_err()
        .contains("cannot be read"));
    assert!(authorize(Some(&settings(&[p])), p, None, &env()).is_ok());
}

#[test]
#[cfg(unix)]
fn a_refusal_names_the_program_the_file_and_where_to_allow_it() {
    let reason = authorize(Some(&settings(&[])), "true", None, &env()).unwrap_err();
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
    let LocalProcessCheck::Ask { path, .. } = check(Some(&settings(&[])), "tool", &shown) else {
        panic!("not listed: ask");
    };
    let ok = authorize(Some(&settings(&[])), "tool", Some(&path), &shown).unwrap();
    assert_eq!(ok.path, b.join("tool"));
    assert_eq!(ok.bare_name.as_deref(), Some("tool"));
    // PATH changed while the question was open.
    let now = SearchEnv {
        path: Some(std::env::join_paths([&a, &b]).unwrap()),
        ..env()
    };
    let reason = authorize(Some(&settings(&[])), "tool", Some(&path), &now).unwrap_err();
    assert!(reason.contains("was approved"), "{reason}");
    // The approval of one program is none for another.
    assert!(authorize(Some(&settings(&[])), "/usr/bin/true", Some(&path), &shown).is_err());
}

#[test]
#[cfg(unix)]
fn the_verdict_tells_the_frontend_what_to_do() {
    let allowed = check(Some(&settings(&["true"])), "true", &env());
    assert_eq!(
        allowed,
        LocalProcessCheck::Allowed {
            path: "/usr/bin/true".into()
        }
    );
    let refused = check(None, "true", &env());
    assert!(matches!(refused, LocalProcessCheck::Refused { .. }));
    let ask = serde_json::to_value(check(Some(&settings(&[])), "true", &env())).unwrap();
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
    for other in [format!("{full}."), format!("{full} "), format!("{full}::$DATA")] {
        let refused = match judge(Some(&settings(&[&full])), &other, &env) {
            Ok(judged) => judged.listed.is_err() || other.trim() == full,
            Err(_) => true,
        };
        assert!(refused, "{other}");
    }
}
