// The embedded-server DTOs are generated from their Rust source of truth via
// ts-rs (audit DUP-030, ts-rs rollout #3088): the config/state/activity types
// from core `core/src/embedded_servers/{config,activity}.rs` (behind core's
// `embedded-servers` feature) and `NetworkInterface` from
// `src-tauri/src/commands/embedded_servers.rs`. `FtpAuth` / `HttpBasicAuth`
// passwords are write-only (#3514): the backend always returns `""`.
import type { ServerType } from "./generated/ServerType";

export type { ServerType };
export type { ServerStatus } from "./generated/ServerStatus";
export type { FtpAuth } from "./generated/FtpAuth";
export type { HttpBasicAuth } from "./generated/HttpBasicAuth";
export type { EmbeddedServerConfig } from "./generated/EmbeddedServerConfig";
export type { ServerStats } from "./generated/ServerStats";
export type { ServerState } from "./generated/ServerState";
export type { AccessLogEntry } from "./generated/AccessLogEntry";
export type { TopEntry } from "./generated/TopEntry";
export type { TransferInfo } from "./generated/TransferInfo";
export type { DetailedServerStats } from "./generated/DetailedServerStats";
export type { ServerActivity } from "./generated/ServerActivity";
export type { NetworkInterface } from "./generated/NetworkInterface";

/** Default ports per protocol. */
export const DEFAULT_PORTS: Record<ServerType, number> = {
  http: 8080,
  ftp: 2121,
  tftp: 6969,
};

/** Protocol display labels. */
export const PROTOCOL_LABELS: Record<ServerType, string> = {
  http: "HTTP",
  ftp: "FTP",
  tftp: "TFTP",
};
