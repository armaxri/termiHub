import type { JumpHostConfig } from "@/types/connection";

export interface ProxyJumpValidation {
  /** Blocking problems — save is prevented while any exist. */
  errors: string[];
  /** Non-blocking advisories — shown but do not prevent save. */
  warnings: string[];
}

/** Chains deeper than this are allowed but warned about (latency). */
export const MAX_RECOMMENDED_HOPS = 5;

/**
 * Validate an SSH `proxyJump` chain for the connection editor.
 *
 * Scope: inline hops (host/username required). Saved-connection references
 * (`connectionId`) and circular-reference detection are handled in a later
 * phase and are skipped here.
 */
export function validateProxyJump(hops: JumpHostConfig[]): ProxyJumpValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  hops.forEach((hop, i) => {
    const label = hops.length > 1 ? `Hop ${i + 1}` : "Jump host";
    // Inline hop: require the fields needed to open the connection. A saved
    // reference (connectionId) is validated elsewhere.
    if (!hop.connectionId) {
      if (!hop.host?.trim()) errors.push(`${label}: host is required.`);
      if (!hop.username?.trim()) errors.push(`${label}: username is required.`);
    }
  });

  if (hops.length > MAX_RECOMMENDED_HOPS) {
    warnings.push(`Chain has ${hops.length} hops. Deep chains may add connection latency.`);
  }

  return { errors, warnings };
}
