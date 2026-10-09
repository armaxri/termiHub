//! Named supervision threads for a runner (#4335, ERR2-004).
//!
//! Every thread the host starts around a runner — stderr forwarder, frame
//! reader, watchdog, idle reaper, crash-recovery follow-up, bridge proxy pump
//! and writer — goes through [`spawn`], so a failed start is an `Err` the
//! caller must handle instead of a safety check that is silently off. Unit
//! tests inject a failure for one thread name with [`fail_spawns_named`].

use std::io;

/// Start `f` on a new thread called `name`.
pub(super) fn spawn<F>(name: String, f: F) -> io::Result<()>
where
    F: FnOnce() + Send + 'static,
{
    #[cfg(test)]
    if injected_failure(&name) {
        return Err(io::Error::other(format!(
            "injected failure starting {name}"
        )));
    }
    std::thread::Builder::new().name(name).spawn(f).map(drop)
}

#[cfg(test)]
thread_local! {
    /// Thread-name prefix whose spawns fail on this (test) thread.
    static FAIL_PREFIX: std::cell::RefCell<Option<String>> = const {
        std::cell::RefCell::new(None)
    };
}

#[cfg(test)]
fn injected_failure(name: &str) -> bool {
    FAIL_PREFIX.with(|prefix| {
        prefix
            .borrow()
            .as_deref()
            .is_some_and(|prefix| name.starts_with(prefix))
    })
}

/// Make every [`spawn`] from the calling thread whose name starts with
/// `prefix` fail, until the guard drops.
#[cfg(test)]
pub(super) fn fail_spawns_named(prefix: &str) -> FailGuard {
    FAIL_PREFIX.with(|p| *p.borrow_mut() = Some(prefix.to_owned()));
    FailGuard
}

/// Lifts a [`fail_spawns_named`] injection when dropped.
#[cfg(test)]
pub(super) struct FailGuard;

#[cfg(test)]
impl Drop for FailGuard {
    fn drop(&mut self) {
        FAIL_PREFIX.with(|p| *p.borrow_mut() = None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_injected_failure_hits_only_the_named_threads() {
        let (tx, rx) = std::sync::mpsc::channel();
        {
            let _fail = fail_spawns_named("plugin-runner-watchdog");
            assert!(spawn("plugin-runner-watchdog-x".to_owned(), || {}).is_err());
            let tx = tx.clone();
            spawn("plugin-runner-x".to_owned(), move || tx.send(1).unwrap()).unwrap();
        }
        spawn("plugin-runner-watchdog-x".to_owned(), move || {
            tx.send(2).unwrap()
        })
        .unwrap();
        let mut got: Vec<i32> = rx.iter().take(2).collect();
        got.sort_unstable();
        assert_eq!(got, [1, 2]);
    }
}
