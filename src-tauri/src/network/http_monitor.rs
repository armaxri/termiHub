//! Periodic HTTP monitor — re-exported from `termihub-core` (#2592).
//!
//! The monitor's `Service` implementation, config/result/state types, and poll
//! loop were relocated into [`termihub_core::monitoring::http_monitor`] so the
//! **same** implementation runs on the desktop host or a remote agent (behind the
//! `http-monitor` cargo feature), exactly as the embedded servers did in #2192.
//!
//! This thin re-export keeps the desktop's `crate::network::http_monitor::…`
//! paths (and the `network-http-monitor-check` bridge in
//! [`super`](crate::network)) unchanged. Desktop-hosted monitors behave exactly
//! as before; #2592 only *adds* the agent as a run-location choice.

pub use termihub_core::monitoring::http_monitor::{
    register_http_monitor, HttpCheckResult, HttpMonitorConfig, HttpMonitorService,
    HttpMonitorState, CHECK_EVENT_KIND, SERVICE_ID,
};

// `DISPLAY_NAME` is used only by the desktop test asserting the registered
// service's metadata; re-export it so `http_monitor::DISPLAY_NAME` keeps
// resolving there without warning in the non-test build.
#[cfg(test)]
pub use termihub_core::monitoring::http_monitor::DISPLAY_NAME;
