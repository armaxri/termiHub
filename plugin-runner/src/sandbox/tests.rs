use super::macos::{seatbelt_profile, PARAM_DATA_DIR, PARAM_INSTALL_DIR};
use super::*;

/// An absolute path on this OS: Unix paths as written, `C:`-prefixed on
/// Windows (where `/x` is not absolute). The profile generator itself is
/// OS-independent, so its tests run everywhere.
fn abs(path: &str) -> String {
    if cfg!(windows) {
        format!("C:{path}")
    } else {
        path.to_owned()
    }
}

fn policy() -> SandboxPolicy {
    SandboxPolicy {
        install_dir: abs("/plugins/acme"),
        data_dir: Some(abs("/plugins/.data/acme")),
        denied_dirs: vec![abs("/Users/someone")],
        simulate_missing: Vec::new(),
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
(allow file-read* (subpath "/private/etc/ssl"))
(allow file-read-metadata (literal "/etc"))
(allow sysctl-read
  (sysctl-name
    "hw.activecpu" "hw.byteorder" "hw.cachelinesize" "hw.cachelinesize_compat"
    "hw.cpufamily" "hw.cpusubtype" "hw.cputype" "hw.l1dcachesize" "hw.l1icachesize"
    "hw.l2cachesize" "hw.l3cachesize" "hw.logicalcpu" "hw.logicalcpu_max" "hw.machine"
    "hw.memsize" "hw.ncpu" "hw.pagesize" "hw.pagesize_compat" "hw.physicalcpu"
    "hw.physicalcpu_max" "hw.tbfrequency" "hw.tbfrequency_compat" "kern.argmax"
    "kern.hostname" "kern.maxfilesperproc" "kern.osproductversion" "kern.osrelease"
    "kern.ostype" "kern.osvariant_status" "kern.osversion" "kern.usrstack64"
    "kern.version" "sysctl.proc_translated")
  (sysctl-name-prefix "hw.optional.")
  (sysctl-name-prefix "hw.perflevel"))
(deny process-info*)
(allow process-info* (target self))
(allow signal (target self))
(allow mach-lookup (global-name "com.apple.trustd.agent"))
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
            ("DENIED_DIR_0".to_owned(), abs("/Users/someone")),
            ("INSTALL_DIR".to_owned(), abs("/plugins/acme")),
            ("DATA_DIR".to_owned(), abs("/plugins/.data/acme")),
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
        vec![(PARAM_INSTALL_DIR.to_owned(), abs("/plugins/acme"))]
    );
}

/// Several denied folders get one parameter each, all before the allowances
/// (Seatbelt applies the last matching rule, so the install and data folders
/// stay reachable inside a denied home).
#[test]
fn denied_dirs_precede_the_allowances() {
    let profile = seatbelt_profile(&SandboxPolicy {
        denied_dirs: vec![abs("/a"), abs("/b")],
        ..policy()
    })
    .unwrap();
    let deny_1 = profile.sbpl.find("DENIED_DIR_1").unwrap();
    let install = profile.sbpl.find("(param \"INSTALL_DIR\")").unwrap();
    let data = profile.sbpl.find("(param \"DATA_DIR\")").unwrap();
    assert!(deny_1 < install && install < data);
    assert_eq!(profile.params[0], ("DENIED_DIR_0".into(), abs("/a")));
    assert_eq!(profile.params[1], ("DENIED_DIR_1".into(), abs("/b")));
}

