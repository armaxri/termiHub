/** A tab definition within a workspace leaf panel. */
export interface WorkspaceTabDef {
  /** Reference to a saved connection by ID (preferred). */
  connectionRef?: string;
  /** Inline connection config as fallback when no saved connection is referenced. */
  inlineConfig?: { type: string; config: Record<string, unknown> };
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
}

/** A complete workspace definition. */
export interface WorkspaceDefinition {
  id: string;
  name: string;
  description?: string;
  /** The tab groups in this workspace (always at least one). */
  tabGroups: WorkspaceTabGroupDef[];
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
