//! `host.addresses` (#6086): the file server editor offers the agent host's
//! addresses to choose from. Covers the init gate, the reply and the
//! `hostAddresses` capability.

use super::*;
use termihub_core::protocol::methods::HostAddressesResult;

#[tokio::test]
async fn host_addresses_requires_initialize() {
    let handler = make_handler();
    let r = dispatch(&handler, pm::HOST_ADDRESSES, json!({}), 2).await;
    assert_eq!(r["error"]["code"], errors::NOT_INITIALIZED, "{r}");
}

/// The same IPv4 addresses the system lists, loopback left out.
#[tokio::test]
async fn host_addresses_lists_this_hosts_ipv4_addresses_without_loopback() {
    let handler = make_handler();
    init_handler(&handler).await;
    let r = dispatch(&handler, pm::HOST_ADDRESSES, json!({}), 2).await;
    let result = r.get("result").unwrap_or_else(|| panic!("result: {r}"));
    let parsed: HostAddressesResult = serde_json::from_value(result.clone()).expect("typed");
    assert_eq!(parsed.addresses, host_addresses());
    for address in &parsed.addresses {
        let ip: std::net::Ipv4Addr = address.addr.parse().expect("an IPv4 address");
        assert!(!ip.is_loopback(), "{address:?}");
        assert!(!address.name.is_empty());
    }
}

/// The desktop only asks an agent that advertises the flag (#6086).
#[tokio::test]
async fn initialize_advertises_host_addresses() {
    let handler = make_handler();
    let result = dispatch(&handler, "initialize", init_params(), 1).await;
    assert_eq!(result["result"]["capabilities"]["hostAddresses"], true);
}
