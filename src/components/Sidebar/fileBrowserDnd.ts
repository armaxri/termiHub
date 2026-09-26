import { useCallback } from "react";
import { useDndContext, useDraggable, useDroppable } from "@dnd-kit/core";
import type { FileEntry } from "@/types/connection";
import { planFileDrop } from "@/utils/fileDragMove";

/**
 * dnd-kit payloads for file-browser drag-to-move (PROD-006). Pointer-driven
 * dnd-kit is used (as for the connection tree and tabs) rather than HTML5 drag
 * events, because Tauri's native OS-file drop handler swallows HTML5 drag events
 * on some platforms — OS→app uploads keep using `useOsFileDrop`.
 */

/** Drag payload: the entries a row drag carries (the whole selection when the row is selected). */
export interface FileDragData {
  type: "file-entries";
  entries: FileEntry[];
}

/** Drop payload: the folder a drop lands in (a directory row or a breadcrumb). */
export interface FileDropData {
  type: "file-dest";
  destDir: string;
  /** The directory row's entry, when the target is a row (carries `writable`). */
  destEntry?: FileEntry;
}

/** Narrow an unknown dnd-kit `data.current` to a {@link FileDragData}. */
export function asFileDragData(data: unknown): FileDragData | null {
  const d = data as Partial<FileDragData> | null | undefined;
  return d && d.type === "file-entries" && Array.isArray(d.entries) ? (d as FileDragData) : null;
}

/** Narrow an unknown dnd-kit `data.current` to a {@link FileDropData}. */
export function asFileDropData(data: unknown): FileDropData | null {
  const d = data as Partial<FileDropData> | null | undefined;
  return d && d.type === "file-dest" && typeof d.destDir === "string" ? (d as FileDropData) : null;
}

/** Drop-target highlight state for a folder while a drag hovers it. */
export type FileDropHighlight = "valid" | "invalid" | null;

/**
 * Register a folder as a drop target and report whether the hovering drag could
 * land there (the move guards — self/descendant, read-only — decide validity).
 */
export function useFileDropTarget(
  id: string,
  destDir: string,
  destEntry?: FileEntry,
  disabled = false
): { setNodeRef: (el: HTMLElement | null) => void; highlight: FileDropHighlight } {
  const data: FileDropData = { type: "file-dest", destDir, destEntry };
  const { setNodeRef, isOver } = useDroppable({ id, data, disabled });
  const { active } = useDndContext();
  const drag = asFileDragData(active?.data.current);
  let highlight: FileDropHighlight = null;
  if (isOver && drag) {
    highlight =
      planFileDrop(drag.entries, destDir, "move", destEntry).kind === "ok" ? "valid" : "invalid";
  }
  return { setNodeRef, highlight };
}

/**
 * Wire one file-browser row for drag-to-move: every row is a drag source, and a
 * directory row is also a drop target. Returns one merged ref for the row
 * element, the pointer listeners to spread on it, and its visual state.
 */
export function useFileRowDnd(entry: FileEntry, dragEntries: FileEntry[], disabled: boolean) {
  const dragData: FileDragData = { type: "file-entries", entries: dragEntries };
  const {
    setNodeRef: setDragRef,
    listeners,
    isDragging,
  } = useDraggable({ id: `file:${entry.path}`, data: dragData, disabled });
  const { setNodeRef: setDropRef, highlight } = useFileDropTarget(
    `dir:${entry.path}`,
    entry.path,
    entry,
    disabled || !entry.isDirectory
  );
  const setNodeRef = useCallback(
    (el: HTMLElement | null) => {
      setDragRef(el);
      setDropRef(el);
    },
    [setDragRef, setDropRef]
  );
  return { setNodeRef, listeners, isDragging, highlight };
}
