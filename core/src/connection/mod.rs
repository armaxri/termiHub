//! Connection type abstraction and settings schema.
//!
//! This module defines the unified [`ConnectionType`] trait that all
//! connection backends (local shell, SSH, serial, telnet, Docker, WSL)
//! implement. It also provides the [`SettingsSchema`] types for dynamic
//! UI form generation and a [`ConnectionTypeRegistry`] for runtime
//! discovery of available connection types.

pub mod schema;
pub mod validation;

pub use schema::*;
pub use validation::{validate_settings, ValidationError};
