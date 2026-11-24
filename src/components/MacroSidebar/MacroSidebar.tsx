import { useCallback, useMemo, useState } from "react";
import { CircleDot, Plus } from "lucide-react";
import { getActiveTab, useAppStore } from "@/store/appStore";
import { SearchInput, toast, EmptyState } from "@/components/ui";
import { ConfirmDeleteDialog } from "@/components/Sidebar/ConfirmDeleteDialog";
import { SidebarToolbar } from "@/components/Sidebar/SidebarToolbar";
import { exportImportActions } from "@/components/Sidebar/ExportImportButtons";
import { useFlatRovingNav } from "@/hooks/useFlatRovingNav";
import { useListFilter, nameDescriptionTagsFields } from "@/hooks/useListFilter";
import { useJsonFileExport, useJsonFileImport } from "@/hooks/useJsonFile";
import { useDeleteConfirm } from "@/hooks/useDeleteConfirm";
import { serializeMacros } from "@/services/macroIo";
import type { Macro } from "@/types/macro";
import { MacroListItem } from "./MacroListItem";
import { HistorySection } from "@/components/AutomationSidebar";
import { latestMacroRuns } from "./macroRunFormat";
import { MacroEditorDialog, type MacroEditorResult } from "./MacroEditorDialog";
import { RunTargetsDialog } from "@/components/Automations/RunTargetsDialog";
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
  const openScheduleEditor = useAppStore((s) => s.openScheduleEditor);
  const handleSchedule = useCallback(
    (macroId: string) => openScheduleEditor({ action: { kind: "macro", macroId } }),
    [openScheduleEditor]
  );
  const startMacroRecording = useAppStore((s) => s.startMacroRecording);
  // Where Play types (R-113, #5680): the active terminal tab's title.
  const playTarget = useAppStore((s) => {
    const tab = getActiveTab(s);
    return tab?.contentType === "terminal" ? tab.title || "Terminal" : null;
  });
  const macroRuns = useAppStore((s) => s.macroRuns);
  const lastRuns = useMemo(() => latestMacroRuns(macroRuns), [macroRuns]);

  const [editingId, setEditingId] = useState<string | null>(null);
  // The automation the one history panel is narrowed to (#5818); null = every run.
  const [historyMacroId, setHistoryMacroId] = useState<string | null>(null);
  // Authoring a brand-new macro by hand (PROD-039): opens the editor blank.
  const [creating, setCreating] = useState(false);
  const { query, setQuery, filtered } = useListFilter(macros, nameDescriptionTagsFields);
  const exportMacrosToFile = useJsonFileExport("macros");
  const importMacrosFromFile = useJsonFileImport("macros");
  const macroDelete = useDeleteConfirm<{ id: string; name: string }>(async ({ id }) => {
    try {
      await deleteMacroFromBackend(id);
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

  // "Run on…" (#5818, slice 5): the run picker for one macro.
  const [runOnId, setRunOnId] = useState<string | null>(null);
  const runOnItems = useMemo(() => {
    const macro = macros.find((m) => m.id === runOnId);
    return macro ? [{ id: macro.id, name: macro.name, stepCount: macro.steps.length }] : [];
  }, [macros, runOnId]);

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
      // The imported rows show in the list (#5859).
      await importMacros(json);
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
      <SidebarToolbar
        align="center"
        aria-label="Macro actions"
        overflowLabel="More macro actions"
        overflowTestId="macro-toolbar-overflow"
        actions={[
          {
            id: "new",
            label: "New macro",
            shortLabel: "New",
            tooltip: "New macro (author by hand)",
            icon: <Plus size={12} />,
            onClick: handleNew,
            primary: true,
            testId: "macro-new-btn",
          },
          {
            id: "record",
            // A filled record dot, icon-only like the other secondaries, so the
            // toolbar matches the Workflows one: text primary, icon secondaries
            // with tooltips (R-079, #5680).
            label: "Record new macro",
            icon: <CircleDot size={14} />,
            iconOnly: true,
            onClick: handleRecord,
            testId: "macro-record-btn",
          },
          ...exportImportActions({
            onExport: handleExportAll,
            onImport: handleImport,
            exportLabel: "Export all macros",
            importLabel: "Import macros",
            exportDisabled: macros.length === 0,
            exportTestId: "macro-export-all-btn",
            importTestId: "macro-import-btn",
          }),
        ]}
      />
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
        <EmptyState
          title="No macros recorded yet."
          description={
            <>
              Record one with the terminal toolbar&apos;s record button,{" "}
              <button className="ui-empty__link" onClick={handleRecord} type="button">
                start recording now
              </button>
              , or{" "}
              <button
                className="ui-empty__link"
                onClick={handleNew}
                type="button"
                data-testid="macro-empty-new-link"
              >
                write one by hand
              </button>
              .
            </>
          }
          data-testid="macro-empty-message"
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={<>No macros match &quot;{query}&quot;.</>}
          data-testid="macro-no-results"
        />
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
                onRunOn={setRunOnId}
                onEdit={handleEdit}
                onSchedule={handleSchedule}
                onShowHistory={setHistoryMacroId}
                onDuplicate={handleDuplicate}
                onExport={handleExportOne}
                onDelete={handleDelete}
                playTarget={playTarget}
                lastRun={lastRuns.get(macro.id)}
                rowRef={ref}
                rowProps={itemProps}
              />
            );
          })}
        </div>
      )}
      <HistorySection automationId={historyMacroId} onFilterChange={setHistoryMacroId} />
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
      <RunTargetsDialog
        open={runOnId !== null}
        automations={runOnItems}
        emptyText="This macro no longer exists."
        onOpenChange={(open) => {
          if (!open) setRunOnId(null);
        }}
        onRun={(macroId, targetTabIds, { parallel }) =>
          void playMacro(macroId, { targetTabIds, parallel })
        }
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
