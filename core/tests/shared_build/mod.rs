//! Cross-process guard for the test-support builds that several test
//! processes share (`plugin_fixture`, `plugin_runner_support`).
//!
//! Those helpers `cargo build` a package into one shared target directory and
//! then copy or execute its artifact. Even a no-op `cargo build` re-links the
//! artifact into place, so a build in one process can make the file briefly
//! vanish under another process that is copying or executing it. Under
//! `cargo test` that never happened: test binaries run one after another and a
//! [`std::sync::OnceLock`] builds once per binary. Under cargo-nextest every
//! test is its own process and binaries run in parallel, so it did:
//! `plugin_runner_e2e::a_missing_runner_fails_the_load` failed with "copy the
//! echo-backend library: NotFound" (#5345).
//!
//! [`build_once`] takes an exclusive file lock next to the target directory and,
//! inside a nextest run, builds at most once per run (a `NEXTEST_RUN_ID` stamp):
//! every later process waits for the first build and then only reads the
//! artifact, which nothing rewrites until the run ends.

use std::fs::File;
use std::path::Path;

/// Run `build` (which builds into `target_dir`) under an exclusive cross-process
/// lock, and only once per nextest run. Outside nextest it runs every time, as
/// before; the caller's `OnceLock` still limits it to once per process.
pub fn build_once(target_dir: &Path, build: impl FnOnce()) {
    std::fs::create_dir_all(target_dir).expect("create the shared target dir");
    let mut lock_name = target_dir
        .file_name()
        .expect("the shared target dir has a name")
        .to_os_string();
    lock_name.push(".lock");
    let lock = File::create(target_dir.with_file_name(lock_name)).expect("create the build lock");
    lock.lock().expect("take the build lock");

    let stamp = std::env::var("NEXTEST_RUN_ID")
        .ok()
        .map(|id| target_dir.join(format!(".built-{id}")));
    if stamp.as_ref().is_some_and(|s| s.exists()) {
        return;
    }
    build();
    if let Some(stamp) = stamp {
        // Best effort: drop the stamps of earlier runs.
        if let Ok(entries) = std::fs::read_dir(target_dir) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with(".built-") {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        File::create(stamp).expect("write the build stamp");
    }
    // The lock is released when `lock` drops.
}
