import type { ConnectionTypeInfo } from "@/types/connection";

/**
 * Experimental connection-type gating (#1705).
 *
 * The graphical remote-desktop feature (shared layer #1680, plus the VNC #1681
 * and RDP #1682 backends) ships **experimental** — hidden by default and only
 * reachable when the existing `experimentalFeaturesEnabled` setting is on. It
 * reuses that setting rather than inventing a new toggle.
 *
 * A connection type is experimental when it reports `capabilities.graphical`.
 * That is protocol-agnostic on purpose: the mock backend and both real
 * backends all set `graphical: true`, so each is gated automatically without
 * hard-coding `vnc` / `rdp` / `mock-remote-desktop` type IDs here.
 */

/** Label suffix marking an experimental type in a picker (mirrors `ActivityBar`). */
export const EXPERIMENTAL_TYPE_SUFFIX = " — Experimental";

/** Whether a connection type is experimental (a graphical remote-desktop type). */
export function isExperimentalConnectionType(info: {
  capabilities: { graphical?: boolean };
}): boolean {
  return info.capabilities.graphical === true;
}

/** The set of experimental type IDs present in a registry. */
export function experimentalTypeIds(types: ConnectionTypeInfo[]): Set<string> {
  return new Set(types.filter(isExperimentalConnectionType).map((t) => t.typeId));
}

/**
 * Build the connection-type picker options, applying experimental gating.
 *
 * When `experimental` is off, experimental (graphical) types are omitted
 * entirely. When it is on, they are kept and their label is suffixed with
 * "— Experimental". A `keepTypeId` (the currently-selected value) is always
 * retained so an in-progress edit never loses its selection.
 */
export function buildGatedTypeOptions(
  types: ConnectionTypeInfo[],
  experimental: boolean,
  keepTypeId?: string
): { value: string; label: string }[] {
  return types
    .filter((ct) => experimental || !isExperimentalConnectionType(ct) || ct.typeId === keepTypeId)
    .map((ct) => ({
      value: ct.typeId,
      label: isExperimentalConnectionType(ct)
        ? ct.displayName + EXPERIMENTAL_TYPE_SUFFIX
        : ct.displayName,
    }));
}
