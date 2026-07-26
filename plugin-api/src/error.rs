//! Error and status types for the plugin ABI.
//!
//! Two representations exist by design:
//!
//! * [`PluginError`] — a rich, ergonomic Rust enum used *within* either side of
//!   the boundary (plugin authors return it from the safe trait; the host gets
//!   it back from the safe wrapper). It carries strings and is **not** FFI-safe.
//! * [`PluginStatus`] — a `#[repr(i32)]` C-style code that actually crosses the
//!   ABI. It is FFI-safe but lossy: it conveys the *kind* of failure, not any
//!   attached message. The safe wrappers translate between the two.

/// Rich, Rust-side error type for plugin backends and the host wrapper.
///
/// This type is **not** passed across the FFI boundary — [`PluginStatus`] is.
#[derive(Debug, thiserror::Error)]
pub enum PluginError {
    /// The host's output channel has been closed; no further output can be
    /// delivered. Typically means the session was torn down.
    #[error("plugin output channel is closed")]
    ChannelClosed,

    /// The backend is no longer alive and cannot service the request.
    #[error("plugin backend is not alive")]
    NotAlive,

    /// The `config_json` handed to the backend could not be parsed or was
    /// semantically invalid.
    #[error("invalid plugin session configuration: {0}")]
    InvalidConfig(String),

    /// An I/O error occurred inside the backend.
    #[error("plugin backend i/o error: {0}")]
    Io(String),

    /// The plugin was built against an incompatible ABI version.
    #[error("plugin API version mismatch: host supports {expected}, plugin built against {found}")]
    VersionMismatch {
        /// ABI version the host supports ([`crate::CURRENT_PLUGIN_API_VERSION`]).
        expected: u32,
        /// ABI version the plugin reported.
        found: u32,
    },

    /// The plugin unwound (panicked) across the FFI boundary; the safe wrappers
    /// catch this rather than letting it become undefined behavior.
    #[error("plugin panicked across the FFI boundary")]
    Panicked,

    /// Any other failure the plugin wishes to report.
    #[error("plugin error: {0}")]
    Other(String),
}

/// FFI-safe status code returned by ABI functions.
///
/// This is the value that actually crosses the boundary. It is intentionally a
/// field-less `#[repr(i32)]` enum so it is guaranteed FFI-safe and stable. It
/// cannot carry a message — map it back to a [`PluginError`] with
/// [`PluginStatus::into_result`] for a human-readable (if generic) description.
#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginStatus {
    /// Success.
    Ok = 0,
    /// Maps to [`PluginError::ChannelClosed`].
    ChannelClosed = 1,
    /// Maps to [`PluginError::NotAlive`].
    NotAlive = 2,
    /// Maps to [`PluginError::InvalidConfig`].
    InvalidConfig = 3,
    /// Maps to [`PluginError::Io`].
    Io = 4,
    /// Maps to [`PluginError::VersionMismatch`].
    VersionMismatch = 5,
    /// Maps to [`PluginError::Panicked`]; also returned when a plugin function
    /// unwinds and the wrapper contains the panic.
    Panic = 6,
    /// Maps to [`PluginError::Other`].
    Other = 7,
}

impl PluginStatus {
    /// Collapse a `Result<(), PluginError>` into a status code (dropping any
    /// attached message).
    #[must_use]
    pub fn from_result(result: Result<(), PluginError>) -> Self {
        match result {
            Ok(()) => Self::Ok,
            Err(e) => Self::from_error(&e),
        }
    }

    /// The status code corresponding to a given [`PluginError`] variant.
    #[must_use]
    pub fn from_error(error: &PluginError) -> Self {
        match error {
            PluginError::ChannelClosed => Self::ChannelClosed,
            PluginError::NotAlive => Self::NotAlive,
            PluginError::InvalidConfig(_) => Self::InvalidConfig,
            PluginError::Io(_) => Self::Io,
            PluginError::VersionMismatch { .. } => Self::VersionMismatch,
            PluginError::Panicked => Self::Panic,
            PluginError::Other(_) => Self::Other,
        }
    }

    /// Whether this status represents success.
    #[must_use]
    pub fn is_ok(self) -> bool {
        matches!(self, Self::Ok)
    }

    /// Expand a status code back into a `Result<(), PluginError>`.
    ///
    /// Because the code carries no payload, the reconstructed error uses a
    /// generic message for the string-bearing variants.
    pub fn into_result(self) -> Result<(), PluginError> {
        match self {
            Self::Ok => Ok(()),
            Self::ChannelClosed => Err(PluginError::ChannelClosed),
            Self::NotAlive => Err(PluginError::NotAlive),
            Self::InvalidConfig => Err(PluginError::InvalidConfig("reported by plugin".to_owned())),
            Self::Io => Err(PluginError::Io("reported by plugin".to_owned())),
            Self::VersionMismatch => Err(PluginError::VersionMismatch {
                expected: crate::CURRENT_PLUGIN_API_VERSION,
                found: 0,
            }),
            Self::Panic => Err(PluginError::Panicked),
            Self::Other => Err(PluginError::Other("reported by plugin".to_owned())),
        }
    }
}
