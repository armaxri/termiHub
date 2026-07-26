//! `termihub-plugin-sign` — sign a built `.termihub-plugin` package with a
//! publisher key from `termihub-plugin-keygen` (concept
//! `docs/concepts/backlog/plugin-code-signing.html`).
//!
//! Computes a per-entry SHA-256 digest map over the package, signs its canonical
//! form with the Ed25519 private key, and writes `signature.json` into the
//! archive in place. Re-running replaces any prior signature. Kept behind the
//! `plugin` cargo feature.
//!
//! ```text
//! termihub-plugin-sign --key acme.key my-plugin-1.0.0.termihub-plugin
//! ```

use std::path::PathBuf;
use std::process::ExitCode;

use termihub_core::plugin::{sign_package, SigningKeyFile};

const USAGE: &str = "\
termihub-plugin-sign — sign a .termihub-plugin package in place

USAGE:
    termihub-plugin-sign --key <key-file> <package.termihub-plugin>

OPTIONS:
    --key <file>     Private key file from termihub-plugin-keygen (required)
    -h, --help       Show this help
";

fn main() -> ExitCode {
    let mut key_path: Option<PathBuf> = None;
    let mut package: Option<PathBuf> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--key" => match args.next() {
                Some(v) => key_path = Some(PathBuf::from(v)),
                None => return fail("--key requires a file path"),
            },
            "-h" | "--help" => {
                print!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            other if other.starts_with('-') => return fail(&format!("unknown argument: {other}")),
            other => {
                if package.is_some() {
                    return fail("only one package may be signed at a time");
                }
                package = Some(PathBuf::from(other));
            }
        }
    }

    let Some(key_path) = key_path else {
        return fail("missing required --key <key-file>");
    };
    let Some(package) = package else {
        return fail("missing required <package.termihub-plugin>");
    };

    let key: SigningKeyFile = match std::fs::read_to_string(&key_path) {
        Ok(s) => match serde_json::from_str(&s) {
            Ok(k) => k,
            Err(e) => return fail(&format!("invalid key file {}: {e}", key_path.display())),
        },
        Err(e) => {
            return fail(&format!(
                "could not read key file {}: {e}",
                key_path.display()
            ))
        }
    };

    match sign_package(&package, &key) {
        Ok(()) => {
            println!("Signed {}", package.display());
            println!("  Publisher:   {}", key.label);
            println!("  Fingerprint: {}", key.key_id);
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

/// Print an error plus usage to stderr and signal failure.
fn fail(message: &str) -> ExitCode {
    eprintln!("error: {message}\n\n{USAGE}");
    ExitCode::FAILURE
}
