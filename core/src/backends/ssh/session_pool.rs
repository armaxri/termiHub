//! Reference-counted, single-flight pooling of shared SSH sessions.
//!
//! [`RefPool`] is a generic pool of cheaply-cloneable handles (typically
//! `Arc<_>`) keyed by a string. Every consumer that acquires the same key gets a
//! clone of the same value and bumps a reference count; the value is created at
//! most once per key even under concurrent acquisition (single-flight) and is
//! dropped from the pool when the last consumer releases it.
//!
//! On top of it, [`shared_gateway_pool`] is a process-wide pool of jump-host
//! gateway sessions ([`SshGateway`]) shared by the terminal connect path and the
//! desktop tunnel manager: connections that reach their target through the same
//! bastion reuse one gateway `russh` session instead of each dialing their own.

use std::collections::HashMap;
use std::future::Future;
use std::ops::Deref;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tokio::sync::Mutex as AsyncMutex;

use super::handler::{ForwardedChannelRegistry, SshSession};

/// One pooled value together with its live-consumer reference count.
///
/// `generation` disambiguates successive entries under the same key: when a dead
/// entry is evicted and replaced (see [`RefPool::get_or_create_live`]), the
/// replacement gets a fresh generation, so a stale [`PooledRef`] from the evicted
/// entry releases as a no-op instead of decrementing the replacement (#1315).
struct Entry<T> {
    value: T,
    ref_count: usize,
    generation: u64,
}

/// A reference-counted, single-flight pool of cloneable values keyed by string.
///
/// `T` is expected to be a cheaply-cloneable shared handle (e.g. `Arc<_>`): each
/// consumer that acquires a key receives a clone of the same `T` and increments
/// the reference count. Creation runs at most once per key even when several
/// callers race ([`get_or_create`](Self::get_or_create) is single-flight), and the
/// entry is removed once the last [`PooledRef`] for the key is dropped.
///
/// Always used behind an [`Arc`] (see [`RefPool::new`]) so the [`PooledRef`]
/// returned to consumers can hold the pool alive and release on drop.
pub struct RefPool<T: Clone> {
    entries: Mutex<HashMap<String, Entry<T>>>,
    /// Per-key async gates ensuring only one creation runs at a time for a key.
    gates: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    /// Monotonic source of per-entry generations (see [`Entry::generation`]).
    next_generation: AtomicU64,
}

