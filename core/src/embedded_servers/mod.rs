//! Embedded HTTP/FTP/TFTP file servers, hostable on the desktop or a remote agent.
//!
//! # S2 relocation — servers on the core `Service` trait (#2192)
//!
//! Each embedded server is an [`EmbeddedServerService`] implementing the core
//! [`Service`](crate::service::Service) trait: its lifecycle (spawn the listener
//! thread, confirm the bind, track stats, stop) is owned by the service, which
//! emits status transitions as [`ServiceEvent`](crate::service::ServiceEvent)s on
//! the core-owned [`EventChannel`](crate::service::EventChannel) rather than a
//! host-specific emitter.
//!
//! The #2154 lift decoupled the servers from Tauri's `AppHandle`; #2192 finished
//! the job by physically relocating the implementations here (out of
//! `src-tauri/`) behind the `embedded-servers` cargo feature, so the **same**
//! service runs on the desktop host or an agent. The desktop
//! (`EmbeddedServerManager`) and the agent both register these `Service`
//! factories and bridge the `EventChannel` to their respective transports.

pub mod config;
pub mod service;

mod ftp_server;
mod http_server;
mod tftp_server;
