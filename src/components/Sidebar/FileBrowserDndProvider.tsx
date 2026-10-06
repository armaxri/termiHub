import { useCallback, useEffect, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type Announcements,
  type DragAbortEvent,
  type DragEndEvent,
  type DragOverEvent,
  type DragPendingEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Copy, MoveRight } from "lucide-react";
import type { FileEntry } from "@/types/connection";
import { describeEntries, type FileTransferOperation } from "@/utils/fileDragMove";
import { isOutsideViewport } from "@/utils/fileDragOut";
import { asFileDragData, asFileDropData } from "./fileBrowserDnd";
import {
  CancelSignalRecorder,
  LOST_DRAG_CHECK_MS,
  describeDndId,
  describePointerEvent,
  logFileDrag,
} from "./fileDragDiagnostics";

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
  // Durable drag diagnostics (#4110): what cancelled a drag, and whether the
  // current press already logged its pending phase.
  const cancelSignalsRef = useRef<CancelSignalRecorder | null>(null);
  if (!cancelSignalsRef.current) cancelSignalsRef.current = new CancelSignalRecorder();
  const pendingLoggedRef = useRef(false);
  // Pointer moves dnd-kit saw while the press was still pending, and the
  // displacement of the farthest of them from the press point: an abort then says whether the
  // pointer moved at all (#4110: the Windows bridge drag never crossed 8px).
  const pendingMovesRef = useRef({ moves: 0, maxX: 0, maxY: 0, maxDist: 0 });

  const setActiveDrag = useCallback((entries: FileEntry[] | null) => {
    draggingRef.current = entries;
    draggedOutRef.current = false;
    setDragging(entries);
  }, []);

  // dnd-kit only calls onDragEnd/onDragCancel once it has committed the drag's
  // start render; an end or cancel that arrives before that commit tears the
  // sensor down with no callback at all — the drop is silently lost and the chip
  // would stick. Detect that after every drag-ending signal, log it, and reset.
  useEffect(() => {
    const recorder = cancelSignalsRef.current;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    recorder?.attach(window, (kind) => {
      const entries = draggingRef.current;
      if (!entries) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (draggingRef.current !== entries) return;
        logFileDrag(
          () =>
            `lost: the drag of ${entries.length} entr${entries.length === 1 ? "y" : "ies"} ended ` +
            `(${kind}) but dnd-kit fired neither onDragEnd nor onDragCancel — it had not ` +
            `committed the drag start yet, so nothing was dropped`
        );
        setActiveDrag(null);
      }, LOST_DRAG_CHECK_MS);
      timers.add(timer);
    });
    return () => {
      recorder?.detach();
      for (const timer of timers) clearTimeout(timer);
    };
  }, [setActiveDrag]);

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
      logFileDrag(
        () =>
          `drag-out: pointer left the viewport at (${Math.round(e.clientX)},${Math.round(e.clientY)}) ` +
          `viewport=${window.innerWidth}x${window.innerHeight}, handing ${entries.length} entr${entries.length === 1 ? "y" : "ies"} to the native drag`
      );
      handler(entries, {
        isStillDragging: () => draggingRef.current === entries,
        cancelInAppDrag: () => {
          if (draggingRef.current !== entries) return;
          cancelSignalsRef.current?.note("drag-out", "native OS drag took over");
          cancelActivePointerDrag();
        },
      });
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [dragging]);

  const handleDragPending = useCallback((event: DragPendingEvent) => {
    // Fired on the press (no offset) and again on every move until activation
    // (with the offset from the press point): tally the moves, log once.
    if (event.offset) {
      const seen = pendingMovesRef.current;
      seen.moves += 1;
      const dist = Math.hypot(event.offset.x, event.offset.y);
      if (dist >= seen.maxDist) {
        seen.maxDist = dist;
        // dnd-kit's offset is press-minus-pointer; log the pointer's displacement.
        seen.maxX = -event.offset.x;
        seen.maxY = -event.offset.y;
      }
    }
    if (pendingLoggedRef.current) return;
    pendingLoggedRef.current = true;
    pendingMovesRef.current = { moves: 0, maxX: 0, maxY: 0, maxDist: 0 };
    logFileDrag(
      () =>
        `pending: id=${describeDndId(event.id)} at=(${Math.round(event.initialCoordinates.x)},` +
        `${Math.round(event.initialCoordinates.y)}) constraint=${JSON.stringify(event.constraint)}`
    );
  }, []);

  const handleDragAbort = useCallback((event: DragAbortEvent) => {
    // Released (or cancelled) before the activation distance was crossed.
    pendingLoggedRef.current = false;
    const seen = pendingMovesRef.current;
    pendingMovesRef.current = { moves: 0, maxX: 0, maxY: 0, maxDist: 0 };
    logFileDrag(
      () =>
        `abort before activation: id=${describeDndId(event.id)} ` +
        `reason=${cancelSignalsRef.current?.takeReason() ?? "unknown"} ` +
        `moves=${seen.moves} farthest=(${Math.round(seen.maxX)},${Math.round(seen.maxY)})`
    );
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    logFileDrag(
      () => `over: active=${describeDndId(event.active.id)} over=${describeDndId(event.over?.id)}`
    );
  }, []);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      pendingLoggedRef.current = false;
      const drag = asFileDragData(event.active.data.current);
      logFileDrag(
        () =>
          `start: active=${describeDndId(event.active.id)} entries=${drag?.entries.length ?? 0} ` +
          `${describePointerEvent(event.activatorEvent)}`
      );
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
      logFileDrag(
        () =>
          `end: active=${describeDndId(event.active.id)} over=${describeDndId(event.over?.id)} ` +
          `dest=${drop?.destDir ?? "none"} delta=(${Math.round(event.delta.x)},${Math.round(event.delta.y)}) ` +
          `collisions=${event.collisions?.length ?? 0} ` +
          (drag && drop
            ? `→ ${copyRef.current ? "copy" : "move"}`
            : "→ no drop (not over a folder)")
      );
      if (!drag || !drop) return;
      onDrop(drag.entries, drop.destDir, copyRef.current ? "copy" : "move", drop.destEntry);
    },
    [onDrop, setActiveDrag]
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragPending={handleDragPending}
      onDragAbort={handleDragAbort}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={(event) => {
        logFileDrag(
          () =>
            `cancel: active=${describeDndId(event.active.id)} over=${describeDndId(event.over?.id)} ` +
            `reason=${cancelSignalsRef.current?.takeReason() ?? "unknown"}`
        );
        setActiveDrag(null);
      }}
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
