import type { JumpHostConfig, SavedConnection } from "@/types/connection";
import { getJumpHosts } from "@/utils/jumpHost";

export interface ProxyJumpValidation {
  /** Blocking problems — save is prevented while any exist. */
  errors: string[];
  /** Non-blocking advisories — shown but do not prevent save. */
  warnings: string[];
}

/**
 * Context for validating saved-connection references in a chain. When omitted,
 * reference and circular-chain checks are skipped (inline-only validation).
 */
export interface ProxyJumpContext {
  /** All saved connections, used to resolve `connectionId` references. */
  connections: SavedConnection[];
  /** The id of the connection being edited, seeding circular detection. */
  currentConnectionId?: string;
}

/** Chains deeper than this are allowed but warned about (latency). */
export const MAX_RECOMMENDED_HOPS = 5;

/**
 * Validate an SSH `proxyJump` chain for the connection editor.
 *
 * Inline hops require host + username. When `ctx` is supplied, hops that
 * reference a saved connection (`connectionId`) are additionally checked: the
 * connection must exist and be SSH, and the chain must not be circular (#940).
 */
export function validateProxyJump(
  hops: JumpHostConfig[],
  ctx?: ProxyJumpContext
): ProxyJumpValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  hops.forEach((hop, i) => {
    const label = hops.length > 1 ? `Hop ${i + 1}` : "Jump host";
    if (hop.connectionId) {
      // Saved-connection reference: the target must exist and be SSH.
      if (ctx) {
        const ref = ctx.connections.find((c) => c.id === hop.connectionId);
        if (!ref) {
          errors.push(
            `${label}: referenced connection not found (it may have been deleted). ` +
              `Pick an existing SSH connection or switch to inline configuration.`
          );
        } else if (ref.config.type !== "ssh") {
          errors.push(`${label}: referenced connection "${ref.name}" is not an SSH connection.`);
        }
      }
    } else {
      // Inline hop: require the fields needed to open the connection.
      if (!hop.host?.trim()) errors.push(`${label}: host is required.`);
      if (!hop.username?.trim()) errors.push(`${label}: username is required.`);
    }
  });

  if (ctx && hasCircularReference(hops, ctx)) {
    errors.push(
      "Circular jump host chain detected: a referenced connection routes back through this one."
    );
  }

  if (hops.length > MAX_RECOMMENDED_HOPS) {
    warnings.push(`Chain has ${hops.length} hops. Deep chains may add connection latency.`);
  }

  return { errors, warnings };
}

/**
 * Detect a cycle reachable by following `connectionId` references. This is the
 * editor's save-time UX check; the authoritative connect-time safety net is the
 * backend resolver (`src-tauri/src/connection/jump_host_resolver.rs`), which runs
 * the same algorithm. Seeded with the connection being edited so a hop that
 * routes back through it (`A → B → A`) is caught.
 */
function hasCircularReference(hops: JumpHostConfig[], ctx: ProxyJumpContext): boolean {
  const visited = new Set<string>();
  if (ctx.currentConnectionId) visited.add(ctx.currentConnectionId);

  const walk = (chain: JumpHostConfig[]): boolean => {
    for (const hop of chain) {
      const refId = hop.connectionId;
      if (!refId) continue;
      if (visited.has(refId)) return true;
      const ref = ctx.connections.find((c) => c.id === refId);
      // Missing / non-SSH references are reported separately; they cannot cycle.
      if (!ref || ref.config.type !== "ssh") continue;
      visited.add(refId);
      if (walk(getJumpHosts(ref.config))) return true;
      visited.delete(refId);
    }
    return false;
  };

  return walk(hops);
}
