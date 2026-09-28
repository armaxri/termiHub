/**
 * A port field while it is being edited. Empty (`""`) represents a cleared
 * input — the shared `number | ""` blank-value convention (#1444) — which the
 * tunnel editor flags as required/invalid and blocks Save on, rather than
 * coercing to `0`. A persisted config always holds a real port number.
 */
export type PortValue = number | "";

// The tunnel DTOs are generated from their Rust source of truth via ts-rs
// (audit DUP-030, ts-rs rollout #3088): the forward configs, stats and
// reachability from `core/src/tunnel`, the rest from `src-tauri/src/tunnel/config.rs`
// and `src-tauri/src/run_location.rs`. The generated forward-config ports are
// `number | ""` ({@link PortValue}); the Rust `serde(default)` fields `host` and
// `startWithConnection` are optional so a config persisted before they existed
// (or a hand-built fixture) still type-checks. `RunLocation` is also used locally.
import type { RunLocation } from "./generated/RunLocation";

export type { RunLocation };
export type { LocalForwardConfig } from "./generated/LocalForwardConfig";
export type { RemoteForwardConfig } from "./generated/RemoteForwardConfig";
export type { DynamicForwardConfig } from "./generated/DynamicForwardConfig";
export type { TunnelType } from "./generated/TunnelType";
export type { TunnelConfig } from "./generated/TunnelConfig";
export type { TunnelStatus } from "./generated/TunnelStatus";
export type { TunnelStats } from "./generated/TunnelStats";
export type { ReachableFrom } from "./generated/ReachableFrom";
export type { TunnelState } from "./generated/TunnelState";

/** The desktop-host run-location — the default for a tunnel. */
export const THIS_COMPUTER: RunLocation = { kind: "thisComputer" };
