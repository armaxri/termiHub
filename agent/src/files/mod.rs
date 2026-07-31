//! Connection-scoped file browsing for the agent.
//!
//! File operations go through the single core [`FileBrowser`] capability
//! (`termihub_core::files`); local browsing uses the shared
//! [`LocalFileBrowser`]. The agent no longer keeps a parallel `FileBackend`
//! implementation (#2104).
//!
//! [`FileBrowser`]: termihub_core::files::FileBrowser
//! [`LocalFileBrowser`]: termihub_core::files::LocalFileBrowser

pub use termihub_core::errors::FileError;
