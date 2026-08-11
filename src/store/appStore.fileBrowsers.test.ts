/**
 * File-browser actions after the reducer removal (#2283) — the `appStore`
 * file-browser actions hold no local view slice: they do the async list op and
 * report each transition through granular `fileBrowser.*` intents against the
 * authoritative `file-browser` region. These tests prove that a run of the real
 * actions reconstructs the exact projected view a reader renders — the active pane,
 * the two panes, and the clipboard — for every action and its fan-out, with the
 * transitions overlaid synchronously (gap-free) and confirmed by the backend
 * substrate double.
 *
 * # Scope
 *
 * The per-pane list operations mirror only the browser *view* fields (path /
 * listing / list flags); the session model (`sessionFileBrowserId`) stays an
 * `appStore` field and is not part of the projected view.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  sessionListFiles: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  getConnectionTypes: vi.fn(() => Promise.resolve([])),
}));

import { useAppStore, type FileClipboard } from "./appStore";
import { localListDir, sessionListFiles } from "@/services/api";
import { currentFileBrowsersView } from "./fileBrowsersBridge";
import {
  fileBrowsersHarnessTransport,
  seedFileBrowsers,
  setupFileBrowsersRegion,
} from "@/test/fileBrowsersRegionTestHarness";
import type { FileEntry } from "@/types/connection";

function entry(name: string, isDirectory = false): FileEntry {
  return {
    name,
    path: `/${name}`,
    isDirectory,
    size: 0,
    modified: "",
    permissions: null,
    writable: null,
    isSymlink: false,
    symlinkTarget: null,
  };
}

setupFileBrowsersRegion();

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

const flush = () => Promise.resolve();

/** Assert the backend substrate view equals the projected view a reader renders. */
function expectParity() {
  expect(fileBrowsersHarnessTransport().regionView()).toEqual(currentFileBrowsersView());
}

describe("file-browser actions drive the authoritative region", () => {
  it("setFileBrowserMode reproduces the active pane", () => {
    useAppStore.getState().setFileBrowserMode("local");
    expect(fileBrowsersHarnessTransport().kinds()).toEqual(["fileBrowser.setMode"]);
    expect(currentFileBrowsersView().mode).toBe("local");
    expectParity();

    useAppStore.getState().setFileBrowserMode("none");
    expect(currentFileBrowsersView().mode).toBe("none");
    expectParity();
  });

  it("navigateLocal commits the pane path + listing", async () => {
    vi.mocked(localListDir).mockResolvedValue([entry("a"), entry("dir", true)]);

    await useAppStore.getState().navigateLocal("/home/user");
    await flush();

    expect(fileBrowsersHarnessTransport().kinds()).toEqual([
      "fileBrowser.loadStarted",
      "fileBrowser.loadSucceeded",
    ]);
    const view = currentFileBrowsersView();
    expect(view.local.path).toBe("/home/user");
    expect(view.local.entries.map((e) => e.name)).toEqual(["a", "dir"]);
    expect(view.local.loading).toBe(false);
    expectParity();
  });

  it("navigateLocal records the pane error on failure", async () => {
    vi.mocked(localListDir).mockRejectedValue(new Error("nope"));

    await useAppStore.getState().navigateLocal("/root");
    await flush();

    expect(fileBrowsersHarnessTransport().kinds()).toEqual([
      "fileBrowser.loadStarted",
      "fileBrowser.loadFailed",
    ]);
    expect(currentFileBrowsersView().local.error).toBe("nope");
    expect(currentFileBrowsersView().local.loading).toBe(false);
    expectParity();
  });

  it("refreshLocal re-lists the current local path from the region", async () => {
    vi.mocked(localListDir).mockResolvedValue([entry("x")]);
    await useAppStore.getState().navigateLocal("/tmp");
    vi.mocked(localListDir).mockResolvedValue([entry("x"), entry("y")]);

    await useAppStore.getState().refreshLocal();
    await flush();

    expect(currentFileBrowsersView().local.path).toBe("/tmp");
    expect(currentFileBrowsersView().local.entries.map((e) => e.name)).toEqual(["x", "y"]);
    expectParity();
  });

  it("navigateSession commits the session pane path + listing", async () => {
    vi.mocked(sessionListFiles).mockResolvedValue([entry("s")]);

    await useAppStore.getState().navigateSession("sess-1", "/srv");
    await flush();

    expect(fileBrowsersHarnessTransport().kinds()).toEqual([
      "fileBrowser.loadStarted",
      "fileBrowser.loadSucceeded",
    ]);
    expect(currentFileBrowsersView().session.path).toBe("/srv");
    expect(currentFileBrowsersView().session.entries.map((e) => e.name)).toEqual(["s"]);
    expectParity();
  });

  it("navigateSession records the session pane error on failure", async () => {
    vi.mocked(sessionListFiles).mockRejectedValue(new Error("denied"));

    await useAppStore.getState().navigateSession("sess-1", "/srv");
    await flush();

    expect(currentFileBrowsersView().session.error).toBe("denied");
    expectParity();
  });

  it("refreshSession re-lists the current session path (id from appStore, path from region)", async () => {
    useAppStore.setState({ sessionFileBrowserId: "sess-1" });
    seedFileBrowsers({ session: { path: "/srv", entries: [], loading: false, error: null } });
    vi.mocked(sessionListFiles).mockResolvedValue([entry("s"), entry("t")]);

    await useAppStore.getState().refreshSession();
    await flush();

    expect(vi.mocked(sessionListFiles)).toHaveBeenCalledWith("sess-1", "/srv");
    expect(currentFileBrowsersView().session.entries.map((e) => e.name)).toEqual(["s", "t"]);
    expectParity();
  });

  it("refreshSession is a no-op when there is no session file-browser id", async () => {
    useAppStore.setState({ sessionFileBrowserId: null });
    await useAppStore.getState().refreshSession();
    expect(vi.mocked(sessionListFiles)).not.toHaveBeenCalled();
    expect(fileBrowsersHarnessTransport().kinds()).toEqual([]);
  });

  it("setFileClipboard sets then clears the clipboard", () => {
    const clipboard: FileClipboard = {
      entries: [entry("c")],
      operation: "copy",
      sourceMode: "local",
      sourcePath: "/home",
    };

    useAppStore.getState().setFileClipboard(clipboard);
    expect(fileBrowsersHarnessTransport().kinds()).toEqual(["fileBrowser.setClipboard"]);
    expect(currentFileBrowsersView().clipboard).toEqual(clipboard);
    expectParity();

    useAppStore.getState().setFileClipboard(null);
    expect(currentFileBrowsersView().clipboard).toBeNull();
    expectParity();
  });

  it("a full browser lifecycle stays in parity across every step", async () => {
    vi.mocked(localListDir).mockResolvedValue([entry("a")]);
    vi.mocked(sessionListFiles).mockResolvedValue([entry("s")]);

    useAppStore.getState().setFileBrowserMode("local");
    expectParity();
    await useAppStore.getState().navigateLocal("/home");
    await flush();
    expectParity();
    useAppStore.getState().setFileBrowserMode("session");
    expectParity();
    await useAppStore.getState().navigateSession("sess-1", "/srv");
    await flush();
    expectParity();
    useAppStore.getState().setFileClipboard({
      entries: [entry("a")],
      operation: "cut",
      sourceMode: "local",
      sourcePath: "/home",
    });
    expectParity();
    useAppStore.getState().setFileClipboard(null);
    expectParity();
    useAppStore.getState().setFileBrowserMode("none");
    expectParity();
  });
});
