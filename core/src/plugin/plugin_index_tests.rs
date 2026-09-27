//! Tests for the plugin index parser and compatibility evaluation (PROD-048).

use super::*;

const SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const HOST_TRIPLE: &str = "x86_64-unknown-linux-gnu";
const HOST_RUSTC: &str = "1.98.0 (88d9e12ae)";

fn host() -> HostFacts {
    HostFacts {
        triple: HOST_TRIPLE.into(),
        abi: AbiVersion::new(1, 1),
        toolchain: Toolchain {
            rustc: HOST_RUSTC.into(),
            panic_strategy: PanicStrategy::Unwind,
        },
    }
}

fn entry_json(id: &str, extra: &str) -> String {
    format!(
        r#"{{"id":"{id}","name":"Demo","description":"A demo.\nSecond line.","author":"Jane",
        "version":"1.2.0","minHostAbi":"1.0"{extra},
        "packages":[{{"platforms":["any"],"url":"https://example.com/{id}.termihub-plugin",
        "sha256":"{SHA}"}}]}}"#
    )
}

fn index_json(entries: &[String]) -> String {
    format!(r#"{{"schemaVersion":1,"plugins":[{}]}}"#, entries.join(","))
}

fn native_entry(toolchain: Option<(&str, &str)>) -> PluginIndexEntry {
    PluginIndexEntry {
        id: "native-demo".into(),
        name: "Native".into(),
        description: "d".into(),
        author: "a".into(),
        version: "2.0.0".into(),
        homepage: None,
        min_host_abi: "1.1".into(),
        native: true,
        toolchain: toolchain.map(|(rustc, panic)| IndexToolchain {
            rustc: rustc.into(),
            panic_strategy: panic.into(),
        }),
        packages: vec![PluginIndexPackage {
            platforms: vec![HOST_TRIPLE.into(), "aarch64-apple-darwin".into()],
            url: "https://example.com/n.termihub-plugin".into(),
            sha256: SHA.into(),
        }],
    }
}

#[test]
fn parses_empty_and_populated_indexes() {
    let empty = parse_plugin_index(br#"{"schemaVersion":1,"plugins":[]}"#).unwrap();
    assert!(empty.plugins.is_empty());

    let idx = parse_plugin_index(index_json(&[entry_json("demo", "")]).as_bytes()).unwrap();
    assert_eq!(idx.plugins.len(), 1);
    assert_eq!(idx.entry("demo").unwrap().version, "1.2.0");
    assert!(idx.entry("missing").is_none());
}

#[test]
fn the_shipped_default_index_is_valid_and_empty() {
    let shipped = include_bytes!("../../../plugins/index.json");
    let idx = parse_plugin_index(shipped).expect("plugins/index.json must parse");
    assert!(
        idx.plugins.is_empty(),
        "the shipped index must suggest nothing third-party by default"
    );
}

#[test]
fn rejects_oversize_before_parsing() {
    let big = vec![b' '; MAX_INDEX_BYTES + 1];
    assert_eq!(
        parse_plugin_index(&big),
        Err(PluginIndexError::TooLarge {
            limit: MAX_INDEX_BYTES
        })
    );
}

#[test]
fn rejects_malformed_unknown_fields_and_wrong_schema() {
    for bad in [
        "nope".to_string(),
        r#"{"schemaVersion":1}"#.to_string(),
        r#"{"schemaVersion":1,"plugins":[],"extra":true}"#.to_string(),
        index_json(&[entry_json("demo", r#","unknown":1"#)]),
    ] {
        assert!(
            matches!(
                parse_plugin_index(bad.as_bytes()),
                Err(PluginIndexError::Malformed(_))
            ),
            "{bad}"
        );
    }
    assert_eq!(
        parse_plugin_index(br#"{"schemaVersion":2,"plugins":[]}"#),
        Err(PluginIndexError::UnsupportedSchema(2))
    );
}

#[test]
fn rejects_duplicate_ids() {
    let json = index_json(&[entry_json("demo", ""), entry_json("demo", "")]);
    assert_eq!(
        parse_plugin_index(json.as_bytes()),
        Err(PluginIndexError::DuplicateId("demo".into()))
    );
}

#[test]
fn rejects_invalid_field_values() {
    let base = entry_json("demo", "");
    let cases = [
        (entry_json("Bad Id!", ""), "id"),
        (base.replace("\"Demo\"", "\"\""), "name"),
        (base.replace("\"Demo\"", "\"De\\u0007mo\""), "name"),
        (base.replace("1.2.0", "1.2"), "version"),
        (
            base.replace("\"minHostAbi\":\"1.0\"", "\"minHostAbi\":\"1\""),
            "minHostAbi",
        ),
        (
            base.replace("https://example.com/demo", "http://example.com/demo"),
            "url",
        ),
        (base.replace(SHA, "abc"), "sha256"),
        (base.replace("[\"any\"]", "[\"Not A Triple\"]"), "platforms"),
        (base.replace("[\"any\"]", "[]"), "platforms"),
        (entry_json("demo", r#","homepage":"ftp://x/y""#), "homepage"),
        // A toolchain record on a non-native plugin is meaningless.
        (
            entry_json(
                "demo",
                r#","toolchain":{"rustc":"1.98.0 (88d9e12ae)","panicStrategy":"unwind"}"#,
            ),
            "toolchain",
        ),
        // A native plugin cannot claim `any`.
        (entry_json("demo", r#","native":true"#), "platforms"),
    ];
    for (entry, field) in cases {
        match parse_plugin_index(index_json(&[entry.clone()]).as_bytes()) {
            Err(PluginIndexError::InvalidField { field: f, .. }) => {
                assert_eq!(f, field, "{entry}")
            }
            other => panic!("expected {field} rejection for {entry}, got {other:?}"),
        }
    }
}

#[test]
fn rejects_malformed_toolchain_and_overlapping_platforms() {
    let mut e = native_entry(Some(("1.98.0", "unwind")));
    assert!(matches!(
        e.validate(0),
        Err(PluginIndexError::InvalidField {
            field: "toolchain",
            ..
        })
    ));
    e = native_entry(Some((HOST_RUSTC, "sometimes")));
    assert!(e.validate(0).is_err());

    e = native_entry(None);
    e.packages.push(PluginIndexPackage {
        platforms: vec![HOST_TRIPLE.into()],
        url: "https://example.com/other".into(),
        sha256: SHA.into(),
    });
    assert!(matches!(
        e.validate(0),
        Err(PluginIndexError::InvalidField {
            field: "platforms",
            ..
        })
    ));
}

#[test]
fn package_selection_prefers_the_host_triple_then_any() {
    let e = native_entry(None);
    assert!(e.package_for(HOST_TRIPLE).is_some());
    assert!(e.package_for("riscv64gc-unknown-linux-gnu").is_none());

    let idx = parse_plugin_index(index_json(&[entry_json("demo", "")]).as_bytes()).unwrap();
    assert!(idx.plugins[0]
        .package_for("riscv64gc-unknown-linux-gnu")
        .is_some());
}

#[test]
fn evaluates_compatibility_and_install_status() {
    let none = BTreeMap::new();
    let v = evaluate_index_entry(&native_entry(Some((HOST_RUSTC, "unwind"))), &host(), &none);
    assert!(v.abi_compatible && v.platform_supported && v.installable);
    assert_eq!(v.toolchain, ToolchainStatus::Match);
    assert_eq!(v.install_status, InstallStatus::NotInstalled);
    assert_eq!(v.host_abi, "1.1");
    assert_eq!(v.host_platform, HOST_TRIPLE);

    // Toolchain mismatch (rustc or panic strategy) blocks the install.
    for tc in [("1.97.0 (aaaaaaa)", "unwind"), (HOST_RUSTC, "abort")] {
        let v = evaluate_index_entry(&native_entry(Some(tc)), &host(), &none);
        assert_eq!(v.toolchain, ToolchainStatus::Mismatch);
        assert!(!v.installable);
        assert!(v.blocked_reason.unwrap().contains("toolchain"));
    }

    // Undeclared toolchain: the loader decides; still installable.
    let v = evaluate_index_entry(&native_entry(None), &host(), &none);
    assert_eq!(v.toolchain, ToolchainStatus::Undeclared);
    assert!(v.installable);

    // ABI too new for this host.
    let mut e = native_entry(None);
    e.min_host_abi = "2.0".into();
    let v = evaluate_index_entry(&e, &host(), &none);
    assert!(!v.abi_compatible && !v.installable);
    assert!(v.blocked_reason.unwrap().contains("ABI 2.0"));

    // No package for this platform.
    let mut other = host();
    other.triple = "riscv64gc-unknown-linux-gnu".into();
    let v = evaluate_index_entry(&native_entry(None), &other, &none);
    assert!(!v.platform_supported && !v.installable);
}

#[test]
fn compares_against_the_installed_version_without_offering_downgrades() {
    let e = native_entry(None); // lists 2.0.0
    let status = |installed: &str| {
        let map = BTreeMap::from([("native-demo".to_string(), installed.to_string())]);
        let v = evaluate_index_entry(&e, &host(), &map);
        (v.install_status, v.installable)
    };
    assert_eq!(status("1.9.0"), (InstallStatus::UpdateAvailable, true));
    assert_eq!(status("2.0.0"), (InstallStatus::Installed, false));
    assert_eq!(status("2.1.0"), (InstallStatus::InstalledNewer, false));
    assert_eq!(status("garbage"), (InstallStatus::Installed, false));
}

#[test]
fn view_serializes_camel_case() {
    let v = evaluate_index_entry(&native_entry(None), &host(), &BTreeMap::new());
    let json = serde_json::to_string(&v).unwrap();
    for key in [
        "\"abiCompatible\"",
        "\"platformSupported\"",
        "\"hostPlatform\"",
        "\"installStatus\":\"notInstalled\"",
        "\"toolchain\":\"undeclared\"",
        "\"minHostAbi\"",
    ] {
        assert!(json.contains(key), "{key} in {json}");
    }
}
