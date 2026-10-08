use super::macos::{seatbelt_profile, PARAM_DATA_DIR, PARAM_INSTALL_DIR};
use super::*;

fn policy() -> SandboxPolicy {
    SandboxPolicy {
        install_dir: "/plugins/acme".to_owned(),
        data_dir: Some("/plugins/.data/acme".to_owned()),
        denied_dirs: vec!["/Users/someone".to_owned()],
    }
}

/// The full generated profile for the common policy shape (snapshot).
#[test]
fn profile_snapshot_with_data_and_denied_home() {
    let profile = seatbelt_profile(&policy()).unwrap();
    let expected = r#"(version 1)
(deny default)
(allow file-read* file-map-executable
  (subpath "/usr/lib")
  (subpath "/System/Library")
  (subpath "/System/Cryptexes/OS")
  (subpath "/System/Volumes/Preboot/Cryptexes/OS"))
(allow file-read* (literal "/dev/urandom") (literal "/dev/random"))
(allow file-read* file-write-data (literal "/dev/null"))
(allow sysctl-read)
(allow process-info* (target self))
(allow signal (target self))
(deny network*)
(deny process-exec* process-fork)
(deny iokit-open)
(deny file* (subpath (param "DENIED_DIR_0")))
(allow file-read* file-map-executable (subpath (param "INSTALL_DIR")))
(allow file-read* file-write* (subpath (param "DATA_DIR")))
"#;
    assert_eq!(profile.sbpl, expected);
    assert_eq!(
        profile.params,
        vec![
            ("DENIED_DIR_0".to_owned(), "/Users/someone".to_owned()),
            ("INSTALL_DIR".to_owned(), "/plugins/acme".to_owned()),
            ("DATA_DIR".to_owned(), "/plugins/.data/acme".to_owned()),
        ]
    );
}

/// No data folder: nothing is writable, and no `DATA_DIR` rule exists.
#[test]
fn profile_without_data_dir_grants_no_write() {
    let profile = seatbelt_profile(&SandboxPolicy {
        data_dir: None,
        denied_dirs: Vec::new(),
        ..policy()
    })
    .unwrap();
    assert!(!profile.sbpl.contains(PARAM_DATA_DIR));
    assert!(!profile.sbpl.contains("file-write*"));
    assert!(!profile.sbpl.contains("DENIED_DIR"));
    assert_eq!(
        profile.params,
        vec![(PARAM_INSTALL_DIR.to_owned(), "/plugins/acme".to_owned())]
    );
}

/// Several denied folders get one parameter each, all before the allowances
/// (Seatbelt applies the last matching rule, so the install and data folders
/// stay reachable inside a denied home).
#[test]
fn denied_dirs_precede_the_allowances() {
    let profile = seatbelt_profile(&SandboxPolicy {
        denied_dirs: vec!["/a".to_owned(), "/b".to_owned()],
        ..policy()
    })
    .unwrap();
    let deny_1 = profile.sbpl.find("DENIED_DIR_1").unwrap();
    let install = profile.sbpl.find("(param \"INSTALL_DIR\")").unwrap();
    let data = profile.sbpl.find("(param \"DATA_DIR\")").unwrap();
    assert!(deny_1 < install && install < data);
    assert_eq!(profile.params[0], ("DENIED_DIR_0".into(), "/a".into()));
    assert_eq!(profile.params[1], ("DENIED_DIR_1".into(), "/b".into()));
}

