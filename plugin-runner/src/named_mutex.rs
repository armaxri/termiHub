//! Windows: a lock shared by every process of the user's logon session, for
//! state that outlives one process (#5359).
//!
//! AppContainer profiles and the runner's ACL are per user, not per process:
//! two termiHub instances (the installed app and a portable copy) or two test
//! processes edit them at once. A `static Mutex` serialises only one process,
//! so [`crate::appcontainer`] takes a named Win32 mutex instead.
//!
//! * **Scope.** The name lives in the session's `Local\` namespace: every
//!   process of this session (all of one user's termiHub instances) shares
//!   it, and an AppContainer process, which has its own namespace, cannot
//!   open or squat it. Another session of the same user is not covered; the
//!   profile API's own retry-on-exists path (see `AppContainer::ensure`)
//!   still holds there.
//! * **Threads.** A Win32 mutex is owned by a thread, so it serialises the
//!   threads of one process as well, and no in-process mutex is kept next to
//!   it: one lock, and every waiter's wait is bounded on its own. The flip
//!   side is that a Win32 mutex is recursive on its owning thread; no caller
//!   re-enters one of these locks, and the guard is `!Send`, so it is
//!   released on the thread that took it.
//! * **Abandonment.** A holder that crashed leaves the mutex abandoned; the
//!   next waiter gets `WAIT_ABANDONED`, owns it, and goes on. That is safe for
//!   what it guards: each critical section re-reads the state it changes
//!   (profile registration, the DACL as stored), and a single profile create
//!   or delete and a single DACL write are each atomic, so a crash leaves the
//!   old or the new state, never a half-written one the next holder trusts.
//! * **Bounded wait.** A holder that hangs (or a same-user process holding
//!   the name on purpose) does not hang termiHub: the wait gives up after
//!   [`WAIT_TIMEOUT`] with an [`io::ErrorKind::TimedOut`] error naming the
//!   lock, which the plugin load reports as a sandbox setup failure.

use std::io;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::time::Duration;

use windows_sys::Win32::Foundation::{
    WAIT_ABANDONED, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT as WIN32_WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};

use crate::win::{owned, to_wide};

/// How long [`NamedMutex::lock`] waits before it gives up. A profile create
/// or delete takes milliseconds and a tree grant on a plugin folder well under
/// a second, so this only fires on a hung or hostile holder.
pub(crate) const WAIT_TIMEOUT: Duration = Duration::from_secs(60);

/// A session-wide named mutex (`Local\<name>`).
pub(crate) struct NamedMutex {
    name: &'static str,
}

impl NamedMutex {
    /// The lock `Local\<name>`; nothing is opened until [`NamedMutex::lock`].
    pub(crate) const fn new(name: &'static str) -> Self {
        Self { name }
    }

    /// Wait for the lock, at most [`WAIT_TIMEOUT`].
    pub(crate) fn lock(&self) -> io::Result<NamedMutexGuard> {
        self.lock_within(WAIT_TIMEOUT)
    }

    /// Wait for the lock, at most `timeout`.
    pub(crate) fn lock_within(&self, timeout: Duration) -> io::Result<NamedMutexGuard> {
        let full_name = format!(r"Local\{}", self.name);
        let wide = to_wide(full_name.as_ref())?;
        // SAFETY: default security (the caller's token default DACL: this
        // user, SYSTEM, administrators), not initially owned, a NUL-terminated
        // name. Opens the existing mutex when another process made it.
        let handle = owned(unsafe { CreateMutexW(std::ptr::null(), 0, wide.as_ptr()) })
            .map_err(|e| with_context(e, &format!("opening the lock `{full_name}`")))?;
        let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
        // SAFETY: a valid mutex handle we own.
        let waited = unsafe { WaitForSingleObject(handle.as_raw_handle(), millis) };
        match waited {
            // WAIT_ABANDONED: the previous holder died holding it; we own it
            // now, and the guarded state is consistent (see the module docs).
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(NamedMutexGuard {
                handle,
                _not_send: std::marker::PhantomData,
            }),
            WIN32_WAIT_TIMEOUT => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "timed out after {}s waiting for the lock `{full_name}` \
                     (another termiHub process holds it)",
                    timeout.as_secs()
                ),
            )),
            WAIT_FAILED => Err(with_context(
                io::Error::last_os_error(),
                &format!("waiting for the lock `{full_name}`"),
            )),
            other => Err(io::Error::other(format!(
                "waiting for the lock `{full_name}`: unexpected result {other:#x}"
            ))),
        }
    }
}

fn with_context(error: io::Error, what: &str) -> io::Error {
    io::Error::new(error.kind(), format!("{what}: {error}"))
}

/// Ownership of a [`NamedMutex`], released on drop. `!Send`: a Win32 mutex
/// can only be released by the thread that owns it.
#[must_use = "the lock is released as soon as the guard drops"]
pub(crate) struct NamedMutexGuard {
    handle: OwnedHandle,
    _not_send: std::marker::PhantomData<*const ()>,
}

impl Drop for NamedMutexGuard {
    fn drop(&mut self) {
        // SAFETY: this thread owns the mutex (the guard cannot leave it).
        // A failure cannot be acted on; closing the handle below still
        // happens, and Windows abandons a mutex whose owner thread ends.
        unsafe { ReleaseMutex(self.handle.as_raw_handle()) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn unique(tag: &str) -> &'static str {
        Box::leak(format!("termiHub.Test.{tag}.{}", std::process::id()).into_boxed_str())
    }

    /// Another thread cannot take a held lock; it times out with a clear
    /// error, and gets it once the holder lets go.
    #[test]
    fn a_held_lock_times_out_elsewhere_and_frees_on_drop() {
        let name = unique("held");
        let guard = NamedMutex::new(name).lock().unwrap();
        let other = std::thread::spawn(move || {
            NamedMutex::new(name)
                .lock_within(Duration::from_millis(100))
                .map(drop)
        });
        let err = other.join().unwrap().unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert!(err.to_string().contains(name), "{err}");
        drop(guard);
        let other = std::thread::spawn(move || {
            NamedMutex::new(name)
                .lock_within(Duration::from_secs(5))
                .map(drop)
        });
        other.join().unwrap().unwrap();
    }

    /// A holder thread that ends without releasing abandons the mutex; the
    /// next waiter owns it and goes on.
    #[test]
    fn an_abandoned_lock_is_taken_over() {
        let name = unique("abandoned");
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let guard = NamedMutex::new(name).lock().unwrap();
            // Keep the handle open but end the owning thread: the mutex is
            // abandoned, as when a process dies holding it.
            std::mem::forget(guard);
            tx.send(()).unwrap();
        })
        .join()
        .unwrap();
        rx.recv().unwrap();
        let guard = NamedMutex::new(name).lock_within(Duration::from_secs(5));
        assert!(guard.is_ok(), "{:?}", guard.err());
    }
}
