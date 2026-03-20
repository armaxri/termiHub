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
}

/** Recursive layout tree for a workspace. */
export type WorkspaceLayoutNode = WorkspaceLeafNode | WorkspaceSplitNode;

/** A complete workspace definition. */
export interface WorkspaceDefinition {
  id: string;
  name: string;
  description?: string;
  layout: WorkspaceLayoutNode;
}

/** Summary of a workspace for list display. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  description?: string;
  connectionCount: number;
}
