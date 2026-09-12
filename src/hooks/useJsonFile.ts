import { useCallback } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { toast } from "@/components/ui";

/** The single `*.json` filter every flat-sidebar file dialog uses. */
const JSON_FILTERS = [{ name: "JSON", extensions: ["json"] }];

/** Turn an unknown thrown value into a human-readable message for a toast. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Options for a single export invocation returned by {@link useJsonFileExport}. */
export interface JsonFileExportOptions {
  /** Suggested filename for the native save dialog (e.g. `termihub-macros.json`). */
  defaultPath: string;
  /**
   * The JSON text to write, or a (possibly async) factory that produces it. A
   * factory lets callers defer serialization / a backend round-trip until the
   * export actually runs, and keeps any error it throws inside the shared
   * try/catch so it surfaces the standard "Failed to export …" toast.
   */
  content: string | (() => string | Promise<string>);
  /** Success toast shown after the file is written (caller-specific wording). */
  successMessage: string;
}

/**
 * The shared "export entities to a user-chosen JSON file" flow: open the native
 * save dialog, write the content, and toast success — or, on failure, a
 * `Failed to export <entityLabel>: <message>` error toast. A cancelled dialog
 * returns before any write and is a silent no-op (no toast), matching the
 * previous inline `writeMacrosToFile` / `writeWorkflowsToFile` /
 * `WorkspaceSidebar.handleExport` implementations (UISF-020).
 *
 * @param entityLabel Plural entity noun for the error toast (e.g. `"macros"`).
 */
export function useJsonFileExport(
  entityLabel: string
): (options: JsonFileExportOptions) => Promise<void> {
  return useCallback(
    async ({ defaultPath, content, successMessage }: JsonFileExportOptions): Promise<void> => {
      try {
        const text = typeof content === "function" ? await content() : content;
        const filePath = await save({ defaultPath, filters: JSON_FILTERS });
        if (!filePath) return;
        await writeTextFile(filePath, text);
        toast.success(successMessage);
      } catch (err) {
        toast.error(`Failed to export ${entityLabel}: ${messageOf(err)}`);
      }
    },
    [entityLabel]
  );
}

/**
 * The shared "import entities from a user-chosen JSON file" flow: open the native
 * open dialog, read the file, and hand its text to `onParsed`. A cancelled dialog
 * returns before any read and is a silent no-op. Any error thrown while reading
 * or inside `onParsed` surfaces a `Failed to import <entityLabel>: <message>`
 * error toast.
 *
 * The success feedback lives in `onParsed` (not this hook) because it diverges
 * per entity — a plain count toast for macros, a security-surfacing toast for
 * workflows carrying local-process steps, a reload-then-count for workspaces
 * (UISF-020). The parse/count/toast therefore stays caller-owned; only the
 * dialog + read + error handling are shared.
 *
 * @param entityLabel Plural entity noun for the error toast (e.g. `"macros"`).
 */
export function useJsonFileImport(
  entityLabel: string
): (onParsed: (json: string) => void | Promise<void>) => Promise<void> {
  return useCallback(
    async (onParsed: (json: string) => void | Promise<void>): Promise<void> => {
      const filePath = await open({ multiple: false, filters: JSON_FILTERS });
      if (!filePath || Array.isArray(filePath)) return;
      try {
        const json = await readTextFile(filePath);
        await onParsed(json);
      } catch (err) {
        toast.error(`Failed to import ${entityLabel}: ${messageOf(err)}`);
      }
    },
    [entityLabel]
  );
}
