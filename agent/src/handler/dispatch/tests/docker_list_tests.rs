//! `docker.list_containers` (PROD-017, #3424): the desktop lists this host's
//! containers for the Docker connection-editor picker. Covers the init gate,
//! params parsing, that the method is registered (never "method not found"),
//! and the reply mapping without needing a live container daemon.

use super::*;
use termihub_core::backends::docker::ContainerInfo;
use termihub_core::errors::SessionError;
use termihub_core::protocol::methods::DockerContainerEntry;

fn container(id: &str, name: &str, running: bool) -> ContainerInfo {
    ContainerInfo {
        id: id.into(),
        name: name.into(),
        image: "ubuntu:22.04".into(),
        state: if running { "running" } else { "exited" }.into(),
        status: if running { "Up 1 hour" } else { "Exited (0)" }.into(),
        running,
    }
}

#[tokio::test]
async fn docker_list_containers_requires_initialize() {
    let handler = make_handler();
    let r = dispatch(&handler, pm::DOCKER_LIST_CONTAINERS, json!({}), 2).await;
    assert_eq!(r["error"]["code"], errors::NOT_INITIALIZED, "{r}");
}

#[tokio::test]
async fn docker_list_containers_rejects_an_unknown_runtime() {
    let handler = make_handler();
    init_handler(&handler).await;
    let r = dispatch(
        &handler,
        pm::DOCKER_LIST_CONTAINERS,
        json!({ "runtime": "lxc" }),
        2,
    )
    .await;
    assert_eq!(r["error"]["code"], errors::INVALID_PARAMS, "{r}");
}

/// The method is registered and runs the real listing: with or without a
/// reachable daemon on the test host it answers a result or the runtime's
/// error — never "method not found" (which the desktop reads as "agent too
/// old").
#[tokio::test]
async fn docker_list_containers_is_registered_and_lists_or_reports_runtime_error() {
    let handler = make_handler();
    init_handler(&handler).await;
    for params in [json!({}), json!({ "runtime": "docker" })] {
        let r = dispatch(&handler, pm::DOCKER_LIST_CONTAINERS, params, 2).await;
        if let Some(result) = r.get("result") {
            let parsed: DockerListContainersResult =
                serde_json::from_value(result.clone()).expect("typed result");
            // Running containers always sort first.
            let first_stopped = parsed.containers.iter().position(|c| !c.running);
            if let Some(i) = first_stopped {
                assert!(parsed.containers[i..].iter().all(|c| !c.running));
            }
        } else {
            assert_eq!(r["error"]["code"], errors::INTERNAL_ERROR, "{r}");
            assert_ne!(r["error"]["code"], errors::METHOD_NOT_FOUND, "{r}");
            assert!(
                !r["error"]["message"].as_str().unwrap_or("").is_empty(),
                "{r}"
            );
        }
    }
}

#[test]
fn docker_list_reply_maps_containers_to_wire_entries_in_order() {
    let value = docker_list_reply(Ok(vec![
        container("a1", "web", true),
        container("b2", "old", false),
    ]))
    .expect("ok reply");
    let parsed: DockerListContainersResult = serde_json::from_value(value).unwrap();
    assert_eq!(
        parsed.containers,
        vec![
            DockerContainerEntry::from(container("a1", "web", true)),
            DockerContainerEntry::from(container("b2", "old", false)),
        ]
    );
}

#[test]
fn docker_list_reply_empty_listing_is_an_empty_array() {
    let value = docker_list_reply(Ok(Vec::new())).expect("ok reply");
    assert_eq!(value, json!({ "containers": [] }));
}

#[test]
fn docker_list_reply_unwraps_the_runtime_error_message() {
    let err = docker_list_reply(Err(SessionError::SpawnFailed(
        "Cannot connect to the Docker daemon".into(),
    )))
    .expect_err("error reply");
    assert_eq!(err.code() as i64, errors::INTERNAL_ERROR);
    assert_eq!(err.message(), "Cannot connect to the Docker daemon");
}
