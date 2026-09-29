// Workspace DTOs generated from their Rust source of truth
// (`src-tauri/src/workspace/{config,settings}.rs`) via ts-rs (audit DUP-030 /
// MOCK-005, #3088). The on-disk `workspaces.json` shape is owned by the Rust
// structs; these re-exports keep the frontend on the same contract.
import type { WorkspaceLayoutNode } from "./generated/WorkspaceLayoutNode";

/** A tab definition within a workspace leaf panel. */
export type { WorkspaceTabDef } from "./generated/WorkspaceTabDef";

/** Recursive layout tree for a workspace (a leaf panel or a split container). */
export type { WorkspaceLayoutNode };

/** A leaf panel containing one or more tabs. */
export type WorkspaceLeafNode = Extract<WorkspaceLayoutNode, { type: "leaf" }>;

/** A split container with child panels. */
export type WorkspaceSplitNode = Extract<WorkspaceLayoutNode, { type: "split" }>;

/**
 * Definition of a single tab group within a workspace. `windowId` references a
 * {@link WorkspaceWindowDef.id} (multi-window persistence, #1905); absent for
 * the primary window and legacy single-window saves.
 */
export type { WorkspaceTabGroupDef } from "./generated/WorkspaceTabGroupDef";

/**
 * A native window recorded in a saved layout (multi-window persistence, #1905),
 * identified by a logical id (`"main"` for the primary window). Recorded
 * explicitly so an empty window still survives a save/restore round trip.
 */
export type { WorkspaceWindowDef } from "./generated/WorkspaceWindowDef";

/** One extra environment variable for new local sessions of a workspace (PROD-052). */
export type { WorkspaceEnvVar } from "./generated/WorkspaceEnvVar";

/**
 * Per-workspace settings overrides (PROD-052). Every field is optional; an
 * absent field inherits the global setting. Precedence is
 * `global < workspace < connection`.
 */
export type { WorkspaceSettings } from "./generated/WorkspaceSettings";

/** A complete workspace definition. */
export type { WorkspaceDefinition } from "./generated/WorkspaceDefinition";

/** The active workspace as broadcast by the backend (`active-workspace-changed`). */
export type { ActiveWorkspaceInfo } from "./generated/ActiveWorkspaceInfo";

/** Summary of a workspace for list display. */
export type { WorkspaceSummary } from "./generated/WorkspaceSummary";

/** Preview of a workspace import file. */
export type { WorkspaceImportPreview } from "./generated/WorkspaceImportPreview";

/**
 * Outcome of exporting workspaces as portable JSON, plus non-fatal warnings
 * (e.g. a tab bound to a connection id several connection files hold).
 */
export type { WorkspaceExportResult } from "./generated/WorkspaceExportResult";

/**
 * Outcome of importing workspaces from portable JSON, plus non-fatal warnings
 * (most notably dangling connection references).
 */
export type { WorkspaceImportResult } from "./generated/WorkspaceImportResult";
