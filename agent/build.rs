fn main() {
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
    // Only watch a path that exists: a missing one is always stale (#3909).
    if let Some(head) = git_head_path() {
        println!("cargo:rerun-if-changed={}", head.display());
    }
}

/// Absolute path of the checkout's git `HEAD` file, or `None` outside a git
/// checkout.
///
/// Build scripts run with the package directory as cwd, so a bare
/// `rerun-if-changed=.git/HEAD` names `<package>/.git/HEAD`, which never
/// exists in this workspace (the `.git` lives at the repo root). Cargo treats a
/// missing watched path as permanently stale, so that line re-ran this script
/// and recompiled the crate on every cargo invocation (#3909). Asking git also
/// handles worktrees, where `.git` is a file pointing elsewhere.
fn git_head_path() -> Option<std::path::PathBuf> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--git-path", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let raw = String::from_utf8(out.stdout).ok()?;
    let path = std::path::PathBuf::from(raw.trim());
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    path.is_file().then_some(path)
}
