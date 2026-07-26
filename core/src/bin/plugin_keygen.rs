//! `termihub-plugin-keygen` — generate an Ed25519 publisher keypair for signing
//! `.termihub-plugin` packages (concept
//! `docs/concepts/backlog/plugin-code-signing.html`).
//!
//! Run once per publisher. The private key is written to `--out` (guard it — it
//! is what proves publisher identity); the public key and its `sha256:`
//! fingerprint are printed so they can be published next to the plugin for users
//! to compare during trust-on-first-use. Kept behind the `plugin` cargo feature
//! (see `[[bin]]` `required-features` in `core/Cargo.toml`).
//!
//! ```text
//! termihub-plugin-keygen --out acme.key --label "ACME Terminals"
//! ```

use std::path::PathBuf;
use std::process::ExitCode;

use termihub_core::plugin::generate_keypair;

const USAGE: &str = "\
termihub-plugin-keygen — generate an Ed25519 publisher keypair

USAGE:
    termihub-plugin-keygen --out <key-file> --label <publisher-label>

OPTIONS:
    --out <file>     Path to write the private key file to (required)
    --label <name>   Human-readable publisher label, e.g. \"ACME Terminals\" (required)
    -h, --help       Show this help

The key file is JSON containing the private and public keys. Keep it secret and
back it up — it cannot be recovered, and losing it means you can no longer sign
updates under the same identity.
";

fn main() -> ExitCode {
    let mut out: Option<PathBuf> = None;
    let mut label: Option<String> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--out" => match args.next() {
                Some(v) => out = Some(PathBuf::from(v)),
                None => return fail("--out requires a file path"),
            },
            "--label" => match args.next() {
                Some(v) => label = Some(v),
                None => return fail("--label requires a value"),
            },
            "-h" | "--help" => {
                print!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            other => return fail(&format!("unknown argument: {other}")),
        }
    }

    let Some(out) = out else {
        return fail("missing required --out <key-file>");
    };
    let Some(label) = label else {
        return fail("missing required --label <publisher-label>");
    };

    if out.exists() {
        return fail(&format!(
            "refusing to overwrite existing key file: {}",
            out.display()
        ));
    }

    let key = generate_keypair(&label);
    let json = match serde_json::to_string_pretty(&key) {
        Ok(j) => j,
        Err(e) => return fail(&format!("could not serialize key: {e}")),
    };
    if let Err(e) = std::fs::write(&out, json) {
        return fail(&format!("could not write key file {}: {e}", out.display()));
    }
    // Best-effort tighten permissions on Unix (0o600) — the private key is secret.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(0o600));
    }

    println!("Generated keypair for \"{}\"", key.label);
    println!("  Private key: {} (keep secret!)", out.display());
    println!("  Public key:  {}", key.public_key);
    println!("  Fingerprint: {}", key.key_id);
    println!();
    println!(
        "Publish the fingerprint next to your plugin so users can verify it on first install."
    );
    ExitCode::SUCCESS
}

/// Print an error plus usage to stderr and signal failure.
fn fail(message: &str) -> ExitCode {
    eprintln!("error: {message}\n\n{USAGE}");
    ExitCode::FAILURE
}
