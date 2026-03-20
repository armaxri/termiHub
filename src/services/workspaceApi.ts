/**
 * Tauri command wrappers for workspace operations.
 */

import { invoke } from "@tauri-apps/api/core";
import { WorkspaceDefinition, WorkspaceImportPreview, WorkspaceSummary } from "@/types/workspace";

/** Get all workspace summaries for sidebar display. */
export async function getWorkspaces(): Promise<WorkspaceSummary[]> {
  return await invoke<WorkspaceSummary[]>("get_workspaces");
}

/** Load a full workspace definition by ID. */
export async function loadWorkspace(workspaceId: string): Promise<WorkspaceDefinition> {
  return await invoke<WorkspaceDefinition>("load_workspace", { workspaceId });
}

/** Save (add or update) a workspace definition. */
export async function saveWorkspace(definition: WorkspaceDefinition): Promise<void> {
  await invoke("save_workspace", { definition });
}

/** Delete a workspace by ID. */
export async function deleteWorkspace(workspaceId: string): Promise<void> {
  await invoke("delete_workspace", { workspaceId });
}

/** Duplicate a workspace by ID, returning the new workspace's ID. */
export async function duplicateWorkspace(workspaceId: string): Promise<string> {
  return await invoke<string>("duplicate_workspace", { workspaceId });
}

/** Check CLI arguments for a workspace to launch. Returns workspace name or null. */
export async function getCliWorkspace(): Promise<string | null> {
  return await invoke<string | null>("get_cli_workspace");
}

/** Export all workspaces as portable JSON (connection IDs replaced with names). */
export async function exportWorkspaces(): Promise<string> {
  return await invoke<string>("export_workspaces");
}

/** Import workspaces from portable JSON. Returns the number imported. */
export async function importWorkspaces(json: string): Promise<number> {
  return await invoke<number>("import_workspaces", { json });
}

/** Preview a workspace import file without importing. */
export async function previewImportWorkspaces(json: string): Promise<WorkspaceImportPreview> {
  return await invoke<WorkspaceImportPreview>("preview_import_workspaces", { json });
}
