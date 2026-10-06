//! The two ways a plugin connection's code can run — in process or in a
//! `termihub-plugin-runner` (#4182) — behind one interface for
//! [`PluginConnectionType`](super::PluginConnectionType).

use std::sync::Arc;

use termihub_plugin_api::{LoadedBackend, PluginError};

use super::host::{LoadedLibrary, LoadedPluginInfo};
use super::sandbox::{SandboxedPluginHandle, SandboxedSession};

/// Where a plugin's code runs.
#[derive(Clone)]
pub(crate) enum PluginRuntime {
    /// `dlopen`ed into this process (the default until the plugin OS-sandbox
    /// cut-over; see `docs/concepts/backlog/plugin-os-sandbox.html`).
    InProcess(Arc<LoadedLibrary>),
    /// Served by a `termihub-plugin-runner` process (#4182).
    Sandboxed(Arc<SandboxedPluginHandle>),
}

impl PluginRuntime {
    pub(crate) fn info(&self) -> &LoadedPluginInfo {
        match self {
            PluginRuntime::InProcess(library) => library.info(),
            PluginRuntime::Sandboxed(handle) => handle.info(),
        }
    }
}

/// The live session behind a connected [`PluginConnectionType`].
pub(crate) enum ActiveBackend {
    /// An in-process backend (its vtable lives in the loaded library).
    InProcess(LoadedBackend),
    /// A session in a plugin runner.
    Sandboxed(SandboxedSession),
}

impl ActiveBackend {
    pub(crate) fn write_input(&self, data: &[u8]) -> Result<(), PluginError> {
        match self {
            ActiveBackend::InProcess(b) => b.write_input(data),
            ActiveBackend::Sandboxed(s) => s.write_input(data),
        }
    }

    pub(crate) fn resize(&self, cols: u16, rows: u16) -> Result<(), PluginError> {
        match self {
            ActiveBackend::InProcess(b) => b.resize(cols, rows),
            ActiveBackend::Sandboxed(s) => s.resize(cols, rows),
        }
    }

    pub(crate) fn close(&mut self) -> Result<(), PluginError> {
        match self {
            ActiveBackend::InProcess(b) => b.close(),
            ActiveBackend::Sandboxed(s) => s.close(),
        }
    }

    pub(crate) fn is_alive(&self) -> bool {
        match self {
            ActiveBackend::InProcess(b) => b.is_alive(),
            ActiveBackend::Sandboxed(s) => s.is_alive(),
        }
    }
}
