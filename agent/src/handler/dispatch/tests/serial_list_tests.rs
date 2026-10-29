//! `serial.list_ports` (#5069): the desktop polls the agent host's serial
//! ports while an agent-hosted serial connection's Port field is visible.
//! Covers the init gate, that the method is registered (never "method not
//! found", which the desktop reads as "agent too old"), the reply shape and
//! the `serialPortRescan` capability.

use super::*;
use termihub_core::protocol::methods::SerialListPortsResult;

#[tokio::test]
async fn serial_list_ports_requires_initialize() {
    let handler = make_handler();
    let r = dispatch(&handler, pm::SERIAL_LIST_PORTS, json!({}), 2).await;
    assert_eq!(r["error"]["code"], errors::NOT_INITIALIZED, "{r}");
}

/// The method runs the same enumeration as the `initialize` snapshot, so the
/// result equals a direct `list_serial_ports()` call on this host (empty on a
/// CI runner without adapters) and is in natural order.
#[tokio::test]
async fn serial_list_ports_returns_the_hosts_ports_in_natural_order() {
    let handler = make_handler();
    init_handler(&handler).await;
    for params in [json!({}), Value::Null] {
        let r = dispatch(&handler, pm::SERIAL_LIST_PORTS, params, 2).await;
        let result = r.get("result").unwrap_or_else(|| panic!("result: {r}"));
        let parsed: SerialListPortsResult =
            serde_json::from_value(result.clone()).expect("typed result");
        assert_eq!(
            parsed.ports,
            termihub_core::session::serial::list_serial_ports()
        );
    }
}

#[test]
fn serial_list_reply_wraps_the_ports() {
    let value = serial_list_reply(vec!["COM3".into(), "COM10".into()]).expect("ok reply");
    assert_eq!(value, json!({ "ports": ["COM3", "COM10"] }));
    let empty = serial_list_reply(Vec::new()).expect("ok reply");
    assert_eq!(empty, json!({ "ports": [] }));
}

/// The desktop only polls an agent that advertises the flag (#5069).
#[tokio::test]
async fn initialize_advertises_serial_port_rescan() {
    let handler = make_handler();
    let result = dispatch(&handler, "initialize", init_params(), 1).await;
    assert_eq!(result["result"]["capabilities"]["serialPortRescan"], true);
}
