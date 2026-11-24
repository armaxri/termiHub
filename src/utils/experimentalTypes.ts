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

/**
 * Badge text marking an experimental connection type in the type picker (#5873,
 * R-166). A neutral "Preview" rather than "— Experimental": the old suffix read
 * as part of the protocol's name and did not say what was experimental.
 */
export const PREVIEW_BADGE_LABEL = "Preview";

/**
 * Known limits of a preview type, by type ID (#5873). Shown in the one-line note
 * under the type picker; a type without an entry gets the generic note only.
 * VNC has no audio channel (PROD-020, `docs/architecture.md`).
 */
const PREVIEW_TYPE_LIMITS: Readonly<Record<string, string>> = {
  vnc: "VNC has no audio.",
};

/**
 * The one-line note shown under the type picker while a preview type is
 * selected: that it is still being tested, plus its known limits.
 */
export function previewTypeNote(typeId: string): string {
  const base = "Preview: still being tested, and may change between versions.";
  const limits = PREVIEW_TYPE_LIMITS[typeId];
  return limits ? `${base} ${limits}` : base;
}

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
 * entirely. When it is on, they are kept and flagged `preview`, so the picker
 * shows a {@link PREVIEW_BADGE_LABEL} badge beside the plain name. A `keepTypeId` (the currently-selected value) is always
 * retained so an in-progress edit never loses its selection.
 */
export function buildGatedTypeOptions(
  types: ConnectionTypeInfo[],
  experimental: boolean,
  keepTypeId?: string
): { value: string; label: string; preview: boolean }[] {
  return types
    .filter((ct) => experimental || !isExperimentalConnectionType(ct) || ct.typeId === keepTypeId)
    .map((ct) => ({
      value: ct.typeId,
      label: ct.displayName,
      preview: isExperimentalConnectionType(ct),
    }));
}

/**
 * Keyboard-shortcut categories that only apply to experimental connection types
 * (#5365). While experimental features are off, the shortcut lists hide these
 * groups; the bindings and any user overrides stay registered and stored.
 */
const EXPERIMENTAL_SHORTCUT_CATEGORIES: ReadonlySet<string> = new Set(["remote-desktop"]);

/** Whether a shortcut category is listed under the current experimental gate. */
export function isShortcutCategoryVisible(category: string, experimental: boolean): boolean {
  return experimental || !EXPERIMENTAL_SHORTCUT_CATEGORIES.has(category);
}
