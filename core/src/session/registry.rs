//! Thin, generic session-ownership container shared by the desktop and agent.
//!
//! Both runtimes keep a map from session id to a tier-specific entry that owns
//! the live transport (desktop `SessionEntry`, agent `SessionInfo`). The entry
//! types and — crucially — the *settle* semantics differ between the tiers: the
//! desktop removes an entry when its session exits on its own, while the agent
//! retains it as `Exited`. Those policies are deliberately **not** unified here
//! (finding DUP-010, #3095).
//!
//! [`Sessions`] offers only the mechanical, side-effect-free operations both
//! tiers share:
//!
//! - plain map operations (insert / remove / get / len / iteration),
//! - a capacity guard ([`Sessions::try_reserve`]) paired with an in-flight
//!   [`Reservations`] set, so a slow connect that runs *without* holding the
//!   map's lock still counts toward the session cap (CONC-004), and
//! - a [`Sessions::reconcile`] skeleton that applies a caller-supplied action to
//!   every entry matching a caller-supplied predicate. The action stays
//!   tier-specific; the container never decides what "settling" means.
//!
//! The container performs no I/O, emits no events and holds no locks; callers
//! wrap it in whatever synchronisation their tier needs.

use std::collections::hash_map;
use std::collections::{HashMap, HashSet};
use std::fmt;

/// Error returned by [`Sessions::try_reserve`] when live sessions plus in-flight
/// reservations already fill the configured capacity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapacityReached {
    /// The capacity that was exceeded.
    pub max: usize,
}

impl fmt::Display for CapacityReached {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "session capacity reached (max {})", self.max)
    }
}

impl std::error::Error for CapacityReached {}

/// Ids of sessions whose creation is in flight: a slot has been reserved via
/// [`Sessions::try_reserve`] but the entry is not yet registered.
///
/// Kept separate from [`Sessions`] so a tier can guard it with its own lock and
/// release a reservation without re-taking the map's lock.
#[derive(Debug, Default, Clone)]
pub struct Reservations {
    ids: HashSet<String>,
}

impl Reservations {
    /// Create an empty reservation set.
    pub fn new() -> Self {
        Self::default()
    }

    /// Release the reservation for `id`. Returns `true` if it was held.
    ///
    /// Call this once the session is registered or its creation failed, so a
    /// failed create never leaks a slot.
    pub fn release(&mut self, id: &str) -> bool {
        self.ids.remove(id)
    }

    /// Alias for [`Reservations::release`], matching `HashSet::remove`.
    pub fn remove(&mut self, id: &str) -> bool {
        self.release(id)
    }

    /// Whether a reservation for `id` is held.
    pub fn contains(&self, id: &str) -> bool {
        self.ids.contains(id)
    }

    /// Number of in-flight reservations.
    pub fn len(&self) -> usize {
        self.ids.len()
    }

    /// Whether no reservations are held.
    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }
}

/// A generic map from session id to a tier-specific entry `E`.
///
/// See the [module documentation](self) for what this container does and —
/// just as importantly — does not do.
#[derive(Debug, Clone)]
pub struct Sessions<E> {
    map: HashMap<String, E>,
}

impl<E> Default for Sessions<E> {
    fn default() -> Self {
        Self {
            map: HashMap::new(),
        }
    }
}

impl<E> Sessions<E> {
    /// Create an empty container.
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert `entry` under `id`, returning the entry it replaced, if any.
    pub fn insert(&mut self, id: impl Into<String>, entry: E) -> Option<E> {
        self.map.insert(id.into(), entry)
    }

    /// Remove and return the entry for `id`.
    pub fn remove(&mut self, id: &str) -> Option<E> {
        self.map.remove(id)
    }

    /// Borrow the entry for `id`.
    pub fn get(&self, id: &str) -> Option<&E> {
        self.map.get(id)
    }

    /// Mutably borrow the entry for `id`.
    pub fn get_mut(&mut self, id: &str) -> Option<&mut E> {
        self.map.get_mut(id)
    }

    /// Whether an entry for `id` exists.
    pub fn contains_key(&self, id: &str) -> bool {
        self.map.contains_key(id)
    }

    /// Number of registered entries (in-flight reservations excluded).
    pub fn len(&self) -> usize {
        self.map.len()
    }

