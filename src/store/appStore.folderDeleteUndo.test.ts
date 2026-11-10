/**
 * `deleteFolderWithUndo` (#5158): the folder disappears at once (children move
 * up to its parent), but the backend delete waits out the 10 s undo window, so
 * Undo restores the folder and its children's parent exactly, with no write.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { toastMock } = vi.hoisted(() => ({
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), loading: vi.fn() },
}));

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("@/components/ui", async (orig) => ({
  ...(await orig<typeof import("@/components/ui")>()),
  toast: toastMock,
}));

import { useAppStore } from "./appStore";
import { currentConnectionsView } from "./connectionsBridge";
import { removeFolder } from "@/services/storage";
import { UNDO_WINDOW_MS, flushPendingDeletes } from "@/utils/undoableDelete";
import type { ConnectionFolder, SavedConnection } from "@/types/connection";
import { seedConnectionsRegion, setupConnectionsRegion } from "@/test/connectionsHarness";

setupConnectionsRegion();

const parent: ConnectionFolder = { id: "Work", name: "Work", parentId: null, isExpanded: true };
const target: ConnectionFolder = {
  id: "Work/Dev",
  name: "Dev",
  parentId: "Work",
  isExpanded: false,
  iconColor: "blue",
};
const sub: ConnectionFolder = {
  id: "Work/Dev/Db",
  name: "Db",
  parentId: "Work/Dev",
  isExpanded: true,
};
const conn: SavedConnection = {
  id: "Work/Dev/api",
  name: "api",
  config: { type: "local", config: { shell: "bash" } },
  folderId: "Work/Dev",
};

function undo(): void {
  const opts = toastMock.success.mock.calls[0][1] as {
    action: { label: string; onClick: () => void };
    duration: number;
  };
  expect(opts.action.label).toBe("Undo");
  expect(opts.duration).toBe(UNDO_WINDOW_MS);
  opts.action.onClick();
}

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("appStore — deleteFolderWithUndo (#5158)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState(useAppStore.getInitialState());
    vi.mocked(removeFolder).mockReset();
    vi.mocked(removeFolder).mockResolvedValue(undefined);
    Object.values(toastMock).forEach((m) => m.mockClear());
    seedConnectionsRegion({ folders: [parent, target, sub], connections: [conn] });
  });

  afterEach(async () => {
    await flushPendingDeletes();
    await settle();
    vi.useRealTimers();
  });

  it("hides the folder at once, moving its children to its parent", () => {
    useAppStore.getState().deleteFolderWithUndo("Work/Dev");
    const view = currentConnectionsView();
    expect(view.folders.map((f) => f.id)).toEqual(["Work", "Work/Dev/Db"]);
    expect(view.folders.find((f) => f.id === "Work/Dev/Db")?.parentId).toBe("Work");
    expect(view.connections[0].folderId).toBe("Work");
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringContaining("Dev"),
      expect.anything()
    );
    expect(removeFolder).not.toHaveBeenCalled();
  });

  it("commits the delete when the undo window ends", async () => {
    useAppStore.getState().deleteFolderWithUndo("Work/Dev");
    vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    expect(removeFolder).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(removeFolder).toHaveBeenCalledWith("Work/Dev");
  });

  it("Undo restores the folder and its children exactly, writing nothing", async () => {
    useAppStore.getState().deleteFolderWithUndo("Work/Dev");
    undo();
    await settle();

    const view = currentConnectionsView();
    expect(view.folders).toEqual([parent, target, sub]);
    expect(view.connections).toEqual([conn]);
    vi.advanceTimersByTime(UNDO_WINDOW_MS * 2);
    expect(removeFolder).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(toastMock.success).toHaveBeenLastCalledWith(expect.stringContaining("Restored"));
  });

  it("reports an Undo that came too late", async () => {
    useAppStore.getState().deleteFolderWithUndo("Work/Dev");
    vi.advanceTimersByTime(UNDO_WINDOW_MS);
    undo();
    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining("already deleted"));
  });

  it("toasts a failed commit", async () => {
    vi.mocked(removeFolder).mockRejectedValueOnce(new Error("busy"));
    useAppStore.getState().deleteFolderWithUndo("Work/Dev");
    vi.advanceTimersByTime(UNDO_WINDOW_MS);
    await vi.waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to delete folder: busy")
      )
    );
  });

  it("is a no-op for an unknown folder", () => {
    useAppStore.getState().deleteFolderWithUndo("nope");
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
