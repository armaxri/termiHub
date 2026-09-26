import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { ArrowUp, File, Folder, RefreshCw } from "lucide-react";
import { Button, EmptyState, Input, Spinner, Tooltip } from "@/components/ui";
import type { PaneSide } from "@/services/paneTransfer";
import type { FileEntry } from "@/types/connection";
import { formatBytes } from "@/utils/formatters";
import { isRootPath, type PaneListing } from "./usePaneListing";
import { nextPaneCursor, rangeSelection } from "./paneSelection";

/** What a dragged pane row carries (dnd-kit `data`). */
export interface PaneDragData {
  side: PaneSide;
  entries: FileEntry[];
}

/** What a pane drop target carries (dnd-kit `data`). */
export interface PaneDropData {
  side: PaneSide;
}

/** Props for {@link TransferPane}. */
export interface TransferPaneProps {
  side: PaneSide;
  /** Pane heading ("Local" or the remote tab's title). */
  title: string;
  listing: PaneListing;
  /** Selected entry paths. */
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
  /** Copy entries to the other pane (F5, or the view's copy buttons). */
  onCopy: (entries: FileEntry[]) => void;
  /** Whether copying out of this pane is currently possible. */
  canCopy: boolean;
  /** Extra header controls (the remote picker). */
  headerControls?: React.ReactNode;
  /** Shown instead of the listing when the pane has nothing to list. */
  placeholder?: React.ReactNode;
}

interface PaneRowProps {
  side: PaneSide;
  entry: FileEntry;
  id: string;
  active: boolean;
  selected: boolean;
  dragEntries: FileEntry[];
  onClick: (e: React.MouseEvent) => void;
  onOpen: () => void;
}

function PaneRow({
  side,
  entry,
  id,
  active,
  selected,
  dragEntries,
  onClick,
  onOpen,
}: PaneRowProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `${side}:${entry.path}`,
    data: { side, entries: dragEntries } satisfies PaneDragData,
  });
  // The listbox owns focus and keyboard handling; the row only takes pointer
  // input, so drop dnd-kit's own focus / role attributes.
  const { role: _role, tabIndex: _tabIndex, ...dragAttributes } = attributes;
  return (
    <div
      ref={setNodeRef}
      {...dragAttributes}
      {...listeners}
      id={id}
      role="option"
      aria-selected={selected}
      className={`transfer-pane__row${active ? " transfer-pane__row--active" : ""}${
        selected ? " transfer-pane__row--selected" : ""
      }${isDragging ? " transfer-pane__row--dragging" : ""}`}
      onClick={onClick}
      onDoubleClick={entry.isDirectory ? onOpen : undefined}
      data-testid={`transfer-pane-${side}-row-${entry.name}`}
    >
      {entry.isDirectory ? (
        <Folder size={14} className="transfer-pane__icon" aria-hidden="true" />
      ) : (
        <File size={14} className="transfer-pane__icon" aria-hidden="true" />
      )}
      <span className="transfer-pane__name">{entry.name}</span>
      {!entry.isDirectory && <span className="transfer-pane__size">{formatBytes(entry.size)}</span>}
    </div>
  );
}

/**
 * One side of the dual-pane transfer view (PROD-007, #3558): a path field,
 * Up / Refresh, and a keyboard-driven multi-select listbox whose rows can be
 * dragged onto the other pane.
 *
 * Keys (with the list focused): ↑/↓ move (Shift extends, Ctrl/Cmd moves the
 * cursor only), Home/End, Space toggles, Ctrl/Cmd+A selects all, Enter opens a
 * folder, Backspace goes up, F5 copies the selection to the other pane.
 */
