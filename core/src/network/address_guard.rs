//! The shared **blocked-address guard** (SEC-008, SEC2-005, SEC2-007, #4367).
//!
//! One classifier decides which IP addresses an outbound connection made *on
//! someone else's behalf* may reach. Two callers use it:
//!
//! - the HTTP monitor's SSRF guard (`monitoring::http_monitor`), which fetches a
//!   config-supplied URL and can run agent-side, and
//! - the plugin capability bridge's `open_connection` (`plugin::capabilities`),
//!   which dials out for a sandboxed native plugin.
//!
//! Both resolve the target once, drop every address [`is_blocked_ip`] refuses,
//! and connect only to the survivors, so a hostname cannot rebind to an
//! internal address between the check and the connection.
//!
//! # Classes
//!
//! [`classify`] sorts an address into one of three [`AddressClass`]es:
//!
//! - **[`AlwaysBlocked`](AddressClass::AlwaysBlocked)** — no legitimate target,
//!   refused even under the local-network opt-in: the unspecified address and
//!   `0.0.0.0/8` ("this network"), IPv4 link-local `169.254.0.0/16` (incl. the
//!   cloud metadata endpoint `169.254.169.254`), IPv4 broadcast, IPv6
//!   link-local `fe80::/10`, and the explicit cloud metadata addresses in
//!   [`METADATA_ADDRESSES`] (Alibaba Cloud `100.100.100.200`, AWS IPv6 IMDS
//!   `fd00:ec2::254`) that sit outside link-local space.
//! - **[`Internal`](AddressClass::Internal)** — the local machine and private
//!   networks, refused unless the caller opted in (`allow_private`): loopback
//!   (`127.0.0.0/8`, `::1`), RFC 1918 (`10/8`, `172.16/12`, `192.168/16`), shared
//!   address space (RFC 6598 `100.64.0.0/10`, carrier-grade NAT), and IPv6
//!   unique-local `fc00::/7`.
//! - **[`Public`](AddressClass::Public)** — everything else.
//!
//! IPv4-mapped (`::ffff:a.b.c.d`) and NAT64 well-known-prefix
//! (`64:ff9b::a.b.c.d`, RFC 6052) addresses are classified by the IPv4 address
//! they embed, so neither form can smuggle a blocked IPv4 target past the v4
//! rules.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Cloud metadata endpoints outside link-local space, refused regardless of the
/// local-network opt-in (SEC2-007).
///
/// `169.254.169.254` (AWS/GCP/Azure/OpenStack) needs no entry: all of
/// `169.254.0.0/16` is always blocked.
pub const METADATA_ADDRESSES: [IpAddr; 2] = [
    // Alibaba Cloud ECS metadata — inside 100.64/10, so not link-local.
    IpAddr::V4(Ipv4Addr::new(100, 100, 100, 200)),
    // AWS IMDS over IPv6 — inside fc00::/7, so otherwise merely "internal".
    IpAddr::V6(Ipv6Addr::new(0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254)),
];

/// How the blocked-address guard treats an address. See the module docs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressClass {
    /// Never reachable, even with the local-network opt-in.
    AlwaysBlocked,
    /// The local machine or a private network: reachable only with the opt-in.
    Internal,
    /// Reachable without any opt-in.
    Public,
}

/// Classify `ip` for the blocked-address guard.
#[must_use]
pub fn classify(ip: IpAddr) -> AddressClass {
    match ip {
        IpAddr::V4(v4) => classify_v4(v4),
        IpAddr::V6(v6) => match embedded_ipv4(v6) {
            Some(v4) => classify_v4(v4),
            None => classify_v6(v6),
        },
    }
}

/// Whether the guard refuses `ip`: always for
/// [`AlwaysBlocked`](AddressClass::AlwaysBlocked), and for
/// [`Internal`](AddressClass::Internal) unless `allow_private` (the caller's
/// local-network opt-in) is set.
#[must_use]
pub fn is_blocked_ip(ip: IpAddr, allow_private: bool) -> bool {
    match classify(ip) {
        AddressClass::AlwaysBlocked => true,
        AddressClass::Internal => !allow_private,
        AddressClass::Public => false,
    }
}

