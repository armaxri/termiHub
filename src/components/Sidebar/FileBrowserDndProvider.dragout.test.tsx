/**
 * The hand-off from the in-app dnd-kit row drag to a native OS drag-out (#3457):
 * the first pointer move outside the window reports the dragged rows once, the
 * control reflects whether the in-app drag is still held, and cancelling it
 * ends the dnd-kit drag the way Escape does. jsdom cannot hit-test dnd-kit, so
 * the DndContext's own handlers are driven directly (as in the drag-move test).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as DndCore from "@dnd-kit/core";
import type { FileEntry } from "@/types/connection";
import { FileBrowserDndProvider, type DragOutControl } from "./FileBrowserDndProvider";

let dndProps: ComponentProps<typeof DndCore.DndContext> | null = null;

vi.mock("@dnd-kit/core", async () => {
  const actual = await vi.importActual<typeof DndCore>("@dnd-kit/core");
  return {
    ...actual,
    DndContext: (props: ComponentProps<typeof actual.DndContext>) => {
      dndProps = props;
      return <actual.DndContext {...props} />;
    },
  };
});

const entries: FileEntry[] = [
  {
    name: "a.txt",
    path: "/home/u/a.txt",
    isDirectory: false,
    size: 1,
    modified: "",
    permissions: null,
    writable: null,
  },
];

let root: Root;
let container: HTMLDivElement;
const onDragOut = vi.fn<(e: FileEntry[], c: DragOutControl) => void>();

function startDrag() {
  act(() => {
    dndProps?.onDragStart?.({
      active: { id: "file:/home/u/a.txt", data: { current: { type: "file-entries", entries } } },
      activatorEvent: new MouseEvent("pointerdown"),
    } as unknown as DndCore.DragStartEvent);
  });
}

function movePointer(clientX: number, clientY: number) {
  act(() => {
    window.dispatchEvent(new MouseEvent("pointermove", { clientX, clientY }));
  });
}

beforeEach(() => {
  onDragOut.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <FileBrowserDndProvider onDrop={vi.fn()} onDragOut={onDragOut}>
        <div />
      </FileBrowserDndProvider>
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  dndProps = null;
});

describe("FileBrowserDndProvider — drag-out hand-off", () => {
  it("does nothing while the pointer stays inside the window", () => {
    startDrag();
    movePointer(10, 10);
    expect(onDragOut).not.toHaveBeenCalled();
  });

  it("reports the dragged rows once when the pointer leaves the window", () => {
    startDrag();
    movePointer(-4, 20);
    movePointer(-40, 20);
    movePointer(window.innerWidth + 5, 20);
    expect(onDragOut).toHaveBeenCalledTimes(1);
    expect(onDragOut.mock.calls[0][0]).toBe(entries);
  });

  it("ignores pointer moves outside the window when no row drag is active", () => {
    movePointer(-4, 20);
    expect(onDragOut).not.toHaveBeenCalled();
  });

  it("exposes whether the in-app drag is still held and cancels it with Escape", () => {
    const escapes = vi.fn();
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") escapes();
    };
    document.addEventListener("keydown", onKey);
    try {
      startDrag();
      movePointer(-4, 20);
      const control = onDragOut.mock.calls[0][1];
      expect(control.isStillDragging()).toBe(true);

      control.cancelInAppDrag();
      expect(escapes).toHaveBeenCalledTimes(1);

      act(() => {
        dndProps?.onDragCancel?.({} as DndCore.DragCancelEvent);
      });
      expect(control.isStillDragging()).toBe(false);
      // Once the drag is over, cancelling again must not inject another Escape.
      control.cancelInAppDrag();
      expect(escapes).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", onKey);
    }
  });

  it("arms again for the next drag", () => {
    startDrag();
    movePointer(-4, 20);
    act(() => {
      dndProps?.onDragEnd?.({
        active: { data: { current: { type: "file-entries", entries } } },
        over: null,
      } as unknown as DndCore.DragEndEvent);
    });
    startDrag();
    movePointer(-4, 20);
    expect(onDragOut).toHaveBeenCalledTimes(2);
  });
});
