//! Schema versioning + downgrade data-safety for the agent's persisted JSON stores.
//!
//! A thin re-export of the shared persistence layer in
//! [`termihub_core::util::persist`] (#4334) — the same implementation the
//! desktop's `src-tauri/src/utils/migrate.rs` and the core plugin stores use:
//!
//! * a store carries a `version` field, written as a JSON **string** (`"1"`), read
//!   flexibly as a string **or** a number;
//! * a file with no readable `version` is the **baseline** (v1), so a legacy,
//!   pre-versioning file still loads;
//! * a file whose version is **newer** than this binary supports is refused on
//!   load — it is never reset, rewritten or migrated — and every save over it is
//!   refused ([`guard_not_newer`]), so a downgraded agent can never overwrite data
//!   a newer agent wrote (#3920).
//!
//! When a store's schema changes (for example a settings-key rename), bump its
//! current version and add a numbered step to its `migrate` function; the version
//! gate then makes the change forward-migrating and downgrade-safe.
//!
//! A store that is genuinely **corrupt** (not a newer version) is copied aside
//! with [`backup_corrupt`] — to the first free `<file>.bak`, `<file>.bak.1`, … —
//! before anything may overwrite it (#3931), so no path can lose saved data
//! without a copy on disk.

pub use termihub_core::util::persist::{
    backup_corrupt, check_version, guard_not_newer, read_version, NewerVersionError,
    ASSUMED_VERSION,
};
