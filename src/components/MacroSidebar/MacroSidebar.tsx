import { useCallback, useMemo, useState } from "react";
import { Circle, Search } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, Input, toast, Tooltip } from "@/components/ui";
import { ConfirmDeleteDialog } from "@/components/Sidebar/ConfirmDeleteDialog";
import { useFlatRovingNav } from "@/hooks/useFlatRovingNav";
import type { Macro } from "@/types/macro";
import { MacroListItem } from "./MacroListItem";
import { MacroEditorDialog, type MacroEditorResult } from "./MacroEditorDialog";
import "./MacroSidebar.css";

/** Generate a unique macro id for a duplicated macro. */
function generateMacroId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    return `macro-${c.randomUUID()}`;
  }
  return `macro-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** True when the macro matches the (already lower-cased) query across name/description/tags. */
function macroMatches(macro: Macro, query: string): boolean {
  if (!query) return true;
  if (macro.name.toLowerCase().includes(query)) return true;
  if (macro.description?.toLowerCase().includes(query)) return true;
  return macro.tags.some((tag) => tag.toLowerCase().includes(query));
}

/**
 * The Macro Manager panel: browse, search, edit, delete and launch stored
 * macros. Macros are recorded from the terminal toolbar and played back into the
 * active terminal; this panel is their home for organisation. Composed from the
 * shared UI primitives and the sidebar list-item shell, mirroring the workspace
 * and tunnel managers. Import/export is intentionally out of scope here (#1677).
 */
export function MacroSidebar() {
  const macros = useAppStore((s) => s.macros);
  const saveMacroToBackend = useAppStore((s) => s.saveMacroToBackend);
  const deleteMacroFromBackend = useAppStore((s) => s.deleteMacroFromBackend);
  const playMacro = useAppStore((s) => s.playMacro);
  const startMacroRecording = useAppStore((s) => s.startMacroRecording);

  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return macros.filter((m) => macroMatches(m, q));
  }, [macros, query]);

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

  const handleDelete = useCallback(
    (macroId: string) => {
      const macro = macros.find((m) => m.id === macroId);
      if (!macro) return;
      setPendingDelete({ id: macro.id, name: macro.name });
    },
    [macros]
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const { id, name } = pendingDelete;
    setPendingDelete(null);
    try {
      await deleteMacroFromBackend(id);
      toast.success(`Deleted macro "${name}"`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to delete macro: ${message}`);
    }
  }, [pendingDelete, deleteMacroFromBackend]);

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
      <div className="macro-sidebar__actions">
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
      </div>
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
        open={pendingDelete !== null}
        message={
          pendingDelete ? `Delete macro "${pendingDelete.name}"? This cannot be undone.` : ""
        }
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