/// Hostile folder names never reach the profile text: they travel as
/// parameters only, verbatim.
#[test]
fn paths_are_parameters_never_profile_text() {
    let hostile = abs(r#"/tmp/x") (allow default) ("#);
    let profile = seatbelt_profile(&SandboxPolicy {
        install_dir: hostile.clone(),
        data_dir: Some(abs("/tmp/da\"ta\\(dir)")),
        denied_dirs: vec![abs("/tmp/;; comment\n(allow network*)")],
        simulate_missing: Vec::new(),
    })
    .unwrap();
    assert!(!profile.sbpl.contains("/tmp"));
    assert!(!profile.sbpl.contains("(allow default)"));
    assert!(!profile.sbpl.contains("(allow network*)"));
    assert_eq!(
        profile.sbpl,
        seatbelt_profile(&SandboxPolicy {
            install_dir: abs("/x"),
            data_dir: Some(abs("/y")),
            denied_dirs: vec![abs("/z")],
            simulate_missing: Vec::new(),
        })
        .unwrap()
        .sbpl,
        "the profile text depends only on the policy's shape"
    );
    assert!(profile
        .params
        .iter()
        .any(|(n, v)| n == PARAM_INSTALL_DIR && *v == hostile));
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
    // The certificate trust daemon is the only Mach service (#4342).
    assert_eq!(sbpl.matches("mach-lookup").count(), 1, "{sbpl}");
    assert!(sbpl.contains(&format!(
        "(allow mach-lookup (global-name \"{}\"))",
        super::macos::TRUST_SERVICE
    )));
    for service in [
        "com.apple.SecurityServer",
        "com.apple.trustd\"",
        "global-name-prefix",
    ] {
        assert!(!sbpl.contains(service), "{service} must not be reachable");
    }
    assert!(!sbpl.contains("(allow network"));
    assert!(!sbpl.contains("(allow process-exec"));
}

/// SEC2-008 (#4342): `sysctl-read` is limited to named values — the process
/// table (`kern.proc.*`), other processes' arguments and environment
/// (`kern.procargs2`) and machine identifiers stay unreadable — and other
/// processes' information is denied explicitly (`(deny default)` alone does
/// not cover it), before the allowance for the runner itself.
#[test]
fn sysctl_read_is_narrowed_and_process_info_is_self_only() {
    use super::macos::{SYSCTL_NAMES, SYSCTL_NAME_PREFIXES};
    let sbpl = seatbelt_profile(&policy()).unwrap().sbpl;
    assert!(
        !sbpl.contains("(allow sysctl-read)"),
        "unfiltered sysctl-read is back"
    );
    let rule_start = sbpl.find("(allow sysctl-read").unwrap();
    let rule_end = rule_start + sbpl[rule_start..].find("))\n").unwrap() + 2;
    let rule = &sbpl[rule_start..rule_end];
    for name in SYSCTL_NAMES {
        assert!(rule.contains(&format!("\"{name}\"")), "{name} missing");
    }
    for prefix in SYSCTL_NAME_PREFIXES {
        assert!(rule.contains(&format!("(sysctl-name-prefix \"{prefix}\")")));
    }
    let quoted = rule.matches('"').count() / 2;
    assert_eq!(
        quoted,
        SYSCTL_NAMES.len() + SYSCTL_NAME_PREFIXES.len(),
        "the rule names exactly the listed values: {rule}"
    );
    for leak in [
        "kern.proc",
        "kern.procargs",
        "kern.uuid",
        "kern.boottime",
        "hw.model",
        "\"kern.\"",
        "\"hw.\"",
    ] {
        assert!(!rule.contains(leak), "{leak} must stay unreadable");
    }
    let deny = sbpl.find("(deny process-info*)\n").expect("explicit deny");
    let allow = sbpl.find("(allow process-info* (target self))").unwrap();
    assert!(deny < allow, "the self allowance must come last");
    assert_eq!(sbpl.matches("(allow process-info*").count(), 1);
}

/// PLG2-004 (#4342): the OpenSSL / LibreSSL CA bundle is readable, never
/// writable, and nothing else under `/private/etc` is.
#[test]
fn the_ca_bundle_is_read_only() {
    let sbpl = seatbelt_profile(&policy()).unwrap().sbpl;
    assert!(sbpl.contains("(allow file-read* (subpath \"/private/etc/ssl\"))"));
    let etc_rules: Vec<&str> = sbpl.lines().filter(|l| l.contains("/etc")).collect();
    assert_eq!(
        etc_rules,
        [
            "(allow file-read* (subpath \"/private/etc/ssl\"))",
            // Resolving the `/etc` → `/private/etc` symlink itself.
            "(allow file-read-metadata (literal \"/etc\"))",
        ]
    );
}

#[test]
fn invalid_paths_are_refused() {
    let with = |install: &str| SandboxPolicy {
        install_dir: install.to_owned(),
        ..policy()
    };
    for (path, reason) in [
        (String::new(), "empty"),
        ("relative/dir".to_owned(), "not absolute"),
        (abs("/"), "is the filesystem root"),
        (abs("/a\0b"), "contains a NUL byte"),
    ] {
        match seatbelt_profile(&with(&path)) {
            Err(SandboxError::InvalidPath { reason: r, .. }) => assert_eq!(r, reason, "{path:?}"),
            other => panic!("{path:?}: {other:?}"),
        }
    }
    let root_denied = SandboxPolicy {
        denied_dirs: vec![abs("/")],
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

/// A `.` or `..` segment makes a policy path name something other than what
/// it reads as: landlock opens `/a/..` as `/`, and Windows normalises
/// `C:\a\..` to `C:\`, so such a path could grant the whole disk (#4293).
#[test]
fn dot_segments_are_refused_on_every_policy_path() {
    for path in [
        abs("/plugins/.."),
        abs("/plugins/acme/../.."),
        abs("/plugins/./acme"),
        abs("/plugins/acme/."),
    ] {
        let install = SandboxPolicy {
            install_dir: path.clone(),
            ..policy()
        };
        let data = SandboxPolicy {
            data_dir: Some(path.clone()),
            ..policy()
        };
        let denied = SandboxPolicy {
            denied_dirs: vec![path.clone()],
            ..policy()
        };
        for candidate in [install, data, denied] {
            assert!(
                matches!(candidate.validate(), Err(SandboxError::InvalidPath { .. })),
                "{path:?} must be refused"
            );
        }
    }
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

#[test]
fn app_container_names_are_deterministic_and_short() {
    let name = app_container_name("acme.ssh-tools");
    assert_eq!(name, app_container_name("acme.ssh-tools"));
    assert_ne!(name, app_container_name("acme.ssh-tool"));
    let hash = name.strip_prefix("termiHub.Plugin.").expect("the prefix");
    assert_eq!(hash.len(), 16);
    assert!(hash.bytes().all(|b| b.is_ascii_hexdigit()));
    // Profile names are limited to 64 characters.
    assert!(name.len() <= 64);
}

#[test]
fn windows_requires_the_appcontainer_layer() {
    if cfg!(windows) {
        assert_eq!(required_layers(), &[layer::APPCONTAINER]);
    }
}
