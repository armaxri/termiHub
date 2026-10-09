//! Small, dependency-free utility helpers shared across the core crate.

pub mod backoff;
pub mod entry_extra;
pub mod no_window;
pub mod persist;
#[cfg(test)]
pub(crate) mod test_net;
