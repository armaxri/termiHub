//! Small utility helpers shared across the core crate.

pub mod backoff;
pub mod entry_extra;
pub mod no_window;
pub mod persist;
pub mod sha256;
#[cfg(test)]
pub(crate) mod test_net;
pub mod time;
pub mod version;
