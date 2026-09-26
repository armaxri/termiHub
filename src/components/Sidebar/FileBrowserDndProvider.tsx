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
  children: React.ReactNode;
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
export function FileBrowserDndProvider({ onDrop, children }: FileBrowserDndProviderProps) {
  // An 8px activation distance keeps plain clicks, double-clicks and the
  // right-click context menu working on rows.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const [dragging, setDragging] = useState<FileEntry[] | null>(null);
  const [copyMode, setCopyMode] = useState(false);
  const copyRef = useRef(false);

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

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const drag = asFileDragData(event.active.data.current);
      if (!drag) return;
      updateCopy(hasCopyModifier(event.activatorEvent));
      setDragging(drag.entries);
    },
    [updateCopy]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDragging(null);
      const drag = asFileDragData(event.active.data.current);
      const drop = asFileDropData(event.over?.data.current);
      if (!drag || !drop) return;
      onDrop(drag.entries, drop.destDir, copyRef.current ? "copy" : "move", drop.destEntry);
    },
    [onDrop]
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDragging(null)}
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
