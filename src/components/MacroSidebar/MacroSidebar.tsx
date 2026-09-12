import { useCallback, useMemo, useState } from "react";
import { Circle, Search } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, Input, toast, Tooltip } from "@/components/ui";
import { ConfirmDeleteDialog } from "@/components/Sidebar/ConfirmDeleteDialog";
import { SidebarToolbar } from "@/components/Sidebar/SidebarToolbar";
import { ExportImportButtons } from "@/components/Sidebar/ExportImportButtons";
import { useFlatRovingNav } from "@/hooks/useFlatRovingNav";
import { useListFilter, nameDescriptionTagsMatcher } from "@/hooks/useListFilter";
import { useJsonFileExport, useJsonFileImport } from "@/hooks/useJsonFile";
import { useDeleteConfirm } from "@/hooks/useDeleteConfirm";
import { serializeMacros } from "@/services/macroIo";
import type { Macro } from "@/types/macro";
import { MacroListItem } from "./MacroListItem";
import { MacroEditorDialog, type MacroEditorResult } from "./MacroEditorDialog";
import { newId } from "@/services/transport/ids";
import "./MacroSidebar.css";

/** Generate a unique macro id for a duplicated macro. */
function generateMacroId(): string {
  return newId("macro");
}

/** Turn a macro name into a filesystem-friendly slug for the default filename. */
function slugifyMacroName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "macro";
}

/**
 * The Macro Manager panel: browse, search, edit, delete and launch stored
 * macros. Macros are recorded from the terminal toolbar and played back into the
 * active terminal; this panel is their home for organisation. Composed from the
 * shared UI primitives and the sidebar list-item shell, mirroring the workspace
 * and tunnel managers. Macros can also be exported to / imported from portable
 * JSON files, so they can be shared between machines (#1677). The search,
 * export/import, and delete-confirm flows come from the shared sidebar hooks
 * (UISF-020).
 */
