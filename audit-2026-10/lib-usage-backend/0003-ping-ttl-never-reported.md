---
id: LIBBE2-003
title: "Ping never reports TTL: the code says surge-ping doesn't expose it, but surge-ping 0.8 does"
angle: lib-usage-backend
severity: low
category: correctness
is_workaround: false
subsystem: "core/network/ping"
evidence:
  - core/src/network/ping.rs:162
  - core/src/network/ping.rs:166
  - core/src/network/ping.rs:169
  - core/src/network/ping.rs:212
  - core/src/network/types.rs:75
  - src/components/NetworkTools/exportResults.ts:50
  - core/Cargo.toml:21
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

icmp_ping drops the reply packet (`Ok((_packet, duration))`) and hard-codes `ttl: None` with the comment '// surge-ping doesn't expose TTL directly'. surge-ping 0.8.4 (the locked version) does expose it: IcmpPacket::V4 has Icmpv4Packet::get_ttl() -> Option<u8>, and V6 has Icmpv6Packet::get_max_hop_limit(). As a result PingResult.ttl (types.rs:75) is always null and the TTL column of the ping CSV export (exportResults.ts:50) is always empty. Latency is also cut to whole milliseconds by `duration.as_millis()`, so LAN pings show 0 ms. Separately, rand_id() (ping.rs:212) builds the ICMP identifier from SystemTime subsec_nanos, even though `rand` is a non-optional core dependency (core/Cargo.toml:21).

## Why it matters

This is a user-visible data gap caused by not using the existing library's API: the TTL field and export column exist but can never be filled. Sub-millisecond truncation makes the latency chart and stats useless on local networks. The clock-based identifier is weak entropy for something the library uses to match replies.

## Evidence

- `core/src/network/ping.rs:162`
- `core/src/network/ping.rs:166`
- `core/src/network/ping.rs:169`
- `core/src/network/ping.rs:212`
- `core/src/network/types.rs:75`
- `src/components/NetworkTools/exportResults.ts:50`
- `core/Cargo.toml:21`

## Recommendation

Match on the returned packet: `surge_ping::IcmpPacket::V4(p) => p.get_ttl()`, `IcmpPacket::V6(p) => Some(p.get_max_hop_limit())`, and fill `ttl` with that value. Report latency as fractional milliseconds (`duration.as_secs_f64() * 1000.0`) if the wire type can become f64, or at least round instead of truncating. Replace rand_id with `rand::random::<u16>()`. Remove the stale comment.

## Verification

Confirmed at core/src/network/ping.rs:167-171. The code ignores `_packet`, hard-codes `ttl: None` with the stale comment, and truncates latency with as_millis(). The locked surge-ping 0.8.4 exposes Icmpv4Packet::get_ttl() -> Option<u8> (icmpv4.rs:102) and Icmpv6Packet::get_max_hop_limit() (icmpv6.rs:89). rand 0.8 is a core dependency (core/Cargo.toml:40). One caveat: the IPv6 'max hop limit' is not really the received hop limit, and get_ttl can still return None on DGRAM sockets. Even so, the IPv4 TTL column is needlessly always empty.
