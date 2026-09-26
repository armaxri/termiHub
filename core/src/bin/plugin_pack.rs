//! `termihub-plugin-pack` — command-line wrapper around
//! [`termihub_core::plugin::pack_plugin`] and the multi-platform helpers
//! (PLG-011).
//!
//! Packages a plugin *source directory* into a validated `.termihub-plugin`
//! archive. It does **not** build a backend crate itself — the
//! `scripts/package-plugin.{sh,cmd}` helpers compile the dynamic library, stage
//! it into `backend/` (or `backend/<target-triple>/` for `--target` builds), and
//! then invoke this binary. Kept behind the `plugin` cargo feature (see the
//! `[[bin]]` `required-features` in `core/Cargo.toml`).
//!
//! ```text
//! termihub-plugin-pack --source <plugin-dir> [--out <output-dir>]
//! termihub-plugin-pack --merge <pkg> [--merge <pkg> ...] [--out <output-dir>]
//! termihub-plugin-pack --inspect <pkg>
//! ```

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use termihub_core::plugin::{merge_packages, pack_plugin, package_platform_entries};

const USAGE: &str = "\
termihub-plugin-pack — package a plugin source directory into a .termihub-plugin

USAGE:
    termihub-plugin-pack --source <plugin-dir> [--out <output-dir>]
    termihub-plugin-pack --merge <pkg> [--merge <pkg> ...] [--out <output-dir>]
    termihub-plugin-pack --inspect <pkg>

OPTIONS:
    --source <dir>   Plugin source directory containing manifest.json. A
                     backend/<target-triple>/ tree becomes a multi-platform
                     package (the manifest `libraries` map is derived from it)
    --merge <pkg>    Merge per-platform packages (built with --target) into one
                     multi-platform package; repeat once per input
    --inspect <pkg>  Print each platform entry as `<triple> <sha256> <path>`
    --out <dir>      Directory to write the package into (default: current dir)
    -h, --help       Show this help
";

/// What the invocation asked for.
enum Mode {
    Pack(PathBuf),
    Merge(Vec<PathBuf>),
    Inspect(PathBuf),
}

fn main() -> ExitCode {
    let mut source: Option<PathBuf> = None;
    let mut merge: Vec<PathBuf> = Vec::new();
    let mut inspect: Option<PathBuf> = None;
    let mut out: PathBuf = PathBuf::from(".");

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let slot = match arg.as_str() {
            "-h" | "--help" => {
                print!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            "--source" | "--out" | "--merge" | "--inspect" => arg,
            other => return fail(&format!("unknown argument: {other}")),
        };
        let Some(value) = args.next() else {
            return fail(&format!("{slot} requires a value"));
        };
        let value = PathBuf::from(value);
        match slot.as_str() {
            "--source" => source = Some(value),
            "--out" => out = value,
            "--merge" => merge.push(value),
            _ => inspect = Some(value),
        }
    }

    let mode = match (source, merge.is_empty(), inspect) {
        (Some(src), true, None) => Mode::Pack(src),
        (None, false, None) => Mode::Merge(merge),
        (None, true, Some(pkg)) => Mode::Inspect(pkg),
        (None, true, None) => return fail("missing --source, --merge or --inspect"),
        _ => return fail("--source, --merge and --inspect are mutually exclusive"),
    };

    match run(mode, &out) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(mode: Mode, out: &Path) -> Result<(), termihub_core::plugin::PluginPackError> {
    match mode {
        Mode::Pack(source) => {
            let path = pack_plugin(&source, out)?;
            println!("Created {}", path.display());
        }
        Mode::Merge(inputs) => {
            let path = merge_packages(&inputs, out)?;
            println!("Created {}", path.display());
        }
        Mode::Inspect(pkg) => {
            let entries = package_platform_entries(&pkg)?;
            if entries.is_empty() {
                println!("(single-platform package: no target-triple entries)");
            }
            for e in entries {
                println!("{} {} {}", e.triple, e.sha256, e.path);
            }
        }
    }
    Ok(())
}

/// Print an error plus usage to stderr and signal failure.
fn fail(message: &str) -> ExitCode {
    eprintln!("error: {message}\n\n{USAGE}");
    ExitCode::FAILURE
}
