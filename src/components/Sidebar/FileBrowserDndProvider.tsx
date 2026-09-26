import { useCallback, useEffect, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Copy, MoveRight } from "lucide-react";
import type { FileEntry } from "@/types/connection";
import { describeEntries, type FileTransferOperation } from "@/utils/fileDragMove";
import { isOutsideViewport } from "@/utils/fileDragOut";
import { asFileDragData, asFileDropData } from "./fileBrowserDnd";

interface FileBrowserDndProviderProps {
  /**
   * Called when a row drag is released over a folder: `operation` is `copy`
   * while Alt/Option is held at release, `move` otherwise.
   */
  onDrop: (
    entries: FileEntry[],
    destDir: string,
    operation: FileTransferOperation,
    destEntry?: FileEntry
  ) => void;
  /**
   * Called once per drag when the pointer leaves the window while row(s) are
   * being dragged — the hand-off to a native OS drag-out (#3457). The in-app
   * drag stays live until `control.cancelInAppDrag()` is called, so a pointer
   * that comes back can still drop into a folder.
   */
  onDragOut?: (entries: FileEntry[], control: DragOutControl) => void;
  children: React.ReactNode;
}

/** Lets a drag-out handler inspect and end the in-app drag it took over. */
export interface DragOutControl {
  /** Whether the in-app drag that left the window is still held. */
  isStillDragging: () => boolean;
  /** End the in-app drag (as cancelling it would) so the native OS drag takes over. */
  cancelInAppDrag: () => void;
}

/**
 * End the active dnd-kit pointer drag. Its PointerSensor cancels on a window
 * `visibilitychange`; that event is used rather than a synthetic Escape keydown
 * because app-wide Escape handlers (terminal zoom, tree selection) would also
 * react to — and the zoom one swallow — an Escape.
 */
function cancelActivePointerDrag(): void {
  window.dispatchEvent(new Event("visibilitychange"));
}

/** Whether a pointer/keyboard event carries the copy modifier (Alt / Option). */
function hasCopyModifier(event: Event | null | undefined): boolean {
  return !!event && "altKey" in event && (event as KeyboardEvent).altKey === true;
}

/** Screen-reader announcements that name files, not internal dnd-kit ids. */
function announcements(copy: () => boolean): Announcements {
  const label = (data: unknown) => {
    const drag = asFileDragData(data);
    return drag ? describeEntries(drag.entries) : "item";
  };
  const dest = (data: unknown) => asFileDropData(data)?.destDir ?? "this location";
  const verb = () => (copy() ? "copy" : "move");
  return {
    onDragStart: ({ active }) => `Picked up ${label(active.data.current)}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${label(active.data.current)} will ${verb()} into ${dest(over.data.current)}.`
        : `${label(active.data.current)} is not over a folder.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `Dropped ${label(active.data.current)} into ${dest(over.data.current)}.`
        : `Dropped ${label(active.data.current)}.`,
    onDragCancel: ({ active }) => `Cancelled dragging ${label(active.data.current)}.`,
  };
}

/**
 * The drag-to-move context for the file browser (PROD-006): a pointer drag of a
 * row (or the selection it belongs to) released over a directory row or a path
 * breadcrumb moves the entries there; holding Alt/Option copies instead. The
 * floating chip follows the pointer and says which of the two will happen.
 */
export function FileBrowserDndProvider({
  onDrop,
  onDragOut,
  children,
}: FileBrowserDndProviderProps) {
  // An 8px activation distance keeps plain clicks, double-clicks and the
  // right-click context menu working on rows.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const [dragging, setDragging] = useState<FileEntry[] | null>(null);
  const [copyMode, setCopyMode] = useState(false);
  const copyRef = useRef(false);
  const draggingRef = useRef<FileEntry[] | null>(null);
  const draggedOutRef = useRef(false);
  const onDragOutRef = useRef(onDragOut);
  onDragOutRef.current = onDragOut;

  const setActiveDrag = useCallback((entries: FileEntry[] | null) => {
    draggingRef.current = entries;
    draggedOutRef.current = false;
    setDragging(entries);
  }, []);

  const updateCopy = useCallback((next: boolean) => {
    copyRef.current = next;
    setCopyMode((prev) => (prev === next ? prev : next));
  }, []);

  // Track the Alt/Option modifier for the whole drag: pressing or releasing it
  // mid-drag flips move ↔ copy, and the state at release decides.
  useEffect(() => {
    if (!dragging) return;
    const onModifier = (e: KeyboardEvent | PointerEvent) => updateCopy(hasCopyModifier(e));
    window.addEventListener("keydown", onModifier);
    window.addEventListener("keyup", onModifier);
    window.addEventListener("pointermove", onModifier);
    return () => {
      window.removeEventListener("keydown", onModifier);
      window.removeEventListener("keyup", onModifier);
      window.removeEventListener("pointermove", onModifier);
    };
  }, [dragging, updateCopy]);

  // Drag-out (#3457): the first pointer move outside the window hands the
  // dragged rows to `onDragOut`, which starts the native OS drag.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const entries = draggingRef.current;
      const handler = onDragOutRef.current;
      if (!entries || !handler || draggedOutRef.current) return;
      if (!isOutsideViewport(e.clientX, e.clientY, window.innerWidth, window.innerHeight)) return;
      draggedOutRef.current = true;
      handler(entries, {
        isStillDragging: () => draggingRef.current === entries,
        cancelInAppDrag: () => {
          if (draggingRef.current === entries) cancelActivePointerDrag();
        },
      });
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [dragging]);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const drag = asFileDragData(event.active.data.current);
      if (!drag) return;
      updateCopy(hasCopyModifier(event.activatorEvent));
      setActiveDrag(drag.entries);
    },
    [updateCopy, setActiveDrag]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDrag(null);
      const drag = asFileDragData(event.active.data.current);
      const drop = asFileDropData(event.over?.data.current);
      if (!drag || !drop) return;
      onDrop(drag.entries, drop.destDir, copyRef.current ? "copy" : "move", drop.destEntry);
    },
    [onDrop, setActiveDrag]
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveDrag(null)}
      accessibility={{ announcements: announcements(() => copyRef.current) }}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {dragging && (
          <div className="file-browser__drag-chip" data-testid="file-browser-drag-chip">
            {copyMode ? <Copy size={12} /> : <MoveRight size={12} />}
            <span>
              {copyMode ? "Copy" : "Move"} {describeEntries(dragging)}
            </span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
