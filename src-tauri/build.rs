fn main() {
    let hash = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=GIT_HASH={hash}");
    // Only watch paths that exist: a missing one is always stale (#3909).
    // HEAD moves on a branch switch; the branch's ref file moves on a commit,
    // which is what changes GIT_HASH.
    for watched in git_hash_inputs() {
        println!("cargo:rerun-if-changed={}", watched.display());
    }

    // Emit a compile-time flag so CI dev builds can identify themselves at runtime.
    // Set TERMIHUB_DEV_BUILD=true in the CI workflow to enable this.
    let is_dev_build = matches!(
        std::env::var("TERMIHUB_DEV_BUILD").as_deref(),
        Ok("1") | Ok("true") | Ok("True") | Ok("TRUE")
    );
    println!(
        "cargo:rustc-env=TERMIHUB_IS_DEV_BUILD={}",
        if is_dev_build { "1" } else { "0" }
    );
    println!("cargo:rerun-if-env-changed=TERMIHUB_DEV_BUILD");

    // In CI, TERMIHUB_BUILD_BRANCH is injected by the workflow. For local builds
    // fall back to the current git branch.
    let branch = std::env::var("TERMIHUB_BUILD_BRANCH")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            std::process::Command::new("git")
                .args(["branch", "--show-current"])
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "unknown".to_string())
        });
    println!("cargo:rustc-env=TERMIHUB_BUILD_BRANCH={branch}");
    println!("cargo:rerun-if-env-changed=TERMIHUB_BUILD_BRANCH");

    // Generate the Tauri context here rather than with the
    // `tauri::generate_context!()` proc macro (#3916). The codegen writes
    // content-hashed files (icons, Info.plist, the embedded frontend) into
    // OUT_DIR. From inside the macro those writes happen while rustc compiles
    // termihub_lib, so they postdate the compile's dep-info stamp and the next
    // cargo invocation saw the crate as stale and rebuilt it once more. Here they
    // are written before rustc starts. `lib.rs` includes the result through
    // `tauri::tauri_build_context!()`.
    //
    // Same inputs as the macro: `tauri.conf.json` (plus the platform config
    // and any `TAURI_CONFIG` merge), `dev` from the `tauri` crate's
    // `custom-protocol` feature (`DEP_TAURI_DEV`, the same switch the macro's
    // `cfg!(not(feature = "custom-protocol"))` follows), and the same
    // `tauri-codegen` function, with compression on (see Cargo.toml).
    //
    // Link the Visual C++ runtime statically on Windows in release builds only
    // (#4172), so the shipped termihub.exe needs no VC++ redistributable on the
    // user's machine. Every distributable comes from a release-profile build:
    // `tauri build` in the release and dev-build workflows, and local
    // `pnpm tauri build`; the CI step `verify-no-vcruntime.ps1` fails a Windows
    // installer whose binaries import VCRUNTIME140.dll / MSVCP140.dll.
    //
    // Debug and test builds keep it dynamic, because tauri-build's static mode
    // cannot be confined to this crate: it writes a stub `msvcrt.lib` into this
    // crate's OUT_DIR and emits `cargo:rustc-link-search=native=<OUT_DIR>`.
    // Cargo hands every build-script link-search path in the build to rustdoc,
    // so `cargo test --workspace` doc tests of other crates (termihub-core)
    // picked up the stub and failed to link (`LNK4003 ... msvcrt.lib`,
    // unresolved `__CxxFrameHandler3`, #4170). Nothing runs tests in the release
    // profile, so gating on it keeps the stub out of every test build.
    // Cargo sets PROFILE to "release" for `--release` and any profile that
    // inherits from it, and to "debug" otherwise; it is ignored off Windows.
    let release_profile = std::env::var("PROFILE").as_deref() == Ok("release");
    let attributes = tauri_build::Attributes::new()
        .codegen(tauri_build::CodegenContext::new())
        .windows_attributes(
            tauri_build::WindowsAttributes::new().static_vc_runtime(release_profile),
        );
    if let Err(error) = tauri_build::try_build(attributes) {
        // Mirror `tauri_build::build()`: print the error and fail the build.
        println!("{error:#}");
        std::process::exit(1);
    }
}

/// The git files whose change means `GIT_HASH` may have changed: `HEAD`, plus
/// the current branch's loose ref (or `packed-refs` when the ref is packed).
/// Only paths that exist are returned; outside a git checkout, none.
fn git_hash_inputs() -> Vec<std::path::PathBuf> {
    let Some(head) = git_path("HEAD") else {
        return Vec::new();
    };
    let mut inputs = vec![head];
    let branch_ref = git_output(&["symbolic-ref", "-q", "HEAD"]);
    if let Some(r) = branch_ref.as_deref().and_then(git_path) {
        inputs.push(r);
    } else if let Some(packed) = git_path("packed-refs") {
        inputs.push(packed);
    }
    inputs
}

/// Trimmed stdout of a successful `git <args>`, or `None`.
fn git_output(args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let text = String::from_utf8(out.stdout).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

/// Absolute path of `name` inside the git directory, if that file exists.
///
/// Build scripts run with the package directory as cwd, so a bare
/// `rerun-if-changed=.git/HEAD` names `src-tauri/.git/HEAD`, which never
/// exists (the `.git` lives at the repo root). Cargo treats a missing watched
/// path as permanently stale, so that line re-ran this script and recompiled
/// the crate on every cargo invocation (#3909). `git rev-parse --git-path`
/// also resolves worktrees, where `.git` is a file pointing elsewhere.
fn git_path(name: &str) -> Option<std::path::PathBuf> {
    let raw = git_output(&["rev-parse", "--git-path", name])?;
    let path = std::path::PathBuf::from(raw);
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    path.is_file().then_some(path)
}
