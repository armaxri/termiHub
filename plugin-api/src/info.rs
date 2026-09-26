//! Plugin metadata and session-configuration carriers.

use crate::ffi::{FfiStr, FfiString};

/// Metadata a plugin reports to the host during initialization.
///
/// Returned (by out-parameter) from the plugin's `plugin_init` entry point — see
/// [`crate::symbols`]. Every string is an **owned** [`FfiString`]: the plugin
/// allocates them and the host frees them by dropping this struct, which invokes
/// each field's embedded destructor. That is what lets the strings cross the ABI
/// boundary soundly.
#[repr(C)]
pub struct PluginInfo {
    /// Stable, unique plugin identifier (e.g. `"k8s-exec"`).
    pub id: FfiString,
    /// Human-readable display name.
    pub name: FfiString,
    /// Plugin's own semantic version string (independent of the ABI version).
    pub version: FfiString,
    /// ABI version the plugin was built against, [packed](crate::AbiVersion::to_packed)
    /// (`major << 16 | minor`). Must equal the value the plugin's
    /// `termihub_plugin_abi_version` returns; the host refuses a plugin whose
    /// two reports disagree.
    pub api_version: u32,
    // Append-only (ABI 1.x): the host allocates this struct and a plugin writes
    // it, so later minors may append fields here; the host reads an appended
    // field only when the plugin's ABI `supports` the minor that added it.
}

impl PluginInfo {
    /// Build a [`PluginInfo`] reporting the ABI version this crate defines
    /// ([`crate::CURRENT_PLUGIN_ABI_VERSION`]) — what every real plugin wants.
    #[must_use]
    pub fn new(id: impl Into<String>, name: impl Into<String>, version: impl Into<String>) -> Self {
        Self::with_abi_version(id, name, version, crate::CURRENT_PLUGIN_ABI_VERSION)
    }

    /// Build a [`PluginInfo`] reporting an explicit ABI version. Only useful for
    /// tests that simulate a plugin built against a different ABI.
    #[must_use]
    pub fn with_abi_version(
        id: impl Into<String>,
        name: impl Into<String>,
        version: impl Into<String>,
        abi_version: crate::AbiVersion,
    ) -> Self {
        Self {
            id: FfiString::from_string(id.into()),
            name: FfiString::from_string(name.into()),
            version: FfiString::from_string(version.into()),
            api_version: abi_version.to_packed(),
        }
    }

    /// The reported ABI version, decoded from [`api_version`](Self::api_version).
    #[must_use]
    pub fn abi_version(&self) -> crate::AbiVersion {
        crate::AbiVersion::from_packed(self.api_version)
    }

    /// An empty placeholder the host allocates before calling `plugin_init`,
    /// which the plugin fills in via the out-parameter.
    #[must_use]
    pub fn empty() -> Self {
        Self {
            id: FfiString::empty(),
            name: FfiString::empty(),
            version: FfiString::empty(),
            api_version: 0,
        }
    }
}

/// Configuration handed to a plugin when creating a new terminal session.
///
/// Both fields are **borrowed** JSON documents (owned by the host for the
/// duration of the `plugin_create_backend` call). The plugin parses what it
/// needs and copies it out before the call returns; it must not retain the
/// borrowed pointers afterwards.
///
/// * `config_json` is the **per-connection** configuration, whose shape matches
///   the plugin's declared `configSchema`.
/// * `settings_json` is the **plugin-level** user settings (the manifest's
///   `settings` block, with the user's stored overrides applied), shared by
///   every session of the plugin — e.g. a declared `defaultNamespace`. It is an
///   empty string when the plugin declares no settings and the user set none.
///
/// # ABI compatibility
///
/// `settings_json` is **appended** after `config_json`, so the layout of the
/// pre-existing field is unchanged: a plugin built against the earlier
/// single-field struct that reads only `config_json` keeps working unchanged
/// (it simply ignores the new field), and the host always writes the full
/// struct. This is the append-only pattern ABI 1.x minors follow for host-owned,
/// by-pointer structs (see [`crate::version`]); both fields are part of ABI 1.0.
#[repr(C)]
pub struct PluginSessionConfig {
    /// Per-connection JSON configuration, matching the plugin's `configSchema`.
    pub config_json: FfiStr,
    /// Plugin-level user settings JSON (manifest `settings` defaults overlaid
    /// with the user's stored overrides), shared across the plugin's sessions.
    /// Empty when the plugin declares no settings and none are stored.
    pub settings_json: FfiStr,
    // Append-only (ABI 1.x): host-owned and passed by pointer, so later minors
    // may append fields; an older-minor plugin reads only its prefix.
}

impl PluginSessionConfig {
    /// Borrow a JSON config string as a session config, delivering **empty**
    /// plugin-level settings. Preserved for backward compatibility; prefer
    /// [`with_settings`](Self::with_settings) to also deliver the plugin's
    /// stored settings. The result borrows `config_json`.
    #[must_use]
    pub fn new(config_json: &str) -> Self {
        Self {
            config_json: FfiStr::new(config_json),
            settings_json: FfiStr::empty(),
        }
    }

    /// Borrow a per-connection `config_json` and the plugin-level `settings_json`
    /// as a session config. The result borrows both strings, which must outlive
    /// the `plugin_create_backend` call.
    #[must_use]
    pub fn with_settings(config_json: &str, settings_json: &str) -> Self {
        Self {
            config_json: FfiStr::new(config_json),
            settings_json: FfiStr::new(settings_json),
        }
    }
}
