// The agent-side daemon client and its manager wiring are still Unix-only;
// the Windows launcher is tracked separately (#767). The daemon *process*,
// frame protocol, and transport abstraction are cross-platform.
#[cfg(unix)]
pub mod client;
pub mod process;
pub mod protocol;
pub mod transport;
