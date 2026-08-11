/**
 * `useProjectedFileBrowsers` (#2228 / #2283) — the file-browser panel reads the
 * **authoritative** client-scoped `file-browser@<clientId>` region. Drives the hook
 * against the region test harness and asserts it renders the seeded view, reflects a
 * subsequent mutation synchronously (optimistic overlay), and returns the empty
 * baseline before any diff. There is no appStore fallback and no flag.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "@/store/appStore";
import type { FileEntry } from "@/types/connection";

import { EMPTY_FILE_BROWSERS_VIEW, type FileBrowsersView } from "./fileBrowsersBridge";
import { useProjectedFileBrowsers } from "./useProjectedFileBrowsers";
import { seedFileBrowsers, setupFileBrowsersRegion } from "@/test/fileBrowsersRegionTestHarness";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  getSettings: vi.fn(() =>
    Promise.resolve({ version: "1", externalConnectionFiles: [], powerMonitoringEnabled: true })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn(() => vi.fn()) }));

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

/** Render the hook into a throwaway component, exposing the latest return value. */
function renderHook(): { get: () => FileBrowsersView; unmount: () => void } {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  let latest: FileBrowsersView = { ...EMPTY_FILE_BROWSERS_VIEW };

  function Probe() {
    latest = useProjectedFileBrowsers();
    return null;
  }

  act(() => root.render(<Probe />));
  return { get: () => latest, unmount: () => act(() => root.unmount()) };
}

const flush = () => act(async () => await Promise.resolve());

setupFileBrowsersRegion();

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
});

describe("useProjectedFileBrowsers", () => {
  it("renders the seeded region view", async () => {
    seedFileBrowsers({ mode: "local", local: { path: "/home", entries: [entry("a")] } });

    const hook = renderHook();
    await flush();

    expect(hook.get().mode).toBe("local");
    expect(hook.get().local.path).toBe("/home");
    expect(hook.get().local.entries).toEqual([entry("a")]);
    hook.unmount();
  });

  it("reflects a subsequent mutation synchronously (optimistic overlay)", async () => {
    seedFileBrowsers({ mode: "local", local: { path: "/home", entries: [] } });
    const hook = renderHook();
    await flush();

    act(() => {
      useAppStore.getState().setFileBrowserMode("session");
    });

    expect(hook.get().mode).toBe("session");
    hook.unmount();
  });

  it("returns the empty baseline before any region view arrives", async () => {
    const hook = renderHook();
    await flush();

    expect(hook.get()).toEqual(EMPTY_FILE_BROWSERS_VIEW);
    hook.unmount();
  });
});
