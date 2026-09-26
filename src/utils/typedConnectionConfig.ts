import type { ConnectionConfig, ShellType } from "@/types/terminal";
import type { JumpHostConfig } from "@/types/connection";

/**
 * A frontend-typed *view* over a {@link ConnectionConfig}'s schema-driven
 * settings bag (FEC-008 follow-up, #3083).
 *
 * The persisted {@link ConnectionConfig} is generated from the Rust source of
 * truth (`src-tauri/src/terminal/backend.rs`) as
 * `{ type: string; config: Record<string, unknown> }`: the connection type is a
 * plain string and the per-type settings are unstructured JSON, because the
 * concrete field set is driven by the backend's JSON schemas (`DynamicForm`) and
 * plugins can register arbitrary types. A **generated** discriminated union of
 * every per-type shape (audit DUP-030) would need the backend to stop storing
 * the bag as unstructured JSON, so it stays out of scope here.
 *
 * What *is* typeable without drift is the fixed set of **built-in** connection
 * types, whose config shapes mirror the Rust DTOs in `core/src/config/mod.rs`.
 * The interfaces below capture those shapes as a typed view; each carries a
 * `[key: string]: unknown` index signature so the view stays a *superset* of the
 * open bag — declared fields read with real types, any other field reads as
 * `unknown` (matching the schema-driven reality), and a `Record<string, unknown>`
 * bag narrows to the view cleanly.
 *
 * Narrowing is done with the runtime {@link isLocalConnectionConfig}-style type
 * guards below rather than a discriminated-union *type* with a permissive
 * fallback member: a `{ type: string; config: Record<string, unknown> }` fallback
 * would subsume every literal-keyed member (`"local"` is assignable to `string`),
 * collapsing the union and defeating narrowing. The guards keep the discriminant
 * check at one place, give call sites genuine narrowing with no `as`, and let any
 * unknown / plugin type fall through to the untyped bag read via the
 * `connectionConfigFields` accessors.
 */

/** Built-in local-shell config fields (Rust `ShellConfig`, `type: "local"`). */
export interface LocalShellConfig {
  [key: string]: unknown;
  /** Selected shell. `shellType` is a tolerated legacy alias for the same value. */
  shell?: ShellType;
  shellType?: ShellType;
  initialCommand?: string;
  startingDirectory?: string;
}

/** Built-in WSL config fields (Rust `WslConfig`, `type: "wsl"`). */
export interface WslConnectionConfigFields {
  [key: string]: unknown;
  distribution?: string;
  shell?: ShellType;
  initialCommand?: string;
  startingDirectory?: string;
}

/** Built-in SSH config fields (Rust `SshConfig`, `type: "ssh"`). */
export interface SshConnectionConfigFields {
  [key: string]: unknown;
  host?: string;
  port?: number;
  username?: string;
  authMethod?: string;
  password?: string;
  keyPath?: string;
  shell?: string;
  savePassword?: boolean;
  forwardAgent?: boolean;
  connectTimeoutSecs?: number;
  suppressSecurityWarning?: boolean;
  /** Jump-host (`ProxyJump`) chain; `jumpHosts` is the tolerated legacy alias. */
  proxyJump?: JumpHostConfig[];
  jumpHosts?: JumpHostConfig[];
}

/** Built-in serial config fields (Rust `SerialConfig`, `type: "serial"`). */
export interface SerialConnectionConfigFields {
  [key: string]: unknown;
  port?: string;
  baudRate?: number;
  dataBits?: number;
  stopBits?: number;
  parity?: string;
  flowControl?: string;
}

/** Built-in telnet config fields (Rust `TelnetConfig`, `type: "telnet"`). */
export interface TelnetConnectionConfigFields {
  [key: string]: unknown;
  host?: string;
  port?: number;
  connectTimeoutSecs?: number;
  /** Terminal type reported via TERMINAL-TYPE (RFC 1091); default `xterm-256color`. */
  terminalType?: string;
  /** `"none"` (manual login, default) or `"password"` (prompt-driven auto-login). */
  authMethod?: string;
  /** Auto-login username. */
  username?: string;
  /** Auto-login password — resolved from the credential store, never persisted. */
  password?: string;
  savePassword?: boolean;
  /** `|`-separated, case-insensitive login-prompt patterns. */
  loginPrompt?: string;
  /** `|`-separated, case-insensitive password-prompt patterns. */
  passwordPrompt?: string;
  /** Seconds to wait for each auto-login prompt. */
  autoLoginTimeoutSecs?: number;
}

/** Built-in Docker config fields (Rust `DockerConfig`, `type: "docker"`). */
export interface DockerConnectionConfigFields {
  [key: string]: unknown;
  /**
   * How the session gets its container: `"new"` (default) creates and runs a
   * fresh container from `image`; `"existing"` execs into the already-running
   * container named by `existingContainer` (PROD-016).
   */
  containerMode?: "new" | "existing";
  /** Name or ID of the running container to exec into when `containerMode` is `"existing"`. */
  existingContainer?: string;
  image?: string;
  shell?: string;
  runtime?: string;
  workingDirectory?: string;
  removeOnExit?: boolean;
}

/**
 * Discriminated union of the **built-in** connection config shapes, keyed on
 * `type`. Genuinely narrowable (no subsuming fallback member — schema-driven and
 * plugin types are handled by the guards falling through to the untyped bag).
 */
export type BuiltInConnectionConfig =
  | { type: "local"; config: LocalShellConfig }
  | { type: "wsl"; config: WslConnectionConfigFields }
  | { type: "ssh"; config: SshConnectionConfigFields }
  | { type: "serial"; config: SerialConnectionConfigFields }
  | { type: "telnet"; config: TelnetConnectionConfigFields }
  | { type: "docker"; config: DockerConnectionConfigFields };

type Extract2<TType extends BuiltInConnectionConfig["type"]> = Extract<
  BuiltInConnectionConfig,
  { type: TType }
>;

/** True when the config is a built-in local-shell connection. */
export function isLocalConnectionConfig(
  config: ConnectionConfig | null | undefined
): config is Extract2<"local"> {
  return config?.type === "local";
}

/** True when the config is a built-in WSL connection. */
export function isWslConnectionConfig(
  config: ConnectionConfig | null | undefined
): config is Extract2<"wsl"> {
  return config?.type === "wsl";
}

/** True when the config is a built-in SSH connection. */
export function isSshConnectionConfig(
  config: ConnectionConfig | null | undefined
): config is Extract2<"ssh"> {
  return config?.type === "ssh";
}

/** True when the config is a built-in serial connection. */
export function isSerialConnectionConfig(
  config: ConnectionConfig | null | undefined
): config is Extract2<"serial"> {
  return config?.type === "serial";
}

/** True when the config is a built-in telnet connection. */
export function isTelnetConnectionConfig(
  config: ConnectionConfig | null | undefined
): config is Extract2<"telnet"> {
  return config?.type === "telnet";
}

/** True when the config is a built-in Docker connection. */
export function isDockerConnectionConfig(
  config: ConnectionConfig | null | undefined
): config is Extract2<"docker"> {
  return config?.type === "docker";
}
