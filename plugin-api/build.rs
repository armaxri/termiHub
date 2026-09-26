//! Record the Rust toolchain that compiles this crate (PLG-013, ABI 1.1).
//!
//! `termihub-plugin-api` is compiled into **both** the host and every plugin, by
//! whichever compiler builds that final artifact. Capturing `rustc -vV` here
//! therefore gives each side a trustworthy record of its own toolchain:
//! [`PluginInfo::new`](crate::PluginInfo::new) reports it from a plugin, and the
//! host compares it with its own copy (see `src/toolchain.rs`).
//!
//! The record is `"<release> (<commit-hash>)"`, e.g. `1.98.0 (88d9e12ae…)`. If
//! the compiler cannot be queried, or does not report a commit hash, the record
//! is left **empty** — which the host treats as *unknown* and refuses (fail
//! closed), rather than guessing.

use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=RUSTC");

    let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".to_owned());
    let record = Command::new(rustc)
        .arg("-vV")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|text| toolchain_record(&text))
        .unwrap_or_default();

    println!("cargo:rustc-env=TERMIHUB_PLUGIN_API_RUSTC={record}");
}

/// Reduce `rustc -vV` output to `"<release> (<commit-hash>)"`, or an empty
/// string when either field is missing or the hash is `unknown`.
fn toolchain_record(verbose_version: &str) -> String {
    let field = |name: &str| {
        verbose_version.lines().find_map(|line| {
            line.strip_prefix(name)
                .and_then(|rest| rest.strip_prefix(':'))
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
    };
    match (field("release"), field("commit-hash")) {
        (Some(release), Some(hash)) if hash != "unknown" => format!("{release} ({hash})"),
        _ => String::new(),
    }
}
