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
    /// ABI version the plugin was built against; the host compares this to
    /// [`crate::CURRENT_PLUGIN_API_VERSION`] and refuses incompatible plugins.
    pub api_version: u32,
}

impl PluginInfo {
    /// Build a [`PluginInfo`], reporting the given ABI `api_version`.
    ///
    /// Plugins should pass [`crate::CURRENT_PLUGIN_API_VERSION`].
    #[must_use]
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        version: impl Into<String>,
        api_version: u32,
    ) -> Self {
        Self {
            id: FfiString::from_string(id.into()),
            name: FfiString::from_string(name.into()),
            version: FfiString::from_string(version.into()),
            api_version,
        }
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
/// `config_json` is a **borrowed** JSON document (owned by the host for the
/// duration of the `plugin_create_backend` call) whose shape matches the
/// plugin's declared `configSchema` in its manifest. The plugin parses it and
/// copies out whatever it needs before the call returns; it must not retain the
/// borrowed pointer afterwards.
#[repr(C)]
pub struct PluginSessionConfig {
    /// JSON configuration for the session, matching the plugin's `configSchema`.
    pub config_json: FfiStr,
}

impl PluginSessionConfig {
    /// Borrow a JSON string as a session config. The result borrows `config_json`.
    #[must_use]
    pub fn new(config_json: &str) -> Self {
        Self {
            config_json: FfiStr::new(config_json),
        }
    }
}
