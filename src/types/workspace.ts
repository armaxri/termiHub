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

/** A tab group entry within a multi-group workspace. */
export interface WorkspaceTabGroupDef {
  name: string;
  color?: string;
  layout: WorkspaceLayoutNode;
}

/** A complete workspace definition. */
export interface WorkspaceDefinition {
  id: string;
  name: string;
  description?: string;
  /** Single-layout field, kept for backward compatibility. */
  layout?: WorkspaceLayoutNode;
  /** Multi-group layout (overrides `layout` when present). */
  tabGroups?: WorkspaceTabGroupDef[];
}

/** Summary of a workspace for list display. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  description?: string;
  connectionCount: number;
}

/** Preview of a workspace import file. */
export interface WorkspaceImportPreview {
  workspaceCount: number;
  totalTabCount: number;
}
