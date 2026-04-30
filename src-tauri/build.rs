fn main() {
    let hash = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=GIT_HASH={hash}");
    println!("cargo:rerun-if-changed=.git/HEAD");

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