impl<T: Clone> RefPool<T> {
    /// Create a new, empty pool wrapped in an [`Arc`].
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            entries: Mutex::new(HashMap::new()),
            gates: Mutex::new(HashMap::new()),
            next_generation: AtomicU64::new(0),
        })
    }

    /// Acquire the value for `key`, creating it via `connect` only if absent.
    ///
    /// If an entry already exists its reference count is incremented and a clone
    /// is returned without calling `connect`. Otherwise `connect` is run to
    /// create the value. Even when many callers race on the same key, `connect`
    /// runs **exactly once** (single-flight): the losers wait for the winner and
    /// clone its value. The returned [`PooledRef`] holds one reference; dropping
    /// it returns the reference to the pool.
    pub async fn get_or_create<F, Fut, E>(
        self: &Arc<Self>,
        key: &str,
        connect: F,
    ) -> Result<PooledRef<T>, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, E>>,
    {
        self.get_or_create_live(key, |_| true, connect).await
    }

    /// Like [`get_or_create`](Self::get_or_create), but skip and **evict** a
    /// cached entry that `is_alive` reports dead, creating a fresh value instead.
    ///
    /// A pooled SSH session can die while a dying consumer's [`PooledRef`] is
    /// still in flight (the entry outlives the session until its refcount drops).
    /// Without this check, a new acquirer for the same key would adopt that dead
    /// session and fail immediately; here it dials a fresh one. The evicted
    /// entry's generation is retired, so the stale references release harmlessly
    /// (#1315).
    pub async fn get_or_create_live<P, F, Fut, E>(
        self: &Arc<Self>,
        key: &str,
        is_alive: P,
        connect: F,
    ) -> Result<PooledRef<T>, E>
    where
        P: Fn(&T) -> bool,
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, E>>,
    {
        if let Some((value, generation)) = self.try_acquire(key, &is_alive) {
            return Ok(self.make_ref(key, value, generation));
        }

        // Single-flight: only one creator per key proceeds past the gate; the
        // others block here and re-check the map once the winner inserts.
        let gate = self.gate_for(key);
        let _guard = gate.lock().await;

        if let Some((value, generation)) = self.try_acquire(key, &is_alive) {
            return Ok(self.make_ref(key, value, generation));
        }

        let value = connect().await?;
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        {
            let mut entries = self.entries.lock().expect("session pool mutex poisoned");
            entries.insert(
                key.to_string(),
                Entry {
                    value: value.clone(),
                    ref_count: 1,
                    generation,
                },
            );
        }
        Ok(self.make_ref(key, value, generation))
    }

    /// Increment the ref count and clone the live value if the key is present.
    ///
    /// Returns the value together with its entry generation. If the cached entry
    /// is present but `is_alive` reports it dead, it is evicted (removed from the
    /// map) and `None` is returned so the caller creates a fresh value; the
    /// evicted value is dropped outside the lock to avoid `Drop` re-entrancy.
    fn try_acquire(&self, key: &str, is_alive: &impl Fn(&T) -> bool) -> Option<(T, u64)> {
        let evicted = {
            let mut entries = self.entries.lock().expect("session pool mutex poisoned");
            match entries.get_mut(key) {
                None => return None,
                Some(entry) => {
                    if is_alive(&entry.value) {
                        entry.ref_count += 1;
                        return Some((entry.value.clone(), entry.generation));
                    }
                    // Dead: retire this generation so a fresh session is dialed.
                    // Existing PooledRefs keep their own clones alive and release
                    // as no-ops (their generation no longer matches).
                    entries.remove(key)
                }
            }
        };
        drop(evicted); // dropped outside the entries lock
        None
    }

    fn gate_for(&self, key: &str) -> Arc<AsyncMutex<()>> {
        let mut gates = self
            .gates
            .lock()
            .expect("session pool gates mutex poisoned");
        gates
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    fn make_ref(self: &Arc<Self>, key: &str, value: T, generation: u64) -> PooledRef<T> {
        PooledRef {
            value,
            key: key.to_string(),
            generation,
            pool: Arc::clone(self),
        }
    }

    /// Release one reference for `key`'s entry of `generation`. When the count
    /// reaches zero the entry is removed and its value dropped.
    ///
    /// A `generation` that no longer matches the entry at `key` (the entry was
    /// evicted-and-replaced while this reference was in flight, #1315) is a no-op,
    /// so a stale reference never decrements the replacement entry.
    ///
    /// The removed value is dropped *outside* the entries lock so that a value
    /// whose `Drop` re-enters the pool (e.g. a pooled session that itself holds a
    /// [`PooledRef`] to a gateway) cannot deadlock on the non-reentrant mutex.
    pub fn release(&self, key: &str, generation: u64) {
        let removed = {
            let mut entries = self.entries.lock().expect("session pool mutex poisoned");
            match entries.get_mut(key) {
                Some(entry) if entry.generation == generation => {
                    entry.ref_count = entry.ref_count.saturating_sub(1);
                    if entry.ref_count == 0 {
                        entries.remove(key)
                    } else {
                        None
                    }
                }
                _ => None,
            }
        };
        if removed.is_some() {
            self.gates
                .lock()
                .expect("session pool gates mutex poisoned")
                .remove(key);
        }
        drop(removed); // value dropped here, outside the entries lock
    }

    /// Current reference count for `key` (0 if absent).
    pub fn ref_count(&self, key: &str) -> usize {
        self.entries
            .lock()
            .expect("session pool mutex poisoned")
            .get(key)
            .map(|e| e.ref_count)
            .unwrap_or(0)
    }

    /// Number of live pooled entries.
    pub fn len(&self) -> usize {
        self.entries
            .lock()
            .expect("session pool mutex poisoned")
            .len()
    }

    /// Whether the pool holds no live entries.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// A live reference to a pooled value.
///
/// Derefs to the pooled `T`. Dropping it releases one reference back to the
/// pool, dropping the underlying value once the last reference is gone.
pub struct PooledRef<T: Clone> {
    value: T,
    key: String,
    /// Generation of the pool entry this reference was issued against; releases
    /// only affect a matching entry (see [`RefPool::release`]).
    generation: u64,
    pool: Arc<RefPool<T>>,
}

impl<T: Clone> PooledRef<T> {
    /// The pool key backing this reference.
    pub fn key(&self) -> &str {
        &self.key
    }
}

impl<T: Clone> Deref for PooledRef<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.value
    }
}

impl<T: Clone> Drop for PooledRef<T> {
    fn drop(&mut self) {
        self.pool.release(&self.key, self.generation);
    }
}

