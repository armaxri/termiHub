/**
 * Reachability probing for the startup session-restore dialog.
 *
 * Given the per-tab {@link RestoreTabTarget}s derived from a stored session,
 * this resolves each target to a {@link RestoreReachability} so the dialog can
 * flag unavailable targets (device disconnected / host unreachable) with a
 * warning icon. The probe primitives are injected so the orchestration stays
 * pure and unit-testable — no direct Tauri/API calls here.
 */

import type { RestoreReachability, RestoreTabTarget } from "@/utils/restoreMode";

/** Injected probe primitives used to determine reachability. */
export interface ReachabilityProbe {
  /** List the serial device paths currently present on the machine. */
  listSerialPorts: () => Promise<string[]>;
  /** Attempt a TCP connect to `host:port`, resolving `true` when it succeeds. */
  probeHost: (host: string, port: number) => Promise<boolean>;
}

/** Resolved reachability for a single tab. */
export interface TabReachability {
  reachability: RestoreReachability;
  /** Short reason shown beside the warning icon when `unreachable`. */
  reason?: string;
}

const UNKNOWN: TabReachability = { reachability: "unknown" };

/**
 * Probe every target and return a reachability verdict per target, index-aligned
 * with the input. Serial ports are listed once and shared across all serial
 * targets; host targets are probed concurrently. `local` and `agent` targets are
 * not network-probed and resolve to `"unknown"`. Any probe failure degrades to
 * `"unknown"` rather than a false "unreachable".
 */
export async function probeRestoreTargets(
  targets: RestoreTabTarget[],
  probe: ReachabilityProbe
): Promise<TabReachability[]> {
  const needsSerial = targets.some((t) => t.kind === "serial");
  let serialPorts: string[] | null = null;
  if (needsSerial) {
    try {
      serialPorts = await probe.listSerialPorts();
    } catch {
      serialPorts = null;
    }
  }

  return Promise.all(
    targets.map(async (target): Promise<TabReachability> => {
      if (target.kind === "serial") {
        if (!serialPorts || !target.device) return UNKNOWN;
        return serialPorts.includes(target.device)
          ? { reachability: "reachable" }
          : { reachability: "unreachable", reason: "device offline" };
      }

      if (target.kind === "host" && target.host && target.port) {
        try {
          const reachable = await probe.probeHost(target.host, target.port);
          return reachable
            ? { reachability: "reachable" }
            : { reachability: "unreachable", reason: "host unreachable" };
        } catch {
          return UNKNOWN;
        }
      }

      return UNKNOWN;
    })
  );
}
