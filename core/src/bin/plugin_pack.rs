//! `termihub-plugin-pack` — command-line wrapper around
//! [`termihub_core::plugin::pack_plugin`].
//!
//! Packages a plugin *source directory* into a validated `.termihub-plugin`
//! archive. It does **not** build a backend crate itself — the
//! `scripts/package-plugin.{sh,cmd}` helpers compile the dynamic library, stage
//! it into `backend/`, and then invoke this binary. Kept behind the `plugin`
//! cargo feature (see the `[[bin]]` `required-features` in `core/Cargo.toml`).
//!
//! ```text
//! termihub-plugin-pack --source <plugin-dir> [--out <output-dir>]
//! ```

use std::path::PathBuf;
use std::process::ExitCode;

use termihub_core::plugin::pack_plugin;

const USAGE: &str = "\
termihub-plugin-pack — package a plugin source directory into a .termihub-plugin

USAGE:
    termihub-plugin-pack --source <plugin-dir> [--out <output-dir>]

OPTIONS:
    --source <dir>   Plugin source directory containing manifest.json (required)
    --out <dir>      Directory to write the package into (default: current dir)
    -h, --help       Show this help
";

fn main() -> ExitCode {
    let mut source: Option<PathBuf> = None;
    let mut out: PathBuf = PathBuf::from(".");

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--source" => match args.next() {
                Some(v) => source = Some(PathBuf::from(v)),
                None => return fail("--source requires a directory"),
            },
            "--out" => match args.next() {
                Some(v) => out = PathBuf::from(v),
                None => return fail("--out requires a directory"),
            },
            "-h" | "--help" => {
                print!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            other => return fail(&format!("unknown argument: {other}")),
        }
    }

    let Some(source) = source else {
        return fail("missing required --source <plugin-dir>");
    };

    match pack_plugin(&source, &out) {
        Ok(path) => {
            println!("Created {}", path.display());
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
