---
id: CORE-026
title: Traceroute does not correlate ICMP replies to the probe that generated them
angle: backend-core-rust
severity: medium
category: bug
is_workaround: false
subsystem: core/network/traceroute
evidence:
  - core/src/network/traceroute.rs:139
status: fixed
resolution: "#2804 — traceroute: unique dest port per probe + correlate ICMP via embedded UDP header (icmp_reply_matches_probe)"
---

## What
The traceroute loop sends a UDP datagram, then accepts the first ICMP reply that
passes a coarse type check (`is_valid_icmp_reply`) as the answer for the current
hop, without matching the reply's embedded original datagram (dest port / IP-ID)
to the probe it actually sent:

```rust
let _ = send_sock.send_to(&[0u8; 20], &dest_sock_addr);
match recv_sock.recv_from(&mut buf) {
    Ok((len, src_addr)) => {
        let filled = unsafe { std::slice::from_raw_parts(buf.as_ptr().cast::<u8>(), len) };
        if is_valid_icmp_reply(filled, dest_ip.is_ipv6()) {
            ...
            router_ip = Some(ip);
```

## Why it matters
A single shared raw recv socket receives ICMP for all probes. A late reply from a
previous hop, or an unrelated ICMP message arriving in the window, is attributed
to the current hop, producing wrong hop→router mappings and RTTs. Real traceroute
implementations correlate on the quoted original packet (unique dest port or
ICMP id/seq per probe).

## Evidence
`core/src/network/traceroute.rs:135-153`. Probes are identical (`&[0u8; 20]` to a
fixed `UDP_DEST_PORT`), so replies cannot be disambiguated.

## Recommendation
Encode a per-probe identifier (unique destination port, or ICMP echo id/seq for
the ICMP variant) and validate the ICMP error's quoted inner header against it
before accepting the reply for that hop.
