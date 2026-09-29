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

    tauri_build::build()
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
