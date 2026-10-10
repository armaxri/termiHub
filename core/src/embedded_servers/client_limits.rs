//! Per-client-IP connection sub-cap shared by the embedded servers that hold
//! a connection per client: FTP (#4398) and HTTP (#4686).
//!
//! A server-wide connection cap alone lets one client IP take every slot and
//! lock everyone else out. Each server therefore also caps how many of its
//! slots one client IP may hold at a time, with the sub-cap derived from the
//! server-wide cap by [`per_client_cap`] and enforced by [`ClientConnections`].

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

/// Smallest per-client-IP sub-cap: an interactive client commonly opens a
/// second connection (an FTP background transfer, a browser's parallel
/// request) (#4398).
pub(super) const MIN_CONNECTIONS_PER_CLIENT: usize = 2;

/// The per-client-IP sub-cap for a server-wide cap of `cap`: a quarter of the
/// cap, at least [`MIN_CONNECTIONS_PER_CLIENT`], and never more than the cap
/// itself. One client IP can then not take every slot.
pub(super) fn per_client_cap(cap: usize) -> usize {
    cap.div_ceil(4).max(MIN_CONNECTIONS_PER_CLIENT).min(cap)
}

/// Live connection counts per client IP, bounded by the per-client sub-cap.
/// An entry exists only while that IP holds a connection, so the map never
/// has more entries than the server-wide connection cap.
pub(super) struct ClientConnections {
    per_client_cap: usize,
    counts: Mutex<HashMap<IpAddr, usize>>,
}

impl ClientConnections {
    pub(super) fn new(per_client_cap: usize) -> Arc<Self> {
        Arc::new(Self {
            per_client_cap: per_client_cap.max(1),
            counts: Mutex::new(HashMap::new()),
        })
    }

    fn counts(&self) -> MutexGuard<'_, HashMap<IpAddr, usize>> {
        // Every critical section is a single map update, so a poisoned lock
        // still holds consistent counts.
        self.counts.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Take one of `ip`'s connection slots, or `None` when it holds them all.
    /// An IPv4-mapped IPv6 address counts as its IPv4 address.
    pub(super) fn try_acquire(self: &Arc<Self>, ip: IpAddr) -> Option<ClientSlot> {
        let ip = ip.to_canonical();
        let mut counts = self.counts();
        let count = counts.entry(ip).or_insert(0);
        if *count >= self.per_client_cap {
            return None;
        }
        *count += 1;
        Some(ClientSlot {
            clients: Arc::clone(self),
            ip,
        })
    }

    /// Connections `ip` currently holds.
    #[cfg(test)]
    pub(super) fn held(&self, ip: IpAddr) -> usize {
        self.counts().get(&ip.to_canonical()).copied().unwrap_or(0)
    }

    /// Client IPs currently tracked.
    #[cfg(test)]
    pub(super) fn tracked(&self) -> usize {
        self.counts().len()
    }
}

/// One client IP's hold on a connection slot; released on drop.
pub(super) struct ClientSlot {
    clients: Arc<ClientConnections>,
    ip: IpAddr,
}

impl Drop for ClientSlot {
    fn drop(&mut self) {
        let mut counts = self.clients.counts();
        if let Some(count) = counts.get_mut(&self.ip) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                counts.remove(&self.ip);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_client_cap_is_a_bounded_quarter_of_the_cap() {
        assert_eq!(per_client_cap(32), 8);
        assert_eq!(per_client_cap(100), 25);
        assert_eq!(per_client_cap(9), 3);
        assert_eq!(per_client_cap(8), 2);
        // Never below the floor, never above the cap itself.
        assert_eq!(per_client_cap(3), MIN_CONNECTIONS_PER_CLIENT);
        assert_eq!(per_client_cap(2), 2);
        assert_eq!(per_client_cap(1), 1);
    }

    /// The per-IP counter only tracks IPs that hold a connection, so it is
    /// bounded by the cap, and an IPv4-mapped address counts as its IPv4
    /// address.
    #[test]
    fn client_counter_is_bounded_and_released_on_drop() {
        let clients = ClientConnections::new(2);
        let a: IpAddr = "192.0.2.1".parse().expect("ip");
        let a_mapped: IpAddr = "::ffff:192.0.2.1".parse().expect("ip");
        let b: IpAddr = "192.0.2.2".parse().expect("ip");

        let first = clients.try_acquire(a).expect("first slot");
        let second = clients.try_acquire(a_mapped).expect("second slot");
        assert!(clients.try_acquire(a).is_none(), "sub-cap reached");
        let other = clients
            .try_acquire(b)
            .expect("another client is unaffected");
        assert_eq!(clients.held(a), 2);
        assert_eq!(clients.tracked(), 2);

        drop(first);
        assert_eq!(clients.held(a), 1);
        let again = clients.try_acquire(a).expect("a released slot is reusable");
        drop((second, again, other));
        assert_eq!(clients.tracked(), 0, "idle clients leave no entry behind");
    }
}
