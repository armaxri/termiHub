/**
 * End-to-end drag-to-move gesture through the REAL dnd-kit PointerSensor and the
 * REAL test-bridge `dragTo` verb (#4110), instead of calling the DndContext
 * handlers directly like the other provider tests.
 *
 * jsdom has no layout, so each row's `getBoundingClientRect` is stubbed with the
 * geometry of the failing Windows nightly (a folder row directly above the file
 * row, 28px rows, the drag going *up*). The bridge then fires the same
 * Chromium-shaped pointer sequence it fires in WebView2 — `pointerType: "mouse"`,
 * `isPrimary`, a wake move past the 8px activation distance, stepped moves with a
 * frame yielded after each, release over the folder.
 *
 * Besides proving the provider + bridge land a drop when nothing interferes, it
 * pins the durable diagnostics the next Windows nightly relies on: a landed drop
 * logs start/over/end, and a drag cancelled mid-gesture logs *why*.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FileEntry } from "@/types/connection";
import { dispatchCommand, type BridgeDeps } from "@/testbridge/dispatcher";
import { FileBrowserDndProvider } from "./FileBrowserDndProvider";
import { useFileRowDnd } from "./fileBrowserDnd";
import { LOST_DRAG_CHECK_MS } from "./fileDragDiagnostics";

const durable = vi.fn<(target: string, message: string) => void>();
vi.mock("@/utils/frontendLog", async () => {
  const actual = await vi.importActual<typeof import("@/utils/frontendLog")>("@/utils/frontendLog");
  return {
    ...actual,
    frontendDurableInfo: (target: string, message: string) => durable(target, message),
  };
});

const DIR = "C:/Users/runneradmin/AppData/Local/Temp/e2e_fb";
const dest: FileEntry = {
  name: "dest",
  path: `${DIR}/dest`,
  isDirectory: true,
  size: 0,
  modified: "",
  permissions: null,
  writable: null,
};
const file: FileEntry = {
  name: "file.txt",
  path: `${DIR}/file.txt`,
  isDirectory: false,
  size: 8,
  modified: "",
  permissions: null,
  writable: null,
};

/** Viewport rects per row (the failing nightly's layout: folder above file). */
const ROW_TOP: Record<string, number> = { dest: 180, "file.txt": 208 };
/** Per-test override of the file row's top (e.g. laid out on top of the folder). */
let fileRowTop: () => number = () => ROW_TOP["file.txt"];
const ROW_HEIGHT = 28;

function Row({ entry }: { entry: FileEntry }) {
  const dnd = useFileRowDnd(entry, [entry], false);
  return (
    <div ref={dnd.setNodeRef} data-row={entry.name} {...dnd.listeners}>
      <button data-testid={`file-row-${entry.name}`}>{entry.name}</button>
    </div>
  );
}

function rectFor(el: Element): DOMRect {
  const row = (el as HTMLElement).closest("[data-row]")?.getAttribute("data-row");
  if (!row || ROW_TOP[row] === undefined) return new DOMRect(0, 0, 0, 0);
  const top = row === "file.txt" ? fileRowTop() : ROW_TOP[row];
  return new DOMRect(48, top, 250, ROW_HEIGHT);
}

let root: Root;
let container: HTMLDivElement;
const onDrop = vi.fn();
const deps = (): BridgeDeps => ({ root: document }) as unknown as BridgeDeps;
const logged = () => durable.mock.calls.map(([, message]) => message);

