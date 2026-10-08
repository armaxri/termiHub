//! A first-come, first-served lock for a channel's write half (#4233).
//!
//! Both ends of a runner channel funnel every sender through one writer: the
//! host's sessions, bridge replies and stream pumps; the runner's plugin
//! threads. `std::sync::Mutex` lets the thread that just unlocked take the
//! lock again before a woken waiter runs ("barging"). A sender writing in a
//! loop then keeps the channel for a run of frames while the others wait, and
//! concurrent sessions get very uneven shares of it: the nightly perf gate
//! measured a 2.3x spread between 40 echo sessions on Linux and 21x on
//! Windows (fastest 713 MB/s, slowest 33 MB/s).
//!
//! [`FairMutex::with`] unlocks with `parking_lot`'s fair unlock, which hands
//! the lock straight to the longest waiter when there is one, so senders take
//! turns in arrival order. Uncontended, it costs what a plain unlock does.

use parking_lot::{Mutex, MutexGuard};

/// A mutex whose every unlock is fair (see the module docs).
pub struct FairMutex<T: ?Sized> {
    inner: Mutex<T>,
}

impl<T> FairMutex<T> {
    /// A new unlocked mutex around `value`.
    pub fn new(value: T) -> Self {
        Self {
            inner: Mutex::new(value),
        }
    }
}

impl<T: ?Sized> FairMutex<T> {
    /// Run `f` with exclusive access, then hand the lock to the longest
    /// waiter (if any) rather than letting this thread take it straight back.
    pub fn with<R>(&self, f: impl FnOnce(&mut T) -> R) -> R {
        let mut guard = self.inner.lock();
        let result = f(&mut guard);
        MutexGuard::unlock_fair(guard);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::time::Duration;

    #[test]
    fn guards_exclusive_access() {
        let counter = Arc::new(FairMutex::new(0u64));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let counter = Arc::clone(&counter);
                std::thread::spawn(move || {
                    for _ in 0..10_000 {
                        counter.with(|c| *c += 1);
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(counter.with(|c| *c), 80_000);
    }

    /// Waiters get the lock in the order they asked for it, each handed it
    /// directly by the previous holder.
    #[test]
    fn waiters_are_served_in_arrival_order() {
        const WAITERS: usize = 6;
        let log = Arc::new(FairMutex::new(Vec::with_capacity(WAITERS)));
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let holder = {
            let log = Arc::clone(&log);
            std::thread::spawn(move || {
                log.with(|_| {
                    held_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                });
            })
        };
        held_rx.recv().unwrap();
        let waiters: Vec<_> = (0..WAITERS)
            .map(|id| {
                let log = Arc::clone(&log);
                let waiter = std::thread::spawn(move || log.with(|log| log.push(id)));
                // Long enough for this waiter to be queued before the next.
                std::thread::sleep(Duration::from_millis(50));
                waiter
            })
            .collect();
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        for waiter in waiters {
            waiter.join().unwrap();
        }
        assert_eq!(log.with(|log| log.clone()), (0..WAITERS).collect::<Vec<_>>());
    }

    /// A panic inside the critical section releases the lock for the next
    /// caller instead of wedging every later sender.
    #[test]
    fn a_panicking_holder_releases_the_lock() {
        let lock = Arc::new(FairMutex::new(0u32));
        let panicker = {
            let lock = Arc::clone(&lock);
            std::thread::spawn(move || lock.with(|_| panic!("holder panics")))
        };
        assert!(panicker.join().is_err());
        assert_eq!(lock.with(|v| *v + 1), 1);
    }

    /// The barging case: threads that re-lock in a tight loop, each holding
    /// the lock for a moment like a channel write, take near-equal turns
    /// instead of one of them keeping the lock.
    #[test]
    fn looping_lockers_take_turns() {
        const THREADS: usize = 4;
        const ROUNDS: usize = 400;
        let log = Arc::new(FairMutex::new(Vec::with_capacity(THREADS * ROUNDS)));
        let start = Arc::new(Barrier::new(THREADS));
        let threads: Vec<_> = (0..THREADS)
            .map(|id| {
                let log = Arc::clone(&log);
                let start = Arc::clone(&start);
                std::thread::spawn(move || {
                    start.wait();
                    for _ in 0..ROUNDS {
                        log.with(|log| {
                            log.push(id);
                            std::thread::sleep(Duration::from_micros(50));
                        });
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        // From the turn by which every thread has arrived, over the next half
        // of all turns (every thread still waiting to go again), no thread
        // takes the lock twice in a row more than rarely: it was handed on.
        let log = log.with(|log| log.clone());
        let all_in = (0..THREADS)
            .map(|id| log.iter().position(|&t| t == id).unwrap())
            .max()
            .unwrap();
        let window = &log[all_in..(all_in + THREADS * ROUNDS / 2).min(log.len())];
        let repeats = window.windows(2).filter(|w| w[0] == w[1]).count();
        assert!(
            repeats * 10 <= window.len(),
            "{repeats} of {} turns went straight back to the same thread",
            window.len()
        );
    }
}