    /// Whether no entries are registered.
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// Iterate over `(id, entry)` pairs in unspecified order.
    pub fn iter(&self) -> hash_map::Iter<'_, String, E> {
        self.map.iter()
    }

    /// Iterate mutably over `(id, entry)` pairs in unspecified order.
    pub fn iter_mut(&mut self) -> hash_map::IterMut<'_, String, E> {
        self.map.iter_mut()
    }

    /// Iterate over the registered ids.
    pub fn keys(&self) -> hash_map::Keys<'_, String, E> {
        self.map.keys()
    }

    /// Iterate over the entries.
    pub fn values(&self) -> hash_map::Values<'_, String, E> {
        self.map.values()
    }

    /// Iterate mutably over the entries.
    pub fn values_mut(&mut self) -> hash_map::ValuesMut<'_, String, E> {
        self.map.values_mut()
    }

    /// Remove every entry, yielding `(id, entry)` pairs.
    pub fn drain(&mut self) -> hash_map::Drain<'_, String, E> {
        self.map.drain()
    }

    /// Whether one more session fits: `len() + reservations.len() < max`.
    pub fn has_capacity(&self, reservations: &Reservations, max: usize) -> bool {
        self.map.len() + reservations.len() < max
    }

    /// Reserve a slot for an in-flight create of `id`.
    ///
    /// Enforces `max` across registered entries **and** existing reservations,
    /// so concurrent creates cannot overshoot the cap while their (possibly
    /// slow) bring-up runs without holding the caller's lock. On success the
    /// id is recorded in `reservations`; the caller must
    /// [`release`](Reservations::release) it once the session is registered or
    /// the create fails.
    pub fn try_reserve(
        &self,
        reservations: &mut Reservations,
        id: impl Into<String>,
        max: usize,
    ) -> Result<(), CapacityReached> {
        if !self.has_capacity(reservations, max) {
            return Err(CapacityReached { max });
        }
        reservations.ids.insert(id.into());
        Ok(())
    }

    /// Apply `action` to every entry for which `pred` returns `true`, returning
    /// how many entries were acted on.
    ///
    /// This is only the traversal skeleton: *what* a matching entry means and
    /// *how* it is settled are entirely up to the caller (the agent, for
    /// example, flips an exited session's status to `Exited` and retains it).
    /// The container never removes entries here.
    pub fn reconcile<P, A>(&mut self, mut pred: P, mut action: A) -> usize
    where
        P: FnMut(&str, &E) -> bool,
        A: FnMut(&str, &mut E),
    {
        let mut acted = 0;
        for (id, entry) in self.map.iter_mut() {
            if pred(id, entry) {
                action(id, entry);
                acted += 1;
            }
        }
        acted
    }
}

impl<'a, E> IntoIterator for &'a Sessions<E> {
    type Item = (&'a String, &'a E);
    type IntoIter = hash_map::Iter<'a, String, E>;

    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}

impl<'a, E> IntoIterator for &'a mut Sessions<E> {
    type Item = (&'a String, &'a mut E);
    type IntoIter = hash_map::IterMut<'a, String, E>;

