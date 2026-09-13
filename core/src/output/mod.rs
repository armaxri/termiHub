pub mod coalescer;
pub mod screen_clear;
pub mod session_log;

/// Bounded channel capacity for output data flowing from a backend's reader
/// task/thread to its consumer.
///
/// Single source of truth for every backend's output channel: it provides
/// backpressure so a fast-producing terminal cannot flood memory. Backends and
/// the desktop remote proxy reference this instead of redeclaring `64`.
pub const OUTPUT_CHANNEL_CAPACITY: usize = 64;
