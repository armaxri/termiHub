//! Plugin package format and manifest contract.
//!
//! This module is the *foundation* of termiHub's plugin system (see
//! `docs/concepts/future/plugin-system.html`): it defines the on-disk package
//! format, the `manifest.json` data model and validator (§1–2), and the
//! [`PluginManager`] management layer (§4/§12) that installs, scans, and tracks
//! installed plugins.
//!
//! It also provides the **native host loader** (#1995): [`PluginHost`] opens a
//! plugin's backend dynamic library over the stable ABI
//! ([`termihub_plugin_api`]), validates its version, and registers the resulting
//! [`PluginConnectionType`] into a [`ConnectionTypeRegistry`]. The management
//! layer stays decoupled from loading through the [`PluginLifecycleHook`] seam:
//! [`HostLifecycleHook`] wires a [`PluginHost`] into that seam so enabling or
//! disabling a plugin loads or unloads its backend. JS/theme registration and
//! connection-editor/session wiring remain later issues.
//!
//! [`ConnectionTypeRegistry`]: crate::connection::ConnectionTypeRegistry
//!
//! # The `.termihub-plugin` package format
//!
//! A plugin is distributed as a single `.termihub-plugin` file: a ZIP archive
//! with a fixed layout.
//!
//! ```text
//! my-plugin.termihub-plugin (ZIP)
//! ├── manifest.json           # required — plugin metadata and declarations
//! ├── backend/                # optional — Rust dynamic library
//! │   ├── my_plugin.dll       #   Windows
//! │   ├── libmy_plugin.so     #   Linux
//! │   └── libmy_plugin.dylib  #   macOS
//! ├── frontend/               # optional — JavaScript/CSS assets
//! │   ├── index.js            #   frontend entry point
//! │   └── styles.css          #   styles
//! ├── themes/                 # optional — ThemeDefinition JSON files
//! │   └── dracula.json
//! └── README.md               # optional — plugin documentation
//! ```
//!
//! Only `manifest.json` is required. The whole file must not exceed
//! [`MAX_PACKAGE_SIZE_BYTES`] (50 MB), which is enforced before the archive is
//! opened.
//!
//! # Validation
//!
//! [`validate_package`] is the entry point: it checks the size, opens the ZIP,
//! reads and parses `manifest.json`, runs semantic validation, and confirms
//! API-version compatibility — returning a trusted [`PluginManifest`] or a
//! descriptive [`PluginPackageError`]. API incompatibility is surfaced as its
//! own distinct outcome so callers can prompt the user to update rather than
//! treating it as a malformed package.
//!
//! # Packaging
//!
//! [`pack_plugin`] is the write side of the format: it turns a plugin *source
//! directory* into a `<id>-<version>.termihub-plugin` archive and then runs
//! [`validate_package`] over its own output, so the packaging tool can never emit
//! an artifact the host would reject. The `scripts/package-plugin.{sh,cmd}`
//! helpers build a backend crate's dynamic library and drive this function via
//! the `termihub-plugin-pack` binary.

mod capabilities;
mod connection;
mod host;
mod manager;
mod manifest;
mod pack;
mod package;
mod security;

pub use capabilities::{
    build_host_bridge, build_host_bridge_with_policy, ConnectionPolicy, DEFAULT_CONNECT_TIMEOUT,
    DEFAULT_MAX_CONNECTIONS,
};
pub use connection::{config_schema_to_settings_schema, PluginConnectionType};
pub use host::{
    find_backend_library, load_backend_library, HostError, HostLifecycleHook, LoadedLibrary,
    LoadedPluginInfo, PluginHost,
};
pub use manager::{
    InstalledPlugin, NoopLifecycleHook, PluginLifecycleHook, PluginManager, PluginManagerError,
    PluginState,
};
pub use manifest::{
    check_api_compatibility, parse_manifest, ApiCompatibility, ConnectionPolicyManifest,
    ManifestParseError, ManifestValidationError, Platform, PluginExtensions, PluginManifest,
    PluginPermission, PluginSettingSchema, ProtocolParserExtension, SettingType,
    StatusBarWidgetExtension, TerminalBackendExtension, ThemeEntry, ThemeExtension, WidgetPosition,
    CURRENT_PLUGIN_API_VERSION,
};
pub use pack::{pack_plugin, PluginPackError};
pub use package::{
    validate_package, PluginPackageError, MANIFEST_FILE_NAME, MAX_PACKAGE_SIZE_BYTES,
};
pub use security::{
    assess_trust, FilesystemScope, PermissionError, PermissionSet, RecoveryAction, RecoveryState,
    RestartTracker, TrustAssessment, TrustLevel, MAX_RESTART_ATTEMPTS,
};