/// The IPv4 address embedded in an IPv4-mapped (`::ffff:0:0/96`) or NAT64
/// well-known-prefix (`64:ff9b::/96`) address, if `ip` is one.
fn embedded_ipv4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return Some(v4);
    }
    let s = ip.segments();
    if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        let [_, _, _, _, _, _, _, _, _, _, _, _, a, b, c, d] = ip.octets();
        return Some(Ipv4Addr::new(a, b, c, d));
    }
    None
}

fn classify_v4(ip: Ipv4Addr) -> AddressClass {
    if METADATA_ADDRESSES.contains(&IpAddr::V4(ip))
        || ip.octets()[0] == 0
        || ip.is_link_local()
        || ip.is_broadcast()
    {
        return AddressClass::AlwaysBlocked;
    }
    if ip.is_loopback() || ip.is_private() || is_shared_v4(ip) {
        return AddressClass::Internal;
    }
    AddressClass::Public
}

fn classify_v6(ip: Ipv6Addr) -> AddressClass {
    if METADATA_ADDRESSES.contains(&IpAddr::V6(ip)) || ip.is_unspecified() || is_ipv6_link_local(ip)
    {
        return AddressClass::AlwaysBlocked;
    }
    if ip.is_loopback() || is_ipv6_unique_local(ip) {
        return AddressClass::Internal;
    }
    AddressClass::Public
}

/// `100.64.0.0/10` — RFC 6598 shared address space (carrier-grade NAT).
fn is_shared_v4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 100 && (b & 0xc0) == 64
}

/// `fe80::/10` — IPv6 link-local unicast.
fn is_ipv6_link_local(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfe80
}

/// `fc00::/7` — IPv6 unique-local addresses.
fn is_ipv6_unique_local(ip: Ipv6Addr) -> bool {
    (ip.octets()[0] & 0xfe) == 0xfc
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn always_blocked_forms_stay_blocked_under_the_opt_in() {
        for addr in [
            "0.0.0.0",
            "0.1.2.3",
            "169.254.169.254",
            "169.254.0.1",
            "255.255.255.255",
            "100.100.100.200",
            "::",
            "fe80::1",
            "febf::1",
            "fd00:ec2::254",
            "::ffff:169.254.169.254",
            "::ffff:100.100.100.200",
            "64:ff9b::a9fe:a9fe",
            "64:ff9b::6464:64c8",
            "64:ff9b::",
        ] {
            assert_eq!(classify(ip(addr)), AddressClass::AlwaysBlocked, "{addr}");
            assert!(is_blocked_ip(ip(addr), false), "{addr}");
            assert!(is_blocked_ip(ip(addr), true), "{addr} under opt-in");
        }
    }

    #[test]
    fn internal_forms_need_the_opt_in() {
        for addr in [
            "127.0.0.1",
            "127.255.255.254",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "100.64.0.1",
            "100.100.100.201",
            "100.127.255.254",
            "::1",
            "fc00::1",
            "fd00:ec2::253",
            "::ffff:127.0.0.1",
            "::ffff:100.64.0.1",
            "64:ff9b::7f00:1",
            "64:ff9b::a00:1",
        ] {
            assert_eq!(classify(ip(addr)), AddressClass::Internal, "{addr}");
            assert!(is_blocked_ip(ip(addr), false), "{addr}");
            assert!(!is_blocked_ip(ip(addr), true), "{addr} under opt-in");
        }
    }

    #[test]
    fn public_forms_are_allowed() {
        for addr in [
            "8.8.8.8",
            "1.1.1.1",
            "100.63.255.255",
            "100.128.0.1",
            "172.15.0.1",
            "172.32.0.1",
            "192.0.2.1",
            "2606:4700:4700::1111",
            "64:ff9b::808:808",
            "fec0::1",
        ] {
            let parsed = ip(addr);
            assert_eq!(classify(parsed), AddressClass::Public, "{addr}");
            assert!(!is_blocked_ip(parsed, false), "{addr}");
        }
    }
}
