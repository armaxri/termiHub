//! Shared helpers for the live-agent test harnesses.
//!
//! Cargo does not build `tests/common/mod.rs` as a test binary of its own, so
//! this is a plain module each suite pulls in with `mod common;`.

use std::sync::{Mutex, MutexGuard, OnceLock};

static FORK_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Serialises **every `fork`** in this test binary against **every write to a
/// binary this suite is about to `execve`** (#1597).
///
/// ## The race
///
/// A harness that copies the agent binary into a temp dir and runs it does:
///
/// 1. Thread **A** calls `fs::copy`, which holds a **write fd** on `binA`.
/// 2. Thread **B** calls `Command::spawn`, which **forks**. The child inherits
///    *every* fd in the process — including A's write fd on `binA`. `O_CLOEXEC`
///    does not save you: it closes the fd at `execve`, and B's child is sitting
///    between `fork` and `exec`.
/// 3. A finishes its copy and closes its own fd, then `execve`s `binA`.
/// 4. Linux fails that `execve` with **`ETXTBSY`** ("Text file busy") because
///    B's not-yet-exec'd child *still* holds a write fd on the file.
///
/// Linux-only (macOS does not enforce `ETXTBSY` this way), and intermittent —
/// it needs a fork to land inside another thread's copy window. See
/// rust-lang/rust#3352.
///
/// ## Why this works
///
/// `Command::spawn` does not return until the child has `exec`'d (std blocks on
/// a `CLOEXEC` pipe to report exec failures). So holding this lock across
/// `copy` → `chmod` → `spawn` guarantees no fd is inherited that outlives the
/// critical section: by the time the lock drops, every child has already exec'd
/// and closed what it inherited.
///
/// ## Two things that look sufficient and are not
///
/// - **Copying to a temp path and renaming into place.** `rename` does not
///   change the inode, and `ETXTBSY` is enforced per *inode* — an inherited
///   write fd on the temp path still refers to the very inode being exec'd.
///   Measured on Linux, 6 threads × 200 spawns: 119/1200 failures, versus
///   220/1200 with no mitigation at all. It does not fix it.
/// - **Locking only the harness's own copy+spawn.** *Any* fork in the process
///   inherits the fd, including unrelated ones like a `docker` probe. With one
///   such fork site left unlocked: 47/1200 failures. With every fork site
///   taking this lock: 0/1200.
///
/// So the rule is not "lock the spawn" but **lock the fork** — if you add a
/// `Command` that forks anywhere in one of these suites, it takes this guard,
/// however unrelated it looks.
///
/// Hold it for the copy and the spawn only. Drop it before anything that waits
/// on the child (reading its log, polling its port), or the suite serialises
/// wholesale instead of just at the hazard.
pub fn fork_guard() -> MutexGuard<'static, ()> {
    FORK_LOCK
        .get_or_init(|| Mutex::new(()))
        // A test that panics while holding this must not cascade into every
        // sibling: the guard protects fd timing, not data, so there is no
        // invariant for a panic to have broken.
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
