//! A first-come, first-served lock for a channel's write half (#4233, #4260).
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
//! [`FairMutex`] queues every caller that finds the lock held at once, and
//! the holder hands the lock straight to the longest waiter, so senders take
//! turns in arrival order. Uncontended, it costs two uncontended mutex
//! round trips.
//!
//! **Why not `parking_lot`'s fair unlock** (the first fix, #4256): a
//! `parking_lot` waiter spins and then calls `yield_now` a few times before it
//! parks, and a fair unlock hands over only to *parked* threads. On an
//! oversubscribed macOS machine each yield can leave a thread off the CPU for
//! a whole ~10 ms quantum, so a hot sender kept re-taking the lock while the
//! others were still yielding, not yet queued: the 3-vCPU macOS runner
//! measured 21-91x between 40 sessions with it, 1.8-3.2x with a plain (barging)
//! mutex, and the same Mac at 10 cores under load 23x (#4260). Here a caller
//! is queued before it ever gives up the CPU.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::{self, Thread};

/// A mutex that hands over in arrival order (see the module docs).
pub struct FairMutex<T: ?Sized> {
    turns: Mutex<Turns>,
    /// Only ever locked by the turn holder, so never contended.
    value: Mutex<T>,
}

/// Who holds the turn and who is queued for it.
#[derive(Default)]
struct Turns {
    held: bool,
    waiting: VecDeque<Arc<Waiter>>,
}

/// One queued caller: set `granted`, then unpark `thread`.
struct Waiter {
    granted: AtomicBool,
    thread: Thread,
}

/// Hands the turn on when dropped, also when the critical section panics.
struct Turn<'a>(&'a Mutex<Turns>);

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        let next = {
            let mut turns = lock(self.0);
            let next = turns.waiting.pop_front();
            // A waiter inherits the turn; nobody waiting frees it.
            turns.held = next.is_some();
            next
        };
        if let Some(next) = next {
            next.granted.store(true, Ordering::Release);
            next.thread.unpark();
        }
    }
}

fn lock<T: ?Sized>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl<T> FairMutex<T> {
    /// A new unlocked mutex around `value`.
    pub fn new(value: T) -> Self {
        Self {
            turns: Mutex::new(Turns::default()),
            value: Mutex::new(value),
        }
    }
}

impl<T: ?Sized> FairMutex<T> {
    /// Run `f` with exclusive access, then hand the lock to the longest
    /// waiter (if any) rather than letting this thread take it straight back.
    pub fn with<R>(&self, f: impl FnOnce(&mut T) -> R) -> R {
        let _turn = self.take_turn();
        // Declared after `_turn`, so dropped (unlocked) before the hand-over.
        let mut value = lock(&self.value);
        f(&mut value)
    }

    /// Take the turn now, or queue for it and sleep until it is handed over.
    fn take_turn(&self) -> Turn<'_> {
        let waiter = {
            let mut turns = lock(&self.turns);
            if !turns.held {
                turns.held = true;
                return Turn(&self.turns);
            }
            let waiter = Arc::new(Waiter {
                granted: AtomicBool::new(false),
                thread: thread::current(),
            });
            turns.waiting.push_back(Arc::clone(&waiter));
            waiter
        };
        // `park` may wake spuriously; only the hand-over sets `granted`.
        while !waiter.granted.load(Ordering::Acquire) {
            thread::park();
        }
        Turn(&self.turns)
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
