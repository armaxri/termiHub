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

use crate::service::ServiceRegistry;
use config::ServerType;
use service::{display_name_for, service_id_for, EmbeddedServerService};

/// Build a [`ServiceRegistry`](crate::service::ServiceRegistry) populated with
/// the HTTP/FTP/TFTP embedded-server factories.
///
/// Shared by the desktop host ([`EmbeddedServerManager`]) and the agent so both
/// offer the same three server types with identical ids, schemas, capabilities,
/// and icons — the single source of truth for what "an embedded server" is.
///
/// [`EmbeddedServerManager`]: https://docs.rs/termihub
pub fn build_service_registry() -> ServiceRegistry {
    let mut registry = ServiceRegistry::new();
    for (ty, icon) in [
        (ServerType::Http, "globe"),
        (ServerType::Ftp, "folder"),
        (ServerType::Tftp, "download"),
    ] {
        let id = service_id_for(&ty);
        let display = display_name_for(&ty);
        let ty_for_factory = ty.clone();
        registry.register(
            id,
            display,
            icon,
            Box::new(move || Box::new(EmbeddedServerService::new(ty_for_factory.clone()))),
        );
    }
    registry
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::Service;

    #[test]
    fn registry_exposes_the_three_server_types() {
        let registry = build_service_registry();
        let ids: Vec<String> = registry
            .available_services()
            .into_iter()
            .map(|s| s.service_id)
            .collect();
        assert!(ids.contains(&service_id_for(&ServerType::Http).to_string()));
        assert!(ids.contains(&service_id_for(&ServerType::Ftp).to_string()));
        assert!(ids.contains(&service_id_for(&ServerType::Tftp).to_string()));
    }

    #[test]
    fn registered_server_types_are_not_desktop_only() {
        // Serving files may run on an agent — the run-location selector must be
        // allowed to offer an agent for these.
        let registry = build_service_registry();
        for svc in registry.available_services() {
            assert!(svc.capabilities.emits_events);
            assert!(
                !svc.capabilities.desktop_only,
                "{} must not be desktop-only",
                svc.service_id
            );
        }
    }

    #[test]
    fn registry_create_yields_a_stopped_service() {
        let registry = build_service_registry();
        let svc = registry
            .create(service_id_for(&ServerType::Ftp))
            .expect("ftp server type is registered");
        assert_eq!(svc.service_id(), service_id_for(&ServerType::Ftp));
    }
}
