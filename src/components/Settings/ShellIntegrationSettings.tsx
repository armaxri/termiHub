import { useCallback, useEffect, useMemo, useState } from "react";
import { GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { DndContext, DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAppStore } from "@/store/appStore";
import { frontendLog } from "@/utils/frontendLog";
import { getPlatform } from "@/utils/platform";
import type {
  DetectedFileManager,
  ShellEntry,
  ShellIntegrationSettings as ShellIntegrationSettingsType,
  ShellIntegrationStatus,
} from "@/types/connection";
import { Button, Field, Select, Toggle, Tooltip, toast } from "@/components/ui";
import {
  getShellIntegrationStatus,
  installShellIntegration,
  saveShellIntegrationSettings,
  uninstallShellIntegration,
} from "@/services/api";
import {
  addEntry,
  createEntry,
  defaultShellIntegrationSettings,
  removeEntry,
  reorderEntries,
  updateEntry,
} from "./shellIntegrationEntries";
import { ShellIntegrationEntryEditor } from "./ShellIntegrationEntryEditor";
import "./ShellIntegrationSettings.css";

/** The searchable setting ids owned by this section (see settingsRegistry). */
const OWNED_FIELD_IDS = [
  "shellIntegrationRegistration",
  "shellIntegrationEntries",
  "shellIntegrationFallback",
  "shellIntegrationLinux",
];

/** The Linux file managers rendered as install toggles, with their detection id. */
const LINUX_MANAGERS: {
  key: keyof ShellIntegrationSettingsType["linuxFileManagers"];
  id: string;
  label: string;
}[] = [
  { key: "nautilus", id: "nautilus", label: "Install Nautilus scripts" },
  { key: "kde", id: "kde", label: "Install KDE service menu" },
  { key: "thunar", id: "thunar", label: "Install Thunar custom action" },
];

interface ShellIntegrationSettingsProps {
  /** When search is active, only render if one of the owned fields matches. */
  visibleFields?: Set<string>;
}

/**
 * Settings section for the shell context-menu integration: registration status
 * with Reinstall / Uninstall actions, a draggable Quick-Access entry list, the
 * no-match fallback, the new-window behaviour, and Linux per-file-manager
 * install toggles.
 */
export function ShellIntegrationSettings({ visibleFields }: ShellIntegrationSettingsProps) {
  const settings = useAppStore((s) => s.settings);
  const connections = useAppStore((s) => s.connections);

  const si = useMemo<ShellIntegrationSettingsType>(
    () => settings.shellIntegration ?? defaultShellIntegrationSettings(),
    [settings.shellIntegration]
  );

  const [status, setStatus] = useState<ShellIntegrationStatus | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<ShellEntry | null>(null);
  const [editingIsNew, setEditingIsNew] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const platform = getPlatform();

  useEffect(() => {
    getShellIntegrationStatus()
      .then(setStatus)
      .catch((e) => frontendLog("shell_integration", `status load failed: ${String(e)}`));
  }, []);

  /** Push refreshed registration facts from a status into the store. */
  const applyStatusToStore = useCallback((st: ShellIntegrationStatus) => {
    useAppStore.setState((s) => {
      const prev = s.settings.shellIntegration ?? defaultShellIntegrationSettings();
      const merged: ShellIntegrationSettingsType = {
        ...prev,
        registered: st.registered,
        registeredExePath: st.registeredExePath,
      };
      const next = { ...s.settings, shellIntegration: merged };
      return { settings: next, savedSettings: next };
    });
  }, []);

  /** Persist an edited shell-integration settings value + refresh status. */
  const persist = useCallback(async (nextSi: ShellIntegrationSettingsType) => {
    const current = useAppStore.getState().settings;
    const next = { ...current, shellIntegration: nextSi };
    useAppStore.setState({ settings: next, savedSettings: next });
    try {
      const st = await saveShellIntegrationSettings(nextSi);
      setStatus(st);
    } catch (e) {
      frontendLog("shell_integration", `save failed: ${String(e)}`);
      toast.error("Failed to save shell integration settings", { description: String(e) });
      getShellIntegrationStatus()
        .then(setStatus)
        .catch(() => {});
    }
  }, []);

  const handleReinstall = useCallback(
    () =>
      toast.promise(
        installShellIntegration().then((st) => {
          setStatus(st);
          applyStatusToStore(st);
        }),
        {
          loading: "Registering shell integration…",
          success: "Shell integration registered",
          error: (e) => `Registration failed: ${String(e)}`,
        }
      ),
    [applyStatusToStore]
  );

  const handleUninstall = useCallback(
    () =>
      toast.promise(
        uninstallShellIntegration().then((st) => {
          setStatus(st);
          applyStatusToStore(st);
        }),
        {
          loading: "Removing shell integration…",
          success: "Shell integration removed",
          error: (e) => `Removal failed: ${String(e)}`,
        }
      ),
    [applyStatusToStore]
  );

  const openAddEntry = useCallback(() => {
    setEditingEntry(createEntry());
    setEditingIsNew(true);
    setEditorOpen(true);
  }, []);

  const openEditEntry = useCallback((entry: ShellEntry) => {
    setEditingEntry(entry);
    setEditingIsNew(false);
    setEditorOpen(true);
  }, []);

  const handleSaveEntry = useCallback(
    (entry: ShellEntry) => {
      const entries = editingIsNew ? addEntry(si.entries, entry) : updateEntry(si.entries, entry);
      setEditorOpen(false);
      void persist({ ...si, entries });
      toast.success(editingIsNew ? "Entry added" : "Entry updated");
    },
    [editingIsNew, si, persist]
  );

  const handleDeleteEntry = useCallback(
    (id: string) => {
      void persist({ ...si, entries: removeEntry(si.entries, id) });
    },
    [si, persist]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const from = si.entries.findIndex((e) => e.id === active.id);
      const to = si.entries.findIndex((e) => e.id === over.id);
      if (from === -1 || to === -1) return;
      void persist({ ...si, entries: reorderEntries(si.entries, from, to) });
    },
    [si, persist]
  );

  const detectedById = useMemo(() => {
    const map = new Map<string, DetectedFileManager>();
    for (const m of status?.detectedFileManagers ?? []) map.set(m.id, m);
    return map;
  }, [status]);

  if (visibleFields && !OWNED_FIELD_IDS.some((id) => visibleFields.has(id))) {
    return null;
  }

  const connectionName = (id?: string) =>
    id ? (connections.find((c) => c.id === id)?.name ?? "(missing)") : "(picker)";

  return (
    <div className="settings-panel__section" data-testid="settings-shell-integration">
      <div className="settings-panel__section-header">
        <h3 className="settings-panel__section-title">Shell Integration</h3>
      </div>

      {/* Registration status + actions */}
      <div className="shell-integration__card" data-testid="shell-integration-status-card">
        <div className="shell-integration__status-line">
          <span
            className={`shell-integration__dot${status?.registered ? " shell-integration__dot--on" : ""}`}
            aria-hidden
          />
          <span data-testid="shell-integration-status-text">
            {status?.registered ? "Registered" : "Not registered"}
          </span>
          {status?.stale && !status.portable && (
            <span className="shell-integration__stale" data-testid="shell-integration-stale-badge">
              Executable moved — reinstall to update
            </span>
          )}
        </div>
        {status?.stale && !status.portable && (
          <p className="settings-panel__description" data-testid="shell-integration-stale-banner">
            Shell integration points to <code>{status.registeredExePath}</code>, but termiHub now
            runs from <code>{status.currentExePath}</code>. Reinstall to update the context-menu
            entries.
          </p>
        )}
        <div className="shell-integration__actions">
          <Button
            variant="primary"
            onClick={handleReinstall}
            data-testid="shell-integration-reinstall"
          >
            Reinstall / Update
          </Button>
          <Button
            variant="secondary"
            onClick={handleUninstall}
            disabled={!status?.registered}
            data-testid="shell-integration-uninstall"
          >
            Uninstall
          </Button>
        </div>
      </div>

      {/* Quick-access entries */}
      <div className="settings-panel__section-header">
        <h4 className="settings-panel__subsection-title">Quick-Access Entries</h4>
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus size={14} />}
          onClick={openAddEntry}
          data-testid="shell-integration-add-entry"
        >
          Add entry
        </Button>
      </div>

      {si.entries.length === 0 ? (
        <p className="settings-panel__description" data-testid="shell-integration-entries-empty">
          No quick-access entries yet. Add one to show it in your file manager's right-click menu.
        </p>
      ) : (
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext
            items={si.entries.map((e) => e.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul
              className="shell-integration__entry-list"
              data-testid="shell-integration-entry-list"
            >
              {si.entries.map((entry, index) => (
                <SortableEntryRow
                  key={entry.id}
                  entry={entry}
                  index={index}
                  connectionLabel={connectionName(entry.connectionId)}
                  onEdit={() => openEditEntry(entry)}
                  onDelete={() => handleDeleteEntry(entry.id)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
      <p className="settings-panel__description">
        Drag the handle to reorder. The first “Always” entry is the default.
      </p>

      {/* Fallback + window behaviour */}
      <Field label="Fallback when no entry matches" htmlFor="shell-integration-fallback">
        <Select
          value={si.fallback}
          onChange={(value) =>
            void persist({ ...si, fallback: value as ShellIntegrationSettingsType["fallback"] })
          }
          options={[
            { value: "picker", label: "Show session picker" },
            { value: "systemDefaultShell", label: "Use system default shell" },
          ]}
          aria-label="Fallback when no entry matches"
          data-testid="shell-integration-fallback"
        />
      </Field>

      <label className="shell-integration__toggle-row">
        <Toggle
          checked={si.openInNewWindow}
          onCheckedChange={(v) => void persist({ ...si, openInNewWindow: v })}
          aria-label="Always open spawned sessions in a new window"
          data-testid="shell-integration-new-window"
        />
        <span>Always open a new window (instead of the running instance)</span>
      </label>

      {/* Linux per-file-manager toggles */}
      {platform === "linux" && (
        <div className="shell-integration__linux" data-testid="shell-integration-linux">
          <h4 className="settings-panel__subsection-title">Linux — File Manager Integrations</h4>
          {LINUX_MANAGERS.map(({ key, id, label }) => {
            const detected = detectedById.get(id);
            return (
              <label key={key} className="shell-integration__toggle-row">
                <Toggle
                  checked={si.linuxFileManagers[key]}
                  onCheckedChange={(v) =>
                    void persist({
                      ...si,
                      linuxFileManagers: { ...si.linuxFileManagers, [key]: v },
                    })
                  }
                  aria-label={label}
                  data-testid={`shell-integration-linux-${id}`}
                />
                <span>
                  {label}{" "}
                  <span className="shell-integration__meta">
                    {detected?.detected
                      ? `— detected: ${detected.name}${detected.version ? ` ${detected.version}` : ""}`
                      : "— not detected"}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      )}

      {editingEntry && (
        <ShellIntegrationEntryEditor
          open={editorOpen}
          onOpenChange={setEditorOpen}
          entry={editingEntry}
          isNew={editingIsNew}
          connections={connections}
          onSave={handleSaveEntry}
        />
      )}
    </div>
  );
}

interface SortableEntryRowProps {
  entry: ShellEntry;
  index: number;
  connectionLabel: string;
  onEdit: () => void;
  onDelete: () => void;
}

/** A single reorderable quick-access entry row. */
function SortableEntryRow({
  entry,
  index,
  connectionLabel,
  onEdit,
  onDelete,
}: SortableEntryRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="shell-integration__entry-row"
      data-testid={`shell-integration-entry-${entry.id}`}
    >
      <button
        type="button"
        className="shell-integration__grip"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={14} />
      </button>
      <span className="shell-integration__entry-idx">{index + 1}</span>
      <span className="shell-integration__entry-name">{entry.name}</span>
      <span className="shell-integration__entry-conn">{connectionLabel}</span>
      <span className={`shell-integration__badge shell-integration__badge--${entry.visibility}`}>
        {entry.visibility === "always" ? "Always" : "Extended"}
      </span>
      <div className="shell-integration__entry-actions">
        <Tooltip content="Edit entry">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Pencil size={14} />}
            onClick={onEdit}
            aria-label="Edit entry"
            data-testid={`shell-integration-entry-edit-${entry.id}`}
          />
        </Tooltip>
        <Tooltip content="Delete entry">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Trash2 size={14} />}
            onClick={onDelete}
            aria-label="Delete entry"
            data-testid={`shell-integration-entry-delete-${entry.id}`}
          />
        </Tooltip>
      </div>
    </li>
  );
}
