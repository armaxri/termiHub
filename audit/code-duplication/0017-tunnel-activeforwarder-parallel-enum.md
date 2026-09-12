---
id: DUP-017
title: Parallel ActiveForwarder enum + get_stats dispatch in desktop and agent tunnel layers
angle: code-duplication
severity: low
category: arch
is_workaround: false
subsystem: src-tauri/tunnel/tunnel_manager.rs vs agent/tunnel/mod.rs
evidence:
  - src-tauri/src/tunnel/tunnel_manager.rs:254
  - agent/src/tunnel/mod.rs:44
status: open
---

## What

Both the desktop tunnel manager and the agent tunnel registry declare their own `ActiveForwarder`
enum wrapping the identical three core forwarders (`LocalForwarder`/`RemoteForwarder`/
`DynamicForwarder`), with near-identical match-arm dispatch for `get_stats`/`stop`. The forwarding
engines themselves are correctly single-sourced in `core::tunnel` — this duplication is only in the
wrapper enum.

## Why it matters

Low and stable today, but a 4th forward mode (or a signature change on the core forwarders) must be
edited in both enums and every match site, with nothing forcing them in sync.

## Evidence

- `src-tauri/src/tunnel/tunnel_manager.rs:254` (enum), `:319-335` (`get_stats`/`take_death_signal`),
  `:1550` (`stop`).
- `agent/src/tunnel/mod.rs:44-63` (enum + `get_stats`).

## Recommendation

Add a single `core::tunnel::AnyForwarder` enum wrapping the three, exposing
`get_stats()`/`stop()`/`take_death_signal()`. Both hosts hold that instead of each declaring their
own (the agent relies on `Drop` and simply won't call some methods).