/// A pooled jump-host gateway: the authenticated session on the innermost
/// gateway hop, plus the outer-hop sessions kept alive to hold the chain open.
///
/// A target session reaches the final host by opening a `direct-tcpip` channel
/// on [`session`](Self::session). The [`intermediate_sessions`](Self::intermediate_sessions)
/// must stay alive for as long as `session` is used: dropping them tears down the
/// `direct-tcpip` channels that carry it.
pub struct SshGateway {
    /// Authenticated session on the innermost gateway hop.
    pub session: SshSession,
    /// Forwarded-channel registry of the innermost gateway session.
    pub registry: ForwardedChannelRegistry,
    /// Outer-hop sessions kept alive to hold the chain open (empty for a
    /// single-hop gateway).
    pub intermediate_sessions: Vec<SshSession>,
}

/// The process-wide pool of jump-host gateway sessions.
///
/// Shared by the terminal connect path ([`super::connector`]) and the desktop
/// tunnel manager so that multiple connections reaching their targets through the
/// same bastion reuse a single gateway `russh` session (reference-counted).
pub fn shared_gateway_pool() -> Arc<RefPool<Arc<SshGateway>>> {
    static POOL: OnceLock<Arc<RefPool<Arc<SshGateway>>>> = OnceLock::new();
    POOL.get_or_init(RefPool::new).clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn new_pool_is_empty() {
        let pool = RefPool::<Arc<i32>>::new();
        assert!(pool.is_empty());
        assert_eq!(pool.ref_count("missing"), 0);
    }

    #[tokio::test]
    async fn release_unknown_key_is_noop() {
        let pool = RefPool::<Arc<i32>>::new();
        pool.release("missing", 0);
        assert!(pool.is_empty());
    }

    #[tokio::test]
    async fn reuses_one_value_across_consumers() {
        let pool = RefPool::<Arc<i32>>::new();
        let creates = Arc::new(AtomicUsize::new(0));

        let c1 = creates.clone();
        let a = pool
            .get_or_create("k", || async move {
                c1.fetch_add(1, Ordering::SeqCst);
                Ok::<_, ()>(Arc::new(7))
            })
            .await
            .unwrap();

        let c2 = creates.clone();
        let b = pool
            .get_or_create("k", || async move {
                c2.fetch_add(1, Ordering::SeqCst);
                Ok::<_, ()>(Arc::new(99))
            })
            .await
            .unwrap();

        // Created once; the second consumer reused the first value.
        assert_eq!(creates.load(Ordering::SeqCst), 1);
        assert!(Arc::ptr_eq(&a, &b));
        assert_eq!(**a, 7);
        assert_eq!(pool.ref_count("k"), 2);
        assert_eq!(pool.len(), 1);
    }

    #[tokio::test]
    async fn drains_when_last_reference_released() {
        let pool = RefPool::<Arc<i32>>::new();
        let a = pool
            .get_or_create("k", || async { Ok::<_, ()>(Arc::new(1)) })
            .await
            .unwrap();
        let b = pool
            .get_or_create("k", || async { Ok::<_, ()>(Arc::new(1)) })
            .await
            .unwrap();
        assert_eq!(pool.ref_count("k"), 2);

        drop(a);
        assert_eq!(pool.ref_count("k"), 1);
        assert!(!pool.is_empty());

        drop(b);
        assert_eq!(pool.ref_count("k"), 0);
        assert!(pool.is_empty());
    }

    #[tokio::test]
    async fn drops_value_when_drained() {
        struct Tracked(Arc<AtomicUsize>);
        impl Drop for Tracked {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }

        let drops = Arc::new(AtomicUsize::new(0));
        let pool = RefPool::<Arc<Tracked>>::new();
        let d = drops.clone();
        let r = pool
            .get_or_create(
                "k",
                move || async move { Ok::<_, ()>(Arc::new(Tracked(d))) },
            )
            .await
            .unwrap();
        assert_eq!(drops.load(Ordering::SeqCst), 0);

        drop(r);
        assert_eq!(pool.ref_count("k"), 0);
        assert_eq!(drops.load(Ordering::SeqCst), 1);
    }

    /// Concurrent acquisition of the same key must create exactly one value —
    /// the property the issue requires for simultaneous reconnects through one
    /// gateway.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn creates_one_value_under_concurrent_acquire() {
        let pool = RefPool::<Arc<i32>>::new();
        let creates = Arc::new(AtomicUsize::new(0));

        let mut handles = Vec::new();
        for _ in 0..8 {
            let pool = pool.clone();
            let creates = creates.clone();
            handles.push(tokio::spawn(async move {
                pool.get_or_create("k", || async move {
                    creates.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    Ok::<_, ()>(Arc::new(42))
                })
                .await
                .unwrap()
            }));
        }

        let mut refs = Vec::new();
        for h in handles {
            refs.push(h.await.unwrap());
        }

        assert_eq!(
            creates.load(Ordering::SeqCst),
            1,
            "gateway session must be created exactly once under concurrency"
        );
        assert_eq!(pool.ref_count("k"), 8);
        assert!(refs.iter().all(|r| Arc::ptr_eq(r, &refs[0])));
    }

    /// A dead cached entry must not be handed to a new acquirer: the pool evicts
    /// it and dials a fresh value, and the dead entry's stale reference releases
    /// as a no-op instead of corrupting the replacement's refcount (#1315).
    #[tokio::test]
    async fn dead_cached_entry_is_evicted_and_replaced() {
        use std::sync::atomic::AtomicBool;

        // The pooled value carries its own liveness flag (`true` = alive).
        let pool = RefPool::<Arc<AtomicBool>>::new();
        let alive = |v: &Arc<AtomicBool>| v.load(Ordering::SeqCst);
        let creates = Arc::new(AtomicUsize::new(0));
        let make = || {
            let creates = creates.clone();
            || async move {
                creates.fetch_add(1, Ordering::SeqCst);
                Ok::<_, ()>(Arc::new(AtomicBool::new(true)))
            }
        };

        // First acquire dials E1 (alive).
        let e1 = pool.get_or_create_live("k", alive, make()).await.unwrap();
        assert_eq!(creates.load(Ordering::SeqCst), 1);
        assert_eq!(pool.ref_count("k"), 1);

        // E1's session dies.
        e1.store(false, Ordering::SeqCst);

        // A new acquire for the same key must dial a fresh E2, not adopt the corpse.
        let e2 = pool.get_or_create_live("k", alive, make()).await.unwrap();
        assert_eq!(
            creates.load(Ordering::SeqCst),
            2,
            "must dial a fresh session"
        );
        assert!(
            !Arc::ptr_eq(&e1, &e2),
            "must not hand out the dead endpoint"
        );
        assert!(e2.load(Ordering::SeqCst), "the fresh endpoint is alive");
        assert_eq!(pool.ref_count("k"), 1, "only the fresh entry is counted");

        // Dropping the stale E1 reference must not disturb E2's entry.
        drop(e1);
        assert_eq!(
            pool.ref_count("k"),
            1,
            "stale release is a no-op for the new gen"
        );
        assert!(!pool.is_empty());

        drop(e2);
        assert_eq!(pool.ref_count("k"), 0);
        assert!(pool.is_empty());
    }

    /// A live cached entry is still reused (the liveness check does not force a
    /// redial when the session is healthy).
    #[tokio::test]
    async fn live_cached_entry_is_reused() {
        use std::sync::atomic::AtomicBool;
        let pool = RefPool::<Arc<AtomicBool>>::new();
        let alive = |v: &Arc<AtomicBool>| v.load(Ordering::SeqCst);
        let creates = Arc::new(AtomicUsize::new(0));

        let c1 = creates.clone();
        let a = pool
            .get_or_create_live("k", alive, || async move {
                c1.fetch_add(1, Ordering::SeqCst);
                Ok::<_, ()>(Arc::new(AtomicBool::new(true)))
            })
            .await
            .unwrap();
        let c2 = creates.clone();
        let b = pool
            .get_or_create_live("k", alive, || async move {
                c2.fetch_add(1, Ordering::SeqCst);
                Ok::<_, ()>(Arc::new(AtomicBool::new(true)))
            })
            .await
            .unwrap();

        assert_eq!(creates.load(Ordering::SeqCst), 1, "healthy entry is reused");
        assert!(Arc::ptr_eq(&a, &b));
        assert_eq!(pool.ref_count("k"), 2);
    }

    /// A connect failure must not poison the key: a later acquisition retries.
    #[tokio::test]
    async fn failed_connect_leaves_no_entry_and_allows_retry() {
        let pool = RefPool::<Arc<i32>>::new();
        let first = pool
            .get_or_create("k", || async { Err::<Arc<i32>, ()>(()) })
            .await;
        assert!(first.is_err());
        assert!(pool.is_empty());

        let second = pool
            .get_or_create("k", || async { Ok::<_, ()>(Arc::new(5)) })
            .await
            .unwrap();
        assert_eq!(**second, 5);
        assert_eq!(pool.ref_count("k"), 1);
    }
}
