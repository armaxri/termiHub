/**
 * Tauri command wrappers for workflow operations (#1852).
 *
 * A thin layer over the `list/get/save/delete_workflow` Tauri commands, mirroring
 * {@link "@/services/macroApi"}.
 */

import { invoke } from "@tauri-apps/api/core";
import { Workflow } from "@/types/workflow";

/** List all stored workflows. */
export async function listWorkflows(): Promise<Workflow[]> {
  return await invoke<Workflow[]>("list_workflows");
}

/** Get a single workflow by ID. */
export async function getWorkflow(workflowId: string): Promise<Workflow> {
  return await invoke<Workflow>("get_workflow", { workflowId });
}

/** Save (add or update) a workflow. Returns the stored workflow with authoritative timestamps. */
export async function saveWorkflow(workflow: Workflow): Promise<Workflow> {
  return await invoke<Workflow>("save_workflow", { workflowDef: workflow });
}

/** Delete a workflow by ID. */
export async function deleteWorkflow(workflowId: string): Promise<void> {
  await invoke("delete_workflow", { workflowId });
}
