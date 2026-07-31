//! The authoritative, shared app-settings document behind the shadow `settings`
//! projection region (#2227, Phase 5 of #2139).
//!
//! Models the app-settings slice the frontend drives in `appStore` (the
//! `AppSettings` document behind `settings` / `savedSettings`): a single
//! persisted preferences document that the app loads once and mutates by
//! whole-document save (`updateSettings` / `saveSettings`) or targeted field
//! patch (`updateShellIntegration` and the `{ ...current.settings, layout }`
//! spreads). The store owns the document as an opaque JSON object so it mirrors
//! those semantics faithfully without duplicating the large typed struct (see
//! the module docs, [`super`]).
//!
//! # Shared region — Open Design Decision #4 / #6
//!
//! `AppSettings` is a single persisted document shared by every client, so the
//! store holds one document projected into the shared `settings` region. There
//! is no per-client keying here (contrast the client-scoped `layout` /
//! `workflow-run` stores): a settings edit projects to all subscribers.
//!
//! # Shadow mode — zero user-facing change
//!
//! Not yet authoritative: the store accepts `settings.*` intents and projects
//! diffs, but nothing in the live UI subscribes to or renders the `settings`
//! region, and no frontend code dispatches `settings.*` intents yet. The
//! `appStore` `settings` slice remains authoritative.

use std::sync::{Mutex, MutexGuard};

use serde_json::{Map, Value};

/// The frontend `appStore` initial `settings` baseline (`appStore.ts`), used to
/// seed a fresh store and to service `settings.reset`. Mirrors the default
/// document a first run starts with, so a fresh subscriber sees the same
/// defaults the app does. Keys are camelCase — the exact frontend `AppSettings`
/// view shape.
fn default_settings_document() -> Map<String, Value> {
    let mut doc = Map::new();
    doc.insert("version".to_string(), Value::from("1"));
    doc.insert(
        "externalConnectionFiles".to_string(),
        Value::Array(Vec::new()),
    );
    doc.insert("powerMonitoringEnabled".to_string(), Value::Bool(true));
    doc.insert("fileBrowserEnabled".to_string(), Value::Bool(true));
    doc.insert("confirmCloseTabOnShortcut".to_string(), Value::Bool(true));
    doc.insert("confirmCloseLiveSession".to_string(), Value::Bool(true));
    doc.insert("confirmCloseAttachedTab".to_string(), Value::Bool(true));
    doc.insert("askOpenSavedFileInTab".to_string(), Value::Bool(true));
    doc.insert("warnLargePortScan".to_string(), Value::Bool(true));
    doc.insert("warnLargePingSweep".to_string(), Value::Bool(true));
    doc
}

/// The shadow app-settings authority. Owns the single `AppSettings` document as
/// an opaque JSON object; the shared `settings` region projects it.
pub struct SettingsStore {
    /// The whole settings document. One mutex guards it so intents never
    /// interleave — the substrate's single-writer contract also holds here.
    settings: Mutex<Map<String, Value>>,
}

impl Default for SettingsStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SettingsStore {
    /// A store seeded with the frontend default settings document, so a
    /// subscriber attaching before the first `settings.*` intent sees the same
    /// defaults a first-run app does.
    pub fn new() -> Self {
        Self {
            settings: Mutex::new(default_settings_document()),
        }
    }

    /// The render-ready view model: the settings document itself (a JSON object).
    ///
    /// Pure (never mutates), so the projector can safely diff two consecutive
    /// snapshots.
    pub fn snapshot(&self) -> Value {
        Value::Object(self.lock().clone())
    }

    /// `settings.replace` — overwrite the whole settings document with a
    /// caller-supplied one (mirrors `updateSettings` / `saveSettings`, which
    /// persist and set both `settings` and `savedSettings` to the new object).
    /// Idempotent server-side: replacing with the same content yields no diff.
    pub fn replace(&self, settings: Map<String, Value>) {
        *self.lock() = settings;
    }

    /// `settings.patch` — shallow-merge a partial document into the current one,
    /// overwriting or inserting each top-level key (mirrors the frontend
    /// `{ ...current.settings, <field> }` spreads, e.g. `updateShellIntegration`
    /// and the layout persists). Merge is shallow, exactly like the JS spread; a
    /// key present in the patch with a `null` value sets that key to `null`
    /// (spread semantics — it does not delete). Keys absent from the patch are
    /// left untouched.
    pub fn patch(&self, patch: Map<String, Value>) {
        let mut settings = self.lock();
        for (key, value) in patch {
            settings.insert(key, value);
        }
    }

    /// `settings.reset` — reset the document to the frontend default baseline
    /// (mirrors a reset-to-defaults). Idempotent when already at defaults.
    pub fn reset(&self) {
        *self.lock() = default_settings_document();
    }

    /// Read one top-level settings value by key (test / diagnostics helper).
    #[cfg(test)]
    pub fn get(&self, key: &str) -> Option<Value> {
        self.lock().get(key).cloned()
    }

    /// The document's current top-level key count (test / diagnostics helper).
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    fn lock(&self) -> MutexGuard<'_, Map<String, Value>> {
        // Short critical sections only; a poisoned lock means another thread
        // panicked mid-mutation (a bug) — recover rather than cascade.
        self.settings.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
