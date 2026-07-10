/**
 * Agent version / update-state helpers.
 *
 * Mirrors the desktop-side compatibility rule in `src-tauri/src/utils/version.rs`
 * (`check_version`): same major required, agent minor >= desktop minor, patch
 * ignored. Unlike the Rust helper this also tolerates a `-prerelease` / `+build`
 * suffix (dev builds report e.g. `0.1.0-dev`) by stripping it before comparing.
 */

/** Parsed semantic version components. */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/** Derived update state for a remote agent, shown as a badge in the UI. */
export type AgentUpdateState =
  | "up-to-date"
  | "update-available"
  | "incompatible"
  | "updating"
  | "unknown";

/** States that {@link resolveAgentUpdateState} can derive purely from versions. */
export type ResolvedAgentUpdateState = Exclude<AgentUpdateState, "updating">;

/**
 * Parse a `major.minor.patch` version string into its numeric components.
 *
 * Any `-prerelease` or `+build` suffix is stripped first so dev builds
 * (e.g. `0.1.0-dev`) compare against their base version. Returns `null` when
 * the string does not contain exactly three dot-separated unsigned integers.
 */
export function parseAgentSemver(version: string | undefined | null): SemVer | null {
  if (!version) return null;
  const core = version.split(/[-+]/, 1)[0];
  const parts = core.split(".");
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => Number.isNaN(n))) return null;
  return { major: nums[0], minor: nums[1], patch: nums[2] };
}

/**
 * Resolve an agent's update state from its reported version and the desktop's
 * expected version.
 *
 * - no/empty agent version, or desktop version not yet known -> `"unknown"`
 *   (nothing to show; the desktop version loads asynchronously)
 * - unparseable (but present) agent version, or major mismatch -> `"incompatible"`
 * - agent minor older than desktop -> `"update-available"`
 * - otherwise -> `"up-to-date"`
 */
export function resolveAgentUpdateState(
  agentVersion: string | undefined | null,
  desktopVersion: string | undefined | null
): ResolvedAgentUpdateState {
  if (!agentVersion || !agentVersion.trim()) return "unknown";
  // Desktop version not loaded yet -> hide the badge rather than flashing
  // "incompatible" while the app-info fetch is in flight.
  if (!desktopVersion || !desktopVersion.trim()) return "unknown";

  const agent = parseAgentSemver(agentVersion);
  const desktop = parseAgentSemver(desktopVersion);
  if (!agent || !desktop) return "incompatible";

  if (agent.major !== desktop.major) return "incompatible";
  if (agent.minor < desktop.minor) return "update-available";
  return "up-to-date";
}

/** Minimal agent shape needed to summarise update state (structural). */
export interface AgentUpdateSummaryInput {
  connectionState: string;
  capabilities?: { agentVersion?: string };
}

/** Aggregate counts for the status-bar summary. */
export interface AgentUpdateSummary {
  /** Number of currently connected agents. */
  connectedCount: number;
  /** How many connected agents have an update available. */
  updatesAvailable: number;
}

/**
 * Summarise connected agents and how many have an update available, for the
 * status-bar "N agents · M updates available" indicator. Only `connected`
 * agents are counted (a disconnected agent reports no live version).
 */
export function summarizeAgentUpdates(
  agents: AgentUpdateSummaryInput[],
  desktopVersion: string | undefined | null
): AgentUpdateSummary {
  const connected = agents.filter((a) => a.connectionState === "connected");
  // resolveAgentUpdateState already yields "unknown" (never "update-available")
  // when the desktop version is not yet known, so no separate guard is needed.
  const updatesAvailable = connected.filter(
    (a) =>
      resolveAgentUpdateState(a.capabilities?.agentVersion, desktopVersion) === "update-available"
  ).length;
  return { connectedCount: connected.length, updatesAvailable };
}