export function TransferPane({
  side,
  title,
  listing,
  selected,
  onSelectedChange,
  onCopy,
  canCopy,
  headerControls,
  placeholder,
}: TransferPaneProps) {
  const { entries, path, loading, error } = listing;
  const baseId = useId();
  const [active, setActive] = useState(0);
  const [anchor, setAnchor] = useState(0);
  const [pathDraft, setPathDraft] = useState(path);
  const listRef = useRef<HTMLDivElement>(null);
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `transfer-pane-${side}`,
    data: { side } satisfies PaneDropData,
  });

  // A new directory starts with the cursor on its first row and no selection.
  useEffect(() => {
    setActive(0);
    setAnchor(0);
    setPathDraft(path);
    onSelectedChange(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    document.getElementById(`${baseId}-row-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, baseId]);

  const selectedEntries = useCallback((): FileEntry[] => {
    const picked = entries.filter((e) => selected.has(e.path));
    if (picked.length > 0) return picked;
    return entries[active] ? [entries[active]] : [];
  }, [entries, selected, active]);

  const open = useCallback(
    (entry: FileEntry | undefined) => {
      if (entry?.isDirectory) void listing.navigate(entry.path);
    },
    [listing]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    const next = nextPaneCursor(e.key, active, entries.length);
    if (next !== null) {
      e.preventDefault();
      setActive(next);
      if (e.shiftKey) {
        onSelectedChange(rangeSelection(entries, anchor, next));
      } else if (!mod) {
        setAnchor(next);
        onSelectedChange(new Set(entries[next] ? [entries[next].path] : []));
      }
      return;
    }
    const entry = entries[active];
    if (e.key === " " && entry) {
      e.preventDefault();
      const toggled = new Set(selected);
      if (toggled.has(entry.path)) toggled.delete(entry.path);
      else toggled.add(entry.path);
      setAnchor(active);
      onSelectedChange(toggled);
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      onSelectedChange(new Set(entries.map((x) => x.path)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(entry);
    } else if (e.key === "Backspace") {
      e.preventDefault();
      void listing.up();
    } else if (e.key === "F5") {
      e.preventDefault();
      const toCopy = selectedEntries();
      if (canCopy && toCopy.length > 0) onCopy(toCopy);
    }
  };

  const handleRowClick = (index: number, e: React.MouseEvent) => {
    const entry = entries[index];
    listRef.current?.focus();
    setActive(index);
    if (e.shiftKey) {
      onSelectedChange(rangeSelection(entries, anchor, index));
      return;
    }
    setAnchor(index);
    if (e.ctrlKey || e.metaKey) {
      const toggled = new Set(selected);
      if (toggled.has(entry.path)) toggled.delete(entry.path);
      else toggled.add(entry.path);
      onSelectedChange(toggled);
    } else {
      onSelectedChange(new Set([entry.path]));
    }
  };

  const dragEntriesFor = (entry: FileEntry): FileEntry[] =>
    selected.has(entry.path) ? entries.filter((x) => selected.has(x.path)) : [entry];

  return (
    <section
      ref={setDropRef}
      className={`transfer-pane${isOver ? " transfer-pane--drop-target" : ""}`}
      aria-label={`${title} files`}
      data-testid={`transfer-pane-${side}`}
    >
      <div className="transfer-pane__header">
        <span className="transfer-pane__title">{title}</span>
        {headerControls}
      </div>
      <div className="transfer-pane__toolbar">
        <Tooltip content="Go Up" side="top">
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowUp size={14} />}
            aria-label={`${title}: go up one directory`}
            disabled={!path || isRootPath(path)}
            onClick={() => void listing.up()}
            data-testid={`transfer-pane-${side}-up`}
          />
        </Tooltip>
        <Input
          size="sm"
          className="transfer-pane__path"
          value={pathDraft}
          aria-label={`${title} path`}
          disabled={!!placeholder}
          onChange={(e) => setPathDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && pathDraft.trim()) void listing.navigate(pathDraft.trim());
            if (e.key === "Escape") setPathDraft(path);
          }}
          data-testid={`transfer-pane-${side}-path`}
        />
        <Tooltip content="Refresh" side="top">
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={14} />}
            aria-label={`${title}: refresh`}
            disabled={!!placeholder}
            onClick={() => void listing.refresh()}
            data-testid={`transfer-pane-${side}-refresh`}
          />
        </Tooltip>
      </div>
      {error && (
        <div
          className="transfer-pane__error"
          role="alert"
          data-testid={`transfer-pane-${side}-error`}
        >
          {error}
        </div>
      )}
      {placeholder ? (
        <div className="transfer-pane__placeholder">{placeholder}</div>
      ) : (
        <div
          ref={listRef}
          className="transfer-pane__list"
          role="listbox"
          aria-multiselectable="true"
          aria-label={`${title}: ${path || "loading"}`}
          aria-busy={loading}
          aria-activedescendant={entries.length > 0 ? `${baseId}-row-${active}` : undefined}
          aria-keyshortcuts="F5"
          tabIndex={0}
          onKeyDown={handleKeyDown}
          data-testid={`transfer-pane-${side}-list`}
        >
          {loading && entries.length === 0 ? (
            <div className="transfer-pane__loading">
              <Spinner size="sm" />
            </div>
          ) : entries.length === 0 ? (
            <EmptyState title="Empty folder" />
          ) : (
            entries.map((entry, index) => (
              <PaneRow
                key={entry.path}
                side={side}
                entry={entry}
                id={`${baseId}-row-${index}`}
                active={index === active}
                selected={selected.has(entry.path)}
                dragEntries={dragEntriesFor(entry)}
                onClick={(e) => handleRowClick(index, e)}
                onOpen={() => open(entry)}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}
