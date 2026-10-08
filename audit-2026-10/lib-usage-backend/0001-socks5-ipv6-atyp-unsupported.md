---
id: LIBBE2-001
title: "Hand-rolled SOCKS5 server for dynamic (-D) tunnels rejects IPv6 (ATYP 0x04) targets and sends the wrong reply code"
angle: lib-usage-backend
severity: medium
category: correctness
is_workaround: false
subsystem: "core/tunnel/dynamic_forward (desktop + agent)"
evidence:
  - core/src/tunnel/dynamic_forward.rs:49
  - core/src/tunnel/dynamic_forward.rs:52
  - core/src/tunnel/dynamic_forward.rs:53
  - core/src/tunnel/dynamic_forward.rs:56
  - core/src/tunnel/dynamic_forward.rs:258
  - core/src/tunnel/dynamic_forward.rs:284
  - core/src/tunnel/dynamic_forward.rs:307
  - core/src/tunnel/dynamic_forward.rs:505
  - core/src/tunnel/dynamic_forward.rs:511
  - src-tauri/src/tunnel/dynamic_forward.rs:11
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The `ssh -D` SOCKS proxy is a hand-written RFC 1928 parser. It handles only ATYP 0x01 (IPv4) and 0x03 (domain). Any other address type, including 0x04 (IPv6), falls into the `_` arm at :284 and gets reply 0x07 'Command not supported' instead of RFC 1928's 0x08 'Address type not supported'. The unit test at :505-511 locks this in ('ATYP 0x04 (IPv6) is not handled'). SOCKS4/4a, which OpenSSH's -D also serves, is not supported either. The same engine runs on the desktop and, through the agent, remotely (src-tauri re-exports it at src-tauri/src/tunnel/dynamic_forward.rs:11).

## Why it matters

Clients that resolve names locally (curl --socks5, tools with remote DNS off, or anything given an IPv6 literal) send ATYP 0x04 whenever the target resolves to IPv6. On dual-stack or IPv6-only networks the tunnel then fails for those connections with no useful hint, because 0x07 tells the client the CONNECT command is unsupported. Users expect parity with `ssh -D`, which handles IPv4, IPv6 and domain targets. The protocol parsing is the part a maintained crate already covers completely, so this gap comes from building it by hand.

## Evidence

- `core/src/tunnel/dynamic_forward.rs:49`
- `core/src/tunnel/dynamic_forward.rs:52`
- `core/src/tunnel/dynamic_forward.rs:53`
- `core/src/tunnel/dynamic_forward.rs:56`
- `core/src/tunnel/dynamic_forward.rs:258`
- `core/src/tunnel/dynamic_forward.rs:284`
- `core/src/tunnel/dynamic_forward.rs:307`
- `core/src/tunnel/dynamic_forward.rs:505`
- `core/src/tunnel/dynamic_forward.rs:511`
- `src-tauri/src/tunnel/dynamic_forward.rs:11`

## Recommendation

Smallest fix: add a SOCKS5_ATYP_IPV6 = 0x04 arm that reads 16 bytes into std::net::Ipv6Addr, uses its to_string() (no brackets) as the direct-tcpip host, and reads the port. Send REP 0x08 for any remaining unknown ATYP, and change the test at :502-513 to assert IPv6 now connects and that an unknown ATYP (e.g. 0x05) gets 0x08. Alternative: hand the greeting and request parsing to a maintained SOCKS crate such as `fast-socks5` (server mode with a custom connect handler) or `socks5-proto`, and keep only the ChannelOpener relay and handshake timeout. That also makes SOCKS4a straightforward if parity with -D is wanted.

## Verification

Confirmed at core/src/tunnel/dynamic*forward.rs:49-56 and :258-287. Only the IPv4 (0x01) and domain (0x03) address types are parsed. The `*` arm replies SOCKS5_REP_CMD_NOT_SUPPORTED (0x07), where RFC 1928 calls for 0x08 'Address type not supported', and no 0x08 constant exists. The test at :505-511 asserts this behaviour. A client that resolves names locally (for example curl --socks5) and gets an IPv6 address will fail through the tunnel. Remote-DNS clients are unaffected, so medium rather than higher.