    fn into_iter(self) -> Self::IntoIter {
        self.iter_mut()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Status {
        Running,
        Exited,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct Entry {
        status: Status,
        alive: bool,
    }

    fn entry(status: Status, alive: bool) -> Entry {
        Entry { status, alive }
    }

    #[test]
    fn new_is_empty() {
        let s: Sessions<Entry> = Sessions::new();
        assert!(s.is_empty());
        assert_eq!(s.len(), 0);
        assert_eq!(s.iter().count(), 0);
        let d: Sessions<Entry> = Sessions::default();
        assert!(d.is_empty());
    }

    #[test]
    fn insert_get_remove_round_trip() {
        let mut s = Sessions::new();
        assert!(s.insert("a", entry(Status::Running, true)).is_none());
        assert_eq!(s.len(), 1);
        assert!(s.contains_key("a"));
        assert_eq!(s.get("a"), Some(&entry(Status::Running, true)));
        assert_eq!(s.remove("a"), Some(entry(Status::Running, true)));
        assert!(s.is_empty());
        assert!(!s.contains_key("a"));
        assert!(s.remove("a").is_none());
        assert!(s.get("a").is_none());
    }

    #[test]
    fn insert_replaces_and_returns_previous() {
        let mut s = Sessions::new();
        s.insert("a".to_string(), entry(Status::Running, true));
        let prev = s.insert("a", entry(Status::Exited, false));
        assert_eq!(prev, Some(entry(Status::Running, true)));
        assert_eq!(s.len(), 1);
        assert_eq!(s.get("a").unwrap().status, Status::Exited);
    }

    #[test]
    fn get_mut_mutates_in_place() {
        let mut s = Sessions::new();
        s.insert("a", entry(Status::Running, true));
        s.get_mut("a").unwrap().alive = false;
        assert!(!s.get("a").unwrap().alive);
        assert!(s.get_mut("missing").is_none());
    }

    #[test]
    fn iteration_covers_every_entry() {
        let mut s = Sessions::new();
        for id in ["a", "b", "c"] {
            s.insert(id, entry(Status::Running, true));
        }
        let mut keys: Vec<_> = s.keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["a", "b", "c"]);
        assert_eq!(s.values().count(), 3);
        assert_eq!(s.iter().count(), 3);
        assert_eq!((&s).into_iter().count(), 3);

        for e in s.values_mut() {
            e.alive = false;
        }
        assert!(s.values().all(|e| !e.alive));

        for (_, e) in &mut s {
            e.alive = true;
        }
        assert!(s.iter().all(|(_, e)| e.alive));

        for (id, e) in s.iter_mut() {
            if id == "b" {
                e.status = Status::Exited;
            }
        }
        assert_eq!(s.get("b").unwrap().status, Status::Exited);
    }

    #[test]
    fn drain_empties_and_yields_all() {
        let mut s = Sessions::new();
        s.insert("a", entry(Status::Running, true));
        s.insert("b", entry(Status::Running, true));
        let mut drained: Vec<_> = s.drain().map(|(id, _)| id).collect();
        drained.sort();
        assert_eq!(drained, ["a", "b"]);
        assert!(s.is_empty());
    }

    #[test]
    fn try_reserve_counts_entries_and_reservations() {
        let mut s = Sessions::new();
        let mut r = Reservations::new();
        s.insert("live", entry(Status::Running, true));

        assert!(s.has_capacity(&r, 3));
        s.try_reserve(&mut r, "p1", 3).unwrap();
        s.try_reserve(&mut r, "p2", 3).unwrap();
        assert_eq!(r.len(), 2);
        assert!(r.contains("p1"));
        assert!(!s.has_capacity(&r, 3));

        let err = s.try_reserve(&mut r, "p3", 3).unwrap_err();
        assert_eq!(err, CapacityReached { max: 3 });
        assert_eq!(err.to_string(), "session capacity reached (max 3)");
        assert!(
            !r.contains("p3"),
            "a refused reservation must not be recorded"
        );
        assert_eq!(r.len(), 2);
    }

    #[test]
    fn released_reservation_frees_the_slot() {
        let s: Sessions<Entry> = Sessions::new();
        let mut r = Reservations::new();
        s.try_reserve(&mut r, "p1", 1).unwrap();
        assert!(s.try_reserve(&mut r, "p2", 1).is_err());

        assert!(r.release("p1"));
        assert!(!r.release("p1"), "double release reports not-held");
        assert!(r.is_empty());
        s.try_reserve(&mut r, "p2", 1).unwrap();
        assert!(r.remove("p2"));
        assert!(r.is_empty());
    }

    #[test]
    fn promoting_a_reservation_keeps_the_count_stable() {
        let mut s = Sessions::new();
        let mut r = Reservations::new();
        s.try_reserve(&mut r, "p1", 2).unwrap();
        // Register the finished session and drop its reservation: the total
        // occupied slots stay at one throughout.
        r.release("p1");
        s.insert("p1", entry(Status::Running, true));
        assert_eq!(s.len() + r.len(), 1);
        assert!(s.has_capacity(&r, 2));
        assert!(!s.has_capacity(&r, 1));
    }

    #[test]
    fn zero_capacity_refuses_everything() {
        let s: Sessions<Entry> = Sessions::new();
        let mut r = Reservations::new();
        assert!(!s.has_capacity(&r, 0));
        assert!(s.try_reserve(&mut r, "x", 0).is_err());
    }

    #[test]
    fn reconcile_acts_only_on_matching_entries_and_retains_all() {
        let mut s = Sessions::new();
        s.insert("alive", entry(Status::Running, true));
        s.insert("dead", entry(Status::Running, false));
        s.insert("already", entry(Status::Exited, false));

        let acted = s.reconcile(
            |_, e| e.status == Status::Running && !e.alive,
            |_, e| e.status = Status::Exited,
        );

        assert_eq!(acted, 1);
        assert_eq!(s.len(), 3, "reconcile never removes entries");
        assert_eq!(s.get("alive").unwrap().status, Status::Running);
        assert_eq!(s.get("dead").unwrap().status, Status::Exited);
        assert_eq!(s.get("already").unwrap().status, Status::Exited);
    }

    #[test]
    fn reconcile_is_idempotent_for_a_settling_action() {
        let mut s = Sessions::new();
        s.insert("dead", entry(Status::Running, false));
        let pred = |_: &str, e: &Entry| e.status == Status::Running && !e.alive;
        let act = |_: &str, e: &mut Entry| e.status = Status::Exited;
        assert_eq!(s.reconcile(pred, act), 1);
        assert_eq!(s.reconcile(pred, act), 0);
    }

    #[test]
    fn reconcile_passes_ids_and_handles_empty() {
        let mut empty: Sessions<Entry> = Sessions::new();
        assert_eq!(empty.reconcile(|_, _| true, |_, _| {}), 0);

        let mut s = Sessions::new();
        s.insert("a", entry(Status::Running, true));
        s.insert("b", entry(Status::Running, true));
        let mut seen = Vec::new();
        let acted = s.reconcile(
            |id, _| id == "b",
            |id, e| {
                seen.push(id.to_string());
                e.alive = false;
            },
        );
        assert_eq!(acted, 1);
        assert_eq!(seen, ["b"]);
        assert!(s.get("a").unwrap().alive);
        assert!(!s.get("b").unwrap().alive);
    }
}