beforeEach(() => {
  fileRowTop = () => ROW_TOP["file.txt"];
  durable.mockReset();
  onDrop.mockReset();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return rectFor(this);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <FileBrowserDndProvider onDrop={onDrop}>
        <Row entry={dest} />
        <Row entry={file} />
      </FileBrowserDndProvider>
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

/**
 * Run the bridge verb OUTSIDE `act()`: `act` holds every React update until its
 * scope ends, so dnd-kit would never commit the drag-start render between the
 * bridge's moves — and a release before that commit ends the drag silently (no
 * onDragEnd at all). Real scheduling is exactly what the bridge relies on.
 */
async function dragFileOntoFolder() {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const prev = g.IS_REACT_ACT_ENVIRONMENT;
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    return await dispatchCommand(
      { action: "dragTo", fromTestId: "file-row-file.txt", toTestId: "file-row-dest" },
      deps()
    );
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = prev;
  }
}

describe("FileBrowserDndProvider — real PointerSensor gesture (#4110)", () => {
  it("lands a bridge dragTo of a file onto the folder above it as a move", async () => {
    expect(await dragFileOntoFolder()).toEqual({ ok: true, action: "dragTo" });

    expect(onDrop).toHaveBeenCalledTimes(1);
    const [entries, destDir, operation] = onDrop.mock.calls[0];
    expect((entries as FileEntry[]).map((e) => e.name)).toEqual(["file.txt"]);
    expect(destDir).toBe(dest.path);
    expect(operation).toBe("move");
  });

  it("logs the gesture's phases durably so a CI failure artifact shows them", async () => {
    await dragFileOntoFolder();

    const lines = logged();
    expect(lines.some((l) => l.startsWith(`pending: id=file:${file.path}`))).toBe(true);
    expect(
      lines.some(
        (l) =>
          l.startsWith(`start: active=file:${file.path} entries=1 type=pointerdown`) &&
          l.includes("pointerType=mouse") &&
          l.includes("isPrimary=true")
      )
    ).toBe(true);
    expect(lines).toContain(`over: active=file:${file.path} over=dir:${dest.path}`);
    expect(
      lines.some(
        (l) =>
          l.startsWith(`end: active=file:${file.path} over=dir:${dest.path}`) && /→ move$/.test(l)
      )
    ).toBe(true);
    // Only the provider's drag lines and the bridge's one geometry line per drag.
    expect(
      durable.mock.calls.every(([target]) => target === "file_drag" || target === "test_bridge")
    ).toBe(true);
  });

  it("logs a mid-drag window resize as the cancel reason (and drops nothing)", async () => {
    // dnd-kit's PointerSensor cancels on a window resize — one of the #4110
    // suspects (WebView2 can fire resize/visibilitychange the WKWebView leg never
    // sees). Fire it once the drag is committed and hovering the folder.
    let fired = false;
    durable.mockImplementation((_t, message) => {
      if (!fired && message.startsWith("over:")) {
        fired = true;
        queueMicrotask(() => window.dispatchEvent(new Event("resize")));
      }
    });

    await dragFileOntoFolder();

    expect(onDrop).not.toHaveBeenCalled();
    expect(logged().some((l) => /^cancel: active=file:.* reason=resize \(viewport=/.test(l))).toBe(
      true
    );
  });

  it("logs a drag dnd-kit drops without any callback as lost, and resets", async () => {
    // A release that lands before dnd-kit commits its drag-start render ends the
    // sensor with NO onDragEnd/onDragCancel — the silent no-drop/no-toast/no-log
    // shape of #4110. `act()` reproduces it deterministically: it holds every
    // React update until the whole gesture is over.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      await act(async () => {
        await dispatchCommand(
          { action: "dragTo", fromTestId: "file-row-file.txt", toTestId: "file-row-dest" },
          deps()
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LOST_DRAG_CHECK_MS + 50);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(onDrop).not.toHaveBeenCalled();
    const lines = logged();
    expect(lines.some((l) => l.startsWith("start:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("end:") || l.startsWith("cancel:"))).toBe(false);
    expect(
      lines.some((l) =>
        /^lost: the drag of 1 entry ended \(pointerup\) but dnd-kit fired neither/.test(l)
      )
    ).toBe(true);
    // The provider reset itself: no drag chip is left stuck on screen.
    expect(document.querySelector('[data-testid="file-browser-drag-chip"]')).toBeNull();
  });

  it("reproduces the Windows nightly signature: a press that never moves aborts on release", async () => {
    // The 2026-10-06 Windows nightly (run 37431203434) logged, for every attempt,
    //   pending: id=file:…_file.txt at=(154,194) constraint={"distance":8}
    //   abort before activation: id=file:…_file.txt reason=pointerup
    // ~180ms apart and nothing else: the bridge's pointer never got 8px from the
    // press point. Replay that exact sequence — press, the bridge's seven
    // frame-separated moves all at the press point, release — through the real
    // PointerSensor: no drag starts, nothing drops, and the abort line now says
    // how many moves dnd-kit saw and how far the farthest one got.
    const button = document.querySelector('[data-testid="file-row-file.txt"]')!;
    const fire = (target: EventTarget, type: string) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 154,
          clientY: 194,
          pointerId: 1,
          isPrimary: true,
          pointerType: "mouse",
        })
      );
    fire(button, "pointerdown");
    for (let i = 0; i < 7; i++) {
      fire(document, "pointermove");
      await new Promise((r) => setTimeout(r, 0));
    }
    fire(document, "pointerup");

    expect(onDrop).not.toHaveBeenCalled();
    expect(logged()).toEqual([
      `pending: id=file:${file.path} at=(154,194) constraint={"distance":8}`,
      `abort before activation: id=file:${file.path} reason=pointerup moves=7 farthest=(0,0)`,
    ]);
  });

  it("waits for a target laid out on top of the source to separate, then drops (#4110)", async () => {
    // The nightly pressed the file row at the folder row's spot: the two rows'
    // centers coincided, so the old wake (`dx / 1 * 12` with dx = 0) never moved
    // the pointer and the press aborted. Model a re-layout that briefly stacks the
    // file row on the folder row: dragTo must wait for them to separate and then
    // press the file row where it really is.
    let settled = false;
    setTimeout(() => (settled = true), 120);
    fileRowTop = () => (settled ? ROW_TOP["file.txt"] : ROW_TOP.dest);

    expect(await dragFileOntoFolder()).toEqual({ ok: true, action: "dragTo" });

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0][1]).toBe(dest.path);
    const lines = logged();
    expect(lines).toContain(`pending: id=file:${file.path} at=(173,222) constraint={"distance":8}`);
    expect(
      lines.some((l) =>
        /^dragTo file-row-file\.txt \[48,208 250x28\] -> file-row-dest \[48,180 250x28\] — target separated from the source after \d+ frame\(s\)$/.test(
          l
        )
      )
    ).toBe(true);
  });

  it("still activates the drag when the target never leaves the source (#4110)", async () => {
    // If the stacked layout never resolves, the bridge drags anyway with a
    // fixed-direction wake so dnd-kit activates (instead of a silent pending →
    // abort) and logs that the target was on top of the source.
    fileRowTop = () => ROW_TOP.dest;

    expect(await dragFileOntoFolder()).toEqual({ ok: true, action: "dragTo" });

    const lines = logged();
    expect(lines.some((l) => l.startsWith(`start: active=file:${file.path}`))).toBe(true);
    expect(lines.some((l) => l.startsWith("abort before activation"))).toBe(false);
    expect(
      lines.some((l) => l.includes("target still on top of the source after 30 frame(s)"))
    ).toBe(true);
  }, 15000);
});
