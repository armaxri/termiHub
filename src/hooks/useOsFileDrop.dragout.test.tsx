/**
 * A file this window drags out to the OS (#3457) and releases back over
 * termiHub must not be re-imported by the OS-drop upload path, while a genuine
 * OS drop keeps working.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { beginDragOut, endDragOut, resetDragOutTracking } from "@/utils/fileDragOut";
import { useOsFileDrop } from "./useOsFileDrop";

type DragDropPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

let emit: ((event: { payload: DragDropPayload }) => void) | null = null;
let root: Root;
let host: HTMLDivElement;
const onDrop = vi.fn();
const overStates: boolean[] = [];

function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  const { isDragOver } = useOsFileDrop(ref, onDrop);
  overStates.push(isDragOver);
  return createElement("div", { ref });
}

const inside = { x: 5, y: 5 };

function fire(payload: DragDropPayload) {
  act(() => emit?.({ payload }));
}

beforeEach(async () => {
  resetDragOutTracking();
  onDrop.mockReset();
  overStates.length = 0;
  vi.mocked(getCurrentWindow).mockReturnValue({
    onDragDropEvent: (cb: (event: { payload: DragDropPayload }) => void) => {
      emit = cb;
      return Promise.resolve(() => {});
    },
  } as unknown as ReturnType<typeof getCurrentWindow>);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
  } as DOMRect);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(Harness));
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  emit = null;
});

describe("useOsFileDrop — own drag-out", () => {
  it("ignores this window's own drag-out coming back over it", () => {
    beginDragOut(["/home/u/a.txt"]);
    fire({ type: "enter", paths: ["/home/u/a.txt"], position: inside });
    fire({ type: "over", position: inside });
    fire({ type: "drop", paths: ["/home/u/a.txt"], position: inside });
    endDragOut();

    expect(onDrop).not.toHaveBeenCalled();
    expect(overStates.every((v) => v === false)).toBe(true);
  });

  it("still uploads a genuine OS drop", () => {
    beginDragOut(["/home/u/a.txt"]);
    endDragOut(0); // long finished
    fire({ type: "enter", paths: ["/Users/me/other.txt"], position: inside });
    fire({ type: "drop", paths: ["/Users/me/other.txt"], position: inside });
    expect(onDrop).toHaveBeenCalledWith(["/Users/me/other.txt"]);
  });
});
