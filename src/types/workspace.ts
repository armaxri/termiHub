/** A tab definition within a workspace leaf panel. */
export interface WorkspaceTabDef {
  /** Reference to a saved connection by ID. */
  connectionRef?: string;
  /** Inline connection config as fallback when no saved connection is referenced. */
  inlineConfig?: { type: string; config: Record<string, unknown> };
  /** Reference to a remote agent definition (agentId + definitionId on that agent). */
  agentRef?: { agentId: string; definitionId: string };
  /** Optional title override for the tab. */
  title?: string;
  /** Optional command to run after the session connects. */
  initialCommand?: string;
}

/** A leaf panel containing one or more tabs. */
export interface WorkspaceLeafNode {
  type: "leaf";
  tabs: WorkspaceTabDef[];
}

/** A split container with child panels. */
export interface WorkspaceSplitNode {
  type: "split";
  direction: "horizontal" | "vertical";
  children: WorkspaceLayoutNode[];
  /** Optional percentage sizes for each child (must sum to 100, length must match children). */
  sizes?: number[];
}

/** Recursive layout tree for a workspace. */
export type WorkspaceLayoutNode = WorkspaceLeafNode | WorkspaceSplitNode;

/** Definition of a single tab group within a workspace. */
export interface WorkspaceTabGroupDef {
  /** Display name for this tab group. */
  name: string;
  /** Optional accent dot color. */
  color?: string;
  /** The panel layout tree for this group. */
  layout: WorkspaceLayoutNode;
  /**
   * Logical id of the native window this group belongs to (multi-window
   * persistence, #1905), referencing a {@link WorkspaceWindowDef.id}. Omitted
   * for the primary window and for legacy single-window saves — an absent value
   * restores into the main window (see `MAIN_WINDOW_LABEL`).
   */
  windowId?: string;
}

/**
 * A native window recorded in a saved layout (multi-window persistence, #1905).
 *
 * Windows are identified by a **logical** id referenced from
 * {@link WorkspaceTabGroupDef.windowId}; the primary window uses the
 * `MAIN_WINDOW_LABEL` sentinel (`"main"`). The id is a grouping key, not a
 * runtime window label — restore recreates the secondary windows and maps each
 * logical id onto a freshly allocated `win-N`. Recorded explicitly (rather than
 * inferred from the groups) so that an **empty** window — one holding zero tab
 * groups, the #1902 empty-window state — still survives a save/restore round
 * trip. Legacy single-window saves omit the window dimension entirely.
 */
export interface WorkspaceWindowDef {
  /** Logical window id referenced by tab groups. `"main"` is the primary window. */
  id: string;
}

/** One extra environment variable for new local sessions of a workspace (PROD-052). */
export interface WorkspaceEnvVar {
  /** Variable name (`[A-Za-z_][A-Za-z0-9_]*`). */
  key: string;
  /** Variable value — never meant for secrets. */
  value: string;
}

/**
 * Per-workspace settings overrides (PROD-052). Every field is optional; an
 * absent field inherits the global setting. Precedence is
 * `global < workspace < connection`.
 */
export interface WorkspaceSettings {
  /** Theme override (same value space as `AppSettings.theme`). */
  theme?: string;
  /** Terminal font family override. */
  fontFamily?: string;
  /** Terminal font size override in pixels (8–32). */
  fontSize?: number;
  /** Default working directory for new local shells that do not set their own. */
  defaultWorkingDirectory?: string;
  /** Extra environment variables for new local shells (connection entries win). */
  envVars?: WorkspaceEnvVar[];
}

/** A complete workspace definition. */
export interface WorkspaceDefinition {
  id: string;
  name: string;
  description?: string;
  /** The tab groups in this workspace (always at least one). */
  tabGroups: WorkspaceTabGroupDef[];
  /**
   * The set of windows this layout spans, in restore order (multi-window
   * persistence, #1905). Absent/empty on legacy single-window saves, which
   * restore entirely into the main window.
   */
  windows?: WorkspaceWindowDef[];
  /** Per-workspace settings overrides (PROD-052); absent → inherit every global setting. */
  settings?: WorkspaceSettings;
}

/** The active workspace as broadcast by the backend (`active-workspace-changed`). */
export interface ActiveWorkspaceInfo {
  id: string;
  name: string;
  /** The workspace's overrides; absent → it inherits every global setting. */
  settings?: WorkspaceSettings;
}

/** Summary of a workspace for list display. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  description?: string;
  connectionCount: number;
  /** Number of tab groups; omitted when workspace has only one group. */
  groupCount?: number;
}

/** Preview of a workspace import file. */
export interface WorkspaceImportPreview {
  workspaceCount: number;
  totalTabCount: number;
}

/**
 * Outcome of importing workspaces from portable JSON.
 *
 * Carries the number of workspaces imported plus any non-fatal warnings raised
 * during the import — most notably dangling connection references, where an
 * imported tab points at a connection that no longer exists. The tab is kept
 * regardless; the warning lets the UI tell the user the workspace is partially
 * broken instead of failing silently.
 */
export interface WorkspaceImportResult {
  /** Number of workspaces added to the store (duplicates by name are skipped). */
  importedCount: number;
  /** Human-readable, non-blocking warnings raised during the import. */
  warnings: string[];
}
