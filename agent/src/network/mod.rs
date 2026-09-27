//! Network diagnostics on the agent.
//!
//! Every built-in network tool (ping, ping sweep, port scan, traceroute, DNS,
//! open ports, Wake-on-LAN) runs through the agent's core
//! [`ToolRegistry`](termihub_core::tool::ToolRegistry) behind the `tool.*`
//! JSON-RPC methods — one-shot via `tool.run`, streamed via `tool.start` (see
//! [`streaming`]). The dedicated per-tool `network.*` methods were retired in
//! protocol 0.12.0 (#3731, DUP-027), so there is exactly one code path.
//!
//! HTTP monitoring is not a tool: an agent hosts a monitor through `service.*`.

pub mod streaming;
