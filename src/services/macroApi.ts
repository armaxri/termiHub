/**
 * Tauri command wrappers for macro operations.
 */

import { invoke } from "@tauri-apps/api/core";
import { Macro } from "@/types/macro";

/** List all stored macros. */
export async function listMacros(): Promise<Macro[]> {
  return await invoke<Macro[]>("list_macros");
}

/** Get a single macro by ID. */
export async function getMacro(macroId: string): Promise<Macro> {
  return await invoke<Macro>("get_macro", { macroId });
}

/** Save (add or update) a macro. Returns the stored macro with authoritative timestamps. */
export async function saveMacro(macro: Macro): Promise<Macro> {
  return await invoke<Macro>("save_macro", { macroDef: macro });
}

/** Delete a macro by ID. */
export async function deleteMacro(macroId: string): Promise<void> {
  await invoke("delete_macro", { macroId });
}
