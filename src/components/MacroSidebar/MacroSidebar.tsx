import { useCallback, useMemo, useState } from "react";
import { Circle, Plus } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, SearchInput, toast, Tooltip } from "@/components/ui";
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
import { slugify } from "@/utils/slugify";
import "./MacroSidebar.css";
import { errorMessage } from "@/utils/errorMessage";

/** Generate a unique macro id for a duplicated macro. */
function generateMacroId(): string {
  return newId("macro");
}

/**
 * The Macro Manager panel: browse, search, create, edit, delete and launch
 * stored macros. Macros are recorded from the terminal toolbar or authored by
 * hand here ("New", PROD-039) and played back into the active terminal; this panel is their home for organisation. Composed from the
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
  // Authoring a brand-new macro by hand (PROD-039): opens the editor blank.
  const [creating, setCreating] = useState(false);
  const { query, setQuery, filtered } = useListFilter(macros, nameDescriptionTagsMatcher);
  const exportMacrosToFile = useJsonFileExport("macros");
  const importMacrosFromFile = useJsonFileImport("macros");
  const macroDelete = useDeleteConfirm<{ id: string; name: string }>(async ({ id, name }) => {
    try {
      await deleteMacroFromBackend(id);
      toast.success(`Deleted macro "${name}"`);
    } catch (err) {
      const message = errorMessage(err);
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

  const handleEdit = useCallback((macroId: string) => {
    setCreating(false);
    setEditingId(macroId);
  }, []);

  const handleNew = useCallback(() => {
    setEditingId(null);
    setCreating(true);
  }, []);

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
        const message = errorMessage(err);
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
        defaultPath: `termihub-macro-${slugify(macro.name, "macro")}.json`,
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

  const handleSaveNew = useCallback(
    async (result: MacroEditorResult) => {
      const created: Macro = {
        id: generateMacroId(),
        name: result.name,
        description: result.description,
        tags: result.tags,
        steps: result.steps,
        // The backend stamps authoritative created/updated timestamps.
        createdAt: "",
        updatedAt: "",
      };
      try {
        await saveMacroToBackend(created);
        setCreating(false);
        toast.success(`Created macro "${result.name}"`);
      } catch (err) {
        // Keep the dialog open so the authored steps are not lost.
        const message = errorMessage(err);
        toast.error(`Failed to create macro: ${message}`);
        throw err;
      }
    },
    [saveMacroToBackend]
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
        const message = errorMessage(err);
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
        <Tooltip content="New Macro (author by hand)" side="top">
          <Button
            variant="ghost"
            size="sm"
            icon={<Plus size={12} />}
            onClick={handleNew}
            aria-label="New Macro"
            data-testid="macro-new-btn"
          >
            New
          </Button>
        </Tooltip>
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
        <SearchInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search macros"
          aria-label="Search macros"
          clearLabel="Clear macro search"
          data-testid="macro-search"
        />
      </div>
      {macros.length === 0 ? (
        <div className="macro-sidebar__empty" data-testid="macro-empty-message">
          <span>No macros recorded yet.</span>
          <span>
            Record one with the terminal toolbar&apos;s record button,{" "}
            <button className="macro-sidebar__empty-link" onClick={handleRecord} type="button">
              start recording now
            </button>
            , or{" "}
            <button
              className="macro-sidebar__empty-link"
              onClick={handleNew}
              type="button"
              data-testid="macro-empty-new-link"
            >
              write one by hand
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
        open={creating || editingMacro !== null}
        macro={creating ? null : editingMacro}
        onOpenChange={(open) => {
          if (!open) {
            setEditingId(null);
            setCreating(false);
          }
        }}
        onSave={creating ? handleSaveNew : handleSaveEdit}
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
