//! Plugin package format and manifest contract.
//!
//! This module is the *foundation* of termiHub's plugin system (see
//! `docs/concepts/future/plugin-system.html`, impl §1–2): it defines the
//! on-disk package format, the `manifest.json` data model, and the validator
//! every other part of the plugin system builds on. It performs **no**
//! installation, dynamic-library loading, or UI — only the format contract and
//! its validation.
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

mod manifest;
mod pack;
mod package;

pub use manifest::{
    check_api_compatibility, parse_manifest, ApiCompatibility, ManifestParseError,
    ManifestValidationError, Platform, PluginExtensions, PluginManifest, PluginPermission,
    PluginSettingSchema, ProtocolParserExtension, SettingType, StatusBarWidgetExtension,
    TerminalBackendExtension, ThemeEntry, ThemeExtension, WidgetPosition,
    CURRENT_PLUGIN_API_VERSION,
};
pub use pack::{pack_plugin, PluginPackError};
pub use package::{
    validate_package, PluginPackageError, MANIFEST_FILE_NAME, MAX_PACKAGE_SIZE_BYTES,
};
