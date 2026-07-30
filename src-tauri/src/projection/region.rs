//! The [`ProjectedStore`] trait a domain store implements to be projected.
//!
//! A region is a slice of authoritative backend state exposed to the UI as a
//! render-ready view model. The [`Projector`](super::Projector) diffs
//! consecutive snapshots of a store (the default path) and fans the resulting
//! [`DiffFrame`](super::DiffFrame)s out to every subscriber.
//!
//! Phase 1 (#2149) ships the trait and the projection mechanism only; no real
//! domain is migrated onto it — that is Phase 2 (#2150), starting with SSH
//! tunnels.

use serde_json::Value;

/// A domain store that can be projected as a versioned region.
///
/// The natural first seam is the existing app-side authority (e.g.
/// `SessionManager`), which a region wraps rather than replaces. The projector
/// calls [`snapshot`](ProjectedStore::snapshot) to obtain the current
/// render-ready view model and diffs it against the last emitted view.
pub trait ProjectedStore: Send + Sync {
    /// The region id this store projects onto.
    ///
    /// `"<domain>"` for globally-shared regions (e.g. `"tunnels"`) or
    /// `"<domain>@<clientId>"` for client-scoped regions (e.g.
    /// `"layout@client-7"`). The `@client` suffix is the only thing that
    /// distinguishes a shared region from a per-client one; the envelope and
    /// versioning rules are identical for both.
    fn region_id(&self) -> &str;

    /// The complete, render-ready view model for the region right now.
    ///
    /// Must be a pure function of authoritative state, computed without side
    /// effects so the projector can diff two snapshots safely.
    fn snapshot(&self) -> Value;
}