export function MacroSidebar() {
  const macros = useAppStore((s) => s.macros);
  const saveMacroToBackend = useAppStore((s) => s.saveMacroToBackend);
  const deleteMacroFromBackend = useAppStore((s) => s.deleteMacroFromBackend);
  const importMacros = useAppStore((s) => s.importMacros);
  const playMacro = useAppStore((s) => s.playMacro);
  const startMacroRecording = useAppStore((s) => s.startMacroRecording);

  const [editingId, setEditingId] = useState<string | null>(null);
  const { query, setQuery, filtered } = useListFilter(macros, nameDescriptionTagsMatcher);
  const exportMacrosToFile = useJsonFileExport("macros");
  const importMacrosFromFile = useJsonFileImport("macros");
  const macroDelete = useDeleteConfirm<{ id: string; name: string }>(async ({ id, name }) => {
    try {
      await deleteMacroFromBackend(id);
      toast.success(`Deleted macro "${name}"`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to delete macro: ${message}`);
    }
  });
  const requestDelete = macroDelete.request;

  const editingMacro = useMemo(
    () => macros.find((m) => m.id === editingId) ?? null,
    [macros, editingId]
  );

  const handleRecord = useCallback(() => {
    startMacroRecording();
  }, [startMacroRecording]);

  const handlePlay = useCallback(
    (macroId: string) => {
      void playMacro(macroId);
    },
    [playMacro]
  );

  const handleEdit = useCallback((macroId: string) => setEditingId(macroId), []);

  const handleDuplicate = useCallback(
    async (macroId: string) => {
      const original = macros.find((m) => m.id === macroId);
      if (!original) return;
      const duplicate: Macro = {
        ...original,
        id: generateMacroId(),
        name: `Copy of ${original.name}`,
        steps: original.steps.map((s) => ({ ...s })),
        // The backend stamps authoritative created/updated timestamps.
        createdAt: "",
        updatedAt: "",
      };
      try {
        await saveMacroToBackend(duplicate);
        toast.success(`Duplicated "${original.name}"`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`Failed to duplicate "${original.name}"`, { description: message });
      }
    },
    [macros, saveMacroToBackend]
  );

  const handleExportAll = useCallback(() => {
    void exportMacrosToFile({
      defaultPath: "termihub-macros.json",
      content: () => serializeMacros(macros),
      successMessage: `Exported ${macros.length} macro${macros.length === 1 ? "" : "s"}`,
    });
  }, [macros, exportMacrosToFile]);

  const handleExportOne = useCallback(
    (macroId: string) => {
      const macro = macros.find((m) => m.id === macroId);
      if (!macro) return;
      void exportMacrosToFile({
        defaultPath: `termihub-macro-${slugifyMacroName(macro.name)}.json`,
        content: () => serializeMacros([macro]),
        successMessage: `Exported "${macro.name}"`,
      });
    },
    [macros, exportMacrosToFile]
  );

  const handleImport = useCallback(() => {
    void importMacrosFromFile(async (json) => {
      const count = await importMacros(json);
      toast.success(`Imported ${count} macro${count === 1 ? "" : "s"}`);
    });
  }, [importMacros, importMacrosFromFile]);

  const handleDelete = useCallback(
    (macroId: string) => {
      const macro = macros.find((m) => m.id === macroId);
      if (!macro) return;
      requestDelete({ id: macro.id, name: macro.name });
    },
    [macros, requestDelete]
  );

  const handleSaveEdit = useCallback(
    async (result: MacroEditorResult) => {
      if (!editingMacro) return;
      const updated: Macro = {
        ...editingMacro,
        name: result.name,
        description: result.description,
        tags: result.tags,
        steps: result.steps,
      };
      try {
        await saveMacroToBackend(updated);
        setEditingId(null);
        toast.success(`Saved macro "${result.name}"`);
      } catch (err) {
        // Keep the dialog open so the edits are not lost on a failed save.
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`Failed to save macro: ${message}`);
        throw err;
      }
    },
    [editingMacro, saveMacroToBackend]
  );

  // Roving-tabindex keyboard navigation over the filtered list, matching the
  // other management sidebars. Enter plays the focused macro.
  const handleActivate = useCallback((macro: Macro) => handlePlay(macro.id), [handlePlay]);
  const nav = useFlatRovingNav<Macro, HTMLDivElement>(
    filtered,
    (macro) => macro.name,
    handleActivate
  );

  return (
    <div className="macro-sidebar" data-testid="macro-sidebar">
      <SidebarToolbar>
        <Tooltip content="Record New Macro" side="top">
          <Button
            variant="ghost"
            size="sm"
            icon={<Circle size={12} />}
            onClick={handleRecord}
            aria-label="Record New Macro"
            data-testid="macro-record-btn"
          >
            Record New
          </Button>
        </Tooltip>
        <ExportImportButtons
          onExport={handleExportAll}
          onImport={handleImport}
          exportLabel="Export All Macros"
          importLabel="Import Macros"
          exportDisabled={macros.length === 0}
          exportTestId="macro-export-all-btn"
          importTestId="macro-import-btn"
        />
      </SidebarToolbar>
      <div className="macro-sidebar__search">
        <Search size={14} className="macro-sidebar__search-icon" aria-hidden="true" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search macros"
          aria-label="Search macros"
          data-testid="macro-search"
        />
      </div>
      {macros.length === 0 ? (
        <div className="macro-sidebar__empty" data-testid="macro-empty-message">
          <span>No macros recorded yet.</span>
          <span>
            Record one with the terminal toolbar&apos;s record button, or{" "}
            <button className="macro-sidebar__empty-link" onClick={handleRecord} type="button">
              start recording now
            </button>
            .
          </span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="macro-sidebar__empty" data-testid="macro-no-results">
          <span>No macros match &quot;{query}&quot;.</span>
        </div>
      ) : (
        <div
          className="macro-sidebar__list"
          data-testid="macro-list"
          role="tree"
          aria-label="Macros"
          onKeyDown={nav.onKeyDown}
        >
          {filtered.map((macro, index) => {
            const { ref, ...itemProps } = nav.getItemProps(index);
            return (
              <MacroListItem
                key={macro.id}
                macro={macro}
                onPlay={handlePlay}
                onEdit={handleEdit}
                onDuplicate={handleDuplicate}
                onExport={handleExportOne}
                onDelete={handleDelete}
                rowRef={ref}
                rowProps={itemProps}
              />
            );
          })}
        </div>
      )}
      <MacroEditorDialog
        open={editingMacro !== null}
        macro={editingMacro}
        onOpenChange={(open) => {
          if (!open) setEditingId(null);
        }}
        onSave={handleSaveEdit}
      />
      <ConfirmDeleteDialog
        {...macroDelete.dialogProps}
        message={
          macroDelete.pending
            ? `Delete macro "${macroDelete.pending.name}"? This cannot be undone.`
            : ""
        }
      />
    </div>
  );
}
