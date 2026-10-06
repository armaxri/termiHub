//! Run blocking OS-keyring calls off the async runtime.
//!
//! `keyring`'s `Entry` API is synchronous. On Linux its Secret Service backend
//! (`async-secret-service` + `tokio`) drives the D-Bus exchange by building a
//! private Tokio runtime and blocking on it (`zbus::block_on`). Tokio forbids
//! that on a thread that is already inside a runtime: the call panics with
//! "Cannot start a runtime from within a runtime". Async Tauri commands run on
//! the Tokio worker pool, so any keyring access reached from one — changing the
//! master password or switching the credential store (both drop the biometric
//! unlock key), reading an OS-keychain credential during a connect — panicked
//! there, and the command never answered (the 2026-10-06 nightly: "Changing…"
//! never finished on Linux).
//!
//! [`off_runtime`] runs such a call on a short-lived plain thread whenever the
//! caller is inside a runtime, and inline otherwise (sync commands run on the
//! main thread, which has no runtime).

/// Run `f` where a blocking keyring call is allowed: inline when the current
/// thread is not inside a Tokio runtime, else on a scoped helper thread that is
/// joined before returning. A panic in `f` is propagated to the caller.
pub(crate) fn off_runtime<T, F>(f: F) -> T
where
    F: FnOnce() -> T + Send,
    T: Send,
{
    if tokio::runtime::Handle::try_current().is_err() {
        return f();
    }
    std::thread::scope(|scope| match scope.spawn(f).join() {
        Ok(value) => value,
        Err(panic) => std::panic::resume_unwind(panic),
    })
}

#[cfg(test)]
mod tests {
    use super::off_runtime;

    /// What the Secret Service backend does under the hood: build a private
    /// runtime and block on it.
    fn block_on_private_runtime() -> u32 {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("private runtime")
            .block_on(async { 42 })
    }

    #[test]
    fn runs_inline_outside_a_runtime() {
        let caller = std::thread::current().id();
        let ran_on = off_runtime(|| std::thread::current().id());
        assert_eq!(ran_on, caller);
        assert_eq!(off_runtime(block_on_private_runtime), 42);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_private_block_on_inside_an_async_command_does_not_panic() {
        // Regression (#4017): called straight from a Tokio worker this panics
        // with "Cannot start a runtime from within a runtime".
        assert!(std::panic::catch_unwind(block_on_private_runtime).is_err());
        assert_eq!(off_runtime(block_on_private_runtime), 42);
    }

    #[tokio::test]
    async fn moves_off_the_runtime_thread_and_back() {
        let caller = std::thread::current().id();
        let (ran_on, in_runtime) = off_runtime(|| {
            (
                std::thread::current().id(),
                tokio::runtime::Handle::try_current().is_ok(),
            )
        });
        assert_ne!(ran_on, caller);
        assert!(!in_runtime);
    }

    #[tokio::test]
    async fn propagates_a_panic() {
        let result = std::panic::catch_unwind(|| off_runtime(|| panic!("boom")));
        assert!(result.is_err());
    }
}