/// Hostile folder names never reach the profile text: they travel as
/// parameters only, verbatim.
#[test]
fn paths_are_parameters_never_profile_text() {
    let hostile = r#"/tmp/x") (allow default) ("#;
    let profile = seatbelt_profile(&SandboxPolicy {
        install_dir: hostile.to_owned(),
        data_dir: Some("/tmp/da\"ta\\(dir)".to_owned()),
        denied_dirs: vec!["/tmp/;; comment\n(allow network*)".to_owned()],
    })
    .unwrap();
    assert!(!profile.sbpl.contains("/tmp"));
    assert!(!profile.sbpl.contains("(allow default)"));
    assert!(!profile.sbpl.contains("(allow network*)"));
    assert_eq!(
        profile.sbpl,
        seatbelt_profile(&SandboxPolicy {
            install_dir: "/x".into(),
            data_dir: Some("/y".into()),
            denied_dirs: vec!["/z".into()],
        })
        .unwrap()
        .sbpl,
        "the profile text depends only on the policy's shape"
    );
    assert!(profile
        .params
        .iter()
        .any(|(n, v)| n == PARAM_INSTALL_DIR && v == hostile));
}

/// The profile closes every escape route the concept lists.
#[test]
fn profile_denies_network_processes_and_iokit() {
    let sbpl = seatbelt_profile(&policy()).unwrap().sbpl;
    assert!(sbpl.starts_with("(version 1)\n(deny default)\n"));
    for rule in [
        "(deny network*)",
        "(deny process-exec* process-fork)",
        "(deny iokit-open)",
    ] {
        assert!(sbpl.contains(rule), "missing {rule}");
    }
    assert!(!sbpl.contains("mach-lookup"), "no mach services are needed");
    assert!(!sbpl.contains("(allow network"));
    assert!(!sbpl.contains("(allow process-exec"));
}

#[test]
fn invalid_paths_are_refused() {
    let with = |install: &str| SandboxPolicy {
        install_dir: install.to_owned(),
        ..policy()
    };
    for (path, reason) in [
        ("", "empty"),
        ("relative/dir", "not absolute"),
        ("/", "is the filesystem root"),
        ("/a\0b", "contains a NUL byte"),
    ] {
        match seatbelt_profile(&with(path)) {
            Err(SandboxError::InvalidPath { reason: r, .. }) => assert_eq!(r, reason, "{path:?}"),
            other => panic!("{path:?}: {other:?}"),
        }
    }
    let root_denied = SandboxPolicy {
        denied_dirs: vec!["/".into()],
        ..policy()
    };
    assert!(root_denied.validate().is_err());
    let bad_data = SandboxPolicy {
        data_dir: Some("data".into()),
        ..policy()
    };
    assert!(bad_data.validate().is_err());
    assert!(policy().validate().is_ok());
}

#[test]
fn reports_classify_isolation() {
    assert_eq!(SandboxReport::default().isolation(), Isolation::Unconfined);
    let full = SandboxReport::enforced(&[layer::SEATBELT]);
    assert_eq!(full.isolation(), Isolation::Full);
    let reduced = SandboxReport {
        missing: vec![layer::LANDLOCK.into()],
        ..SandboxReport::enforced(&[layer::SECCOMP])
    };
    assert_eq!(reduced.isolation(), Isolation::Reduced);
    let failed = SandboxReport::setup_failed(&SandboxError::Apply {
        layer: layer::SEATBELT,
        detail: "boom".into(),
    });
    assert_eq!(failed.isolation(), Isolation::Failed);
    assert!(failed.failed.as_deref().unwrap().contains("boom"));
}

#[test]
fn missing_required_layers_are_named() {
    let report = SandboxReport::enforced(&[layer::SECCOMP]);
    assert_eq!(report.missing_required(&[]), None);
    assert_eq!(report.missing_required(&[layer::SECCOMP]), None);
    assert_eq!(
        report.missing_required(&[layer::SECCOMP, layer::LANDLOCK]),
        Some(layer::LANDLOCK)
    );
    assert_eq!(
        SandboxReport::default().missing_required(required_layers()),
        required_layers().first().copied()
    );
}

#[test]
fn an_invalid_policy_is_reported_as_failed_not_ignored() {
    let report = apply(&SandboxPolicy::default());
    assert_eq!(report.isolation(), Isolation::Failed);
}
