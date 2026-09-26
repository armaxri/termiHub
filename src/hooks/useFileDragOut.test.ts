/**
 * Drag-out of file-browser rows to the OS file manager (#3457): the native drag
 * command is mocked, so these cover the decision + staging logic — local paths
 * go straight to the native drag, remote files are staged through the transfer
 * queue first, the staged copies are reused, and failures are cleaned up.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FileEntry } from "@/types/connection";
import type { DragOutControl } from "@/components/Sidebar/FileBrowserDndProvider";
import { flushAsync } from "@/test/flushAsync";
import { isOwnDragOut, resetDragOutTracking, stagedDragOutCache } from "@/utils/fileDragOut";
import { useFileDragOut } from "./useFileDragOut";
import type { DragOutSource } from "@/utils/fileDragOut";

const api = vi.hoisted(() => ({
  dragOutCreateStaging: vi.fn(),
  dragOutDiscardStaging: vi.fn(),
  dragOutStart: vi.fn(),
  sessionDownload: vi.fn(),
}));

vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return { ...actual, ...api };
});

const seed = vi.hoisted(() => vi.fn());
vi.mock("./transferFeedback", async () => {
  const actual = await vi.importActual<typeof import("./transferFeedback")>("./transferFeedback");
  return { ...actual, seedTransferQueueRow: seed };
});

const toasts = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  loading: vi.fn(() => "toast-id"),
  dismiss: vi.fn(),
}));
vi.mock("@/components/ui/Toast", async () => {
  const actual =
    await vi.importActual<typeof import("@/components/ui/Toast")>("@/components/ui/Toast");
  return { ...actual, toast: toasts };
});

function entry(path: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    name: path.split("/").pop() ?? path,
    path,
    isDirectory: false,
    size: 42,
    modified: "2026-09-01T00:00:00Z",
    permissions: null,
    writable: null,
    ...overrides,
  };
}

function control(stillDragging = true): DragOutControl & {
  cancelInAppDrag: ReturnType<typeof vi.fn<() => void>>;
} {
  return { isStillDragging: vi.fn(() => stillDragging), cancelInAppDrag: vi.fn<() => void>() };
}

type Handler = ReturnType<typeof useFileDragOut>;
const roots: Root[] = [];

/** Mount the hook in a throwaway component and return its drag-out handler. */
function mountDragOut(source: DragOutSource): Handler {
  let handler: Handler | undefined;
  function Harness() {
    handler = useFileDragOut(source);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  act(() => root.render(createElement(Harness)));
  if (!handler) throw new Error("hook did not render");
  return handler;
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

const SFTP = { mode: "session", sessionId: "sess-1", transferQueueCapable: true } as const;

beforeEach(() => {
  vi.clearAllMocks();
  resetDragOutTracking();
  stagedDragOutCache.takeAll();
  api.dragOutStart.mockResolvedValue("dropped");
  api.dragOutDiscardStaging.mockResolvedValue(undefined);
  api.dragOutCreateStaging.mockImplementation(async (names: string[]) => ({
    dir: "/cache/drag-out/1",
    paths: names.map((n) => `/cache/drag-out/1/${n}`),
  }));
  api.sessionDownload.mockImplementation(
    async (_s: string, _r: string, _l: string, onRegistered?: (id: string) => void) => {
      onRegistered?.("t-1");
      return 42;
    }
  );
});

describe("useFileDragOut — local pane", () => {
  it("starts the native drag with the real paths and ends the in-app drag", async () => {
    const dragOut = mountDragOut({ mode: "local" });
    const ctl = control();
    let ownDuringDrag = false;
    api.dragOutStart.mockImplementation(async (paths: string[]) => {
      ownDuringDrag = isOwnDragOut(paths);
      return "dropped";
    });

    dragOut([entry("/home/u/a.txt"), entry("/home/u/dir", { isDirectory: true })], ctl);
    await flushAsync();

    expect(ctl.cancelInAppDrag).toHaveBeenCalledTimes(1);
    expect(api.dragOutStart).toHaveBeenCalledWith(["/home/u/a.txt", "/home/u/dir"]);
    expect(ownDuringDrag).toBe(true);
    expect(api.sessionDownload).not.toHaveBeenCalled();
    expect(api.dragOutCreateStaging).not.toHaveBeenCalled();
  });

  it("reports a native drag failure", async () => {
    api.dragOutStart.mockRejectedValue(new Error("no window"));
    const dragOut = mountDragOut({ mode: "local" });
    dragOut([entry("/a")], control());
    await flushAsync();
    expect(toasts.error).toHaveBeenCalledWith(expect.stringContaining("no window"));
  });
});

describe("useFileDragOut — remote (SFTP / FTP) pane", () => {
  it("stages through the transfer queue, then drags the local copies while still held", async () => {
    const dragOut = mountDragOut(SFTP);
    const ctl = control(true);
    dragOut([entry("/srv/a.txt"), entry("/srv/b.txt")], ctl);
    await flushAsync();

    expect(api.dragOutCreateStaging).toHaveBeenCalledWith(["a.txt", "b.txt"]);
    expect(api.sessionDownload).toHaveBeenCalledWith(
      "sess-1",
      "/srv/a.txt",
      "/cache/drag-out/1/a.txt",
      expect.any(Function)
    );
    expect(api.sessionDownload).toHaveBeenCalledWith(
      "sess-1",
      "/srv/b.txt",
      "/cache/drag-out/1/b.txt",
      expect.any(Function)
    );
    // Each staging download is a tracked Transfer Queue row (progress/cancel).
    expect(seed).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        direction: "download",
        remotePath: "/srv/a.txt",
      })
    );
    expect(ctl.cancelInAppDrag).toHaveBeenCalled();
    expect(api.dragOutStart).toHaveBeenCalledWith([
      "/cache/drag-out/1/a.txt",
      "/cache/drag-out/1/b.txt",
    ]);
  });

  it("says the files are ready when the pointer was released, then reuses the staged copy", async () => {
    const dragOut = mountDragOut(SFTP);
    const file = entry("/srv/a.txt");

    dragOut([file], control(false));
    await flushAsync();
    expect(api.dragOutStart).not.toHaveBeenCalled();
    expect(toasts.success).toHaveBeenCalledWith(expect.stringMatching(/ready.*drag.*again/i));

    const second = control(true);
    dragOut([file], second);
    await flushAsync();
    expect(api.sessionDownload).toHaveBeenCalledTimes(1);
    expect(second.cancelInAppDrag).toHaveBeenCalled();
    expect(api.dragOutStart).toHaveBeenCalledWith(["/cache/drag-out/1/a.txt"]);
  });

  it("downloads again when the remote file changed since staging", async () => {
    const dragOut = mountDragOut(SFTP);
    dragOut([entry("/srv/a.txt")], control(false));
    await flushAsync();
    dragOut([entry("/srv/a.txt", { size: 43 })], control(false));
    await flushAsync();
    expect(api.sessionDownload).toHaveBeenCalledTimes(2);
  });

  it("discards the staging dir and reports when a download fails", async () => {
    api.sessionDownload.mockRejectedValue(new Error("permission denied"));
    const dragOut = mountDragOut(SFTP);
    dragOut([entry("/srv/secret")], control(true));
    await flushAsync();

    expect(api.dragOutDiscardStaging).toHaveBeenCalledWith("/cache/drag-out/1");
    expect(toasts.error).toHaveBeenCalledWith(
      expect.stringContaining("permission denied"),
      expect.anything()
    );
    expect(api.dragOutStart).not.toHaveBeenCalled();
    expect(stagedDragOutCache.size).toBe(0);
  });

  it("refuses remote folders and byte-based sessions without touching the backend", async () => {
    const folder = mountDragOut(SFTP);
    folder([entry("/srv/logs", { isDirectory: true })], control());
    const docker = mountDragOut({ ...SFTP, transferQueueCapable: false });
    docker([entry("/srv/a.txt")], control());
    await flushAsync();

    expect(toasts.info).toHaveBeenCalledTimes(2);
    expect(api.dragOutCreateStaging).not.toHaveBeenCalled();
    expect(api.dragOutStart).not.toHaveBeenCalled();
  });
});
