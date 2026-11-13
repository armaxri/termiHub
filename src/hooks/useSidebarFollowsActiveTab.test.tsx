/**
 * Tests for {@link useSidebarFollowsActiveTab} — the connection sidebar's
 * selection follows tab focus (#5642).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAppStore, getActiveTab } from "@/store/appStore";
import { getActivePanelId } from "@/store/layoutSelectors";
import {
  useSidebarFollowsActiveTab,
  revealConnectionRow,
  connectionAncestorFolderIds,
} from "./useSidebarFollowsActiveTab";

const LOCAL = { type: "local", config: {} };

function addTab(title: string, connectionId?: string): string {
  return useAppStore.getState().addTab(title, "local", LOCAL, connectionId ? { connectionId } : {});
}

function activate(tabId: string): void {
  act(() => useAppStore.getState().setActiveTab(tabId, getActivePanelId() as string));
}

const mounted: Root[] = [];

/** Minimal renderHook: mount a probe component calling `hook` on every render. */
function renderHook(hook: () => void): { rerender: () => void } {
  const root = createRoot(document.createElement("div"));
  mounted.push(root);
  function Probe() {
    hook();
    return null;
  }
  act(() => root.render(<Probe />));
  return { rerender: () => act(() => root.render(<Probe />)) };
}

describe("useSidebarFollowsActiveTab", () => {
  const known = new Set(["conn-a", "conn-b"]);
  const isKnown = (id: string) => known.has(id);
  let selectSingle: ReturnType<typeof vi.fn<(id: string) => void>>;
  let reveal: ReturnType<typeof vi.fn<(id: string) => void>>;

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    selectSingle = vi.fn<(id: string) => void>();
    reveal = vi.fn<(id: string) => void>();
  });

  afterEach(() => {
    for (const root of mounted.splice(0)) act(() => root.unmount());
  });

  it("selects and reveals the active tab's connection on mount", () => {
    act(() => {
      addTab("A", "conn-a");
    });
    renderHook(() => useSidebarFollowsActiveTab(isKnown, selectSingle, reveal));
    expect(selectSingle).toHaveBeenCalledWith("conn-a");
    expect(reveal).toHaveBeenCalledWith("conn-a");
  });

  it("follows a tab switch to another connection", () => {
    let tabA = "";
    act(() => {
      tabA = addTab("A", "conn-a");
      addTab("B", "conn-b");
    });
    renderHook(() => useSidebarFollowsActiveTab(isKnown, selectSingle, reveal));
    expect(selectSingle).toHaveBeenLastCalledWith("conn-b");
    activate(tabA);
    expect(getActiveTab(useAppStore.getState())?.id).toBe(tabA);
    expect(selectSingle).toHaveBeenLastCalledWith("conn-a");
  });

  it("does not re-apply the selection while the active tab is unchanged", () => {
    act(() => {
      addTab("A", "conn-a");
    });
    const { rerender } = renderHook(() =>
      useSidebarFollowsActiveTab((id) => known.has(id), selectSingle, reveal)
    );
    rerender();
    rerender();
    expect(selectSingle).toHaveBeenCalledTimes(1);
  });

  it("leaves the selection alone for tabs without a saved connection", () => {
    act(() => {
      addTab("shell");
    });
    renderHook(() => useSidebarFollowsActiveTab(isKnown, selectSingle, reveal));
    expect(selectSingle).not.toHaveBeenCalled();
  });

  it("waits for an unknown connection to appear in the sidebar", () => {
    act(() => {
      addTab("C", "conn-c");
    });
    let ids = new Set<string>();
    const { rerender } = renderHook(() =>
      useSidebarFollowsActiveTab((id) => ids.has(id), selectSingle, reveal)
    );
    expect(selectSingle).not.toHaveBeenCalled();
    ids = new Set(["conn-c"]);
    rerender();
    expect(selectSingle).toHaveBeenCalledWith("conn-c");
  });
});

describe("revealConnectionRow", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("scrolls the matching row into view", () => {
    const row = document.createElement("button");
    row.setAttribute("data-testid", 'connection-item-Lab/"x"');
    const scroll = vi.fn();
    row.scrollIntoView = scroll;
    document.body.appendChild(row);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    revealConnectionRow('Lab/"x"');
    vi.unstubAllGlobals();
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
  });

  /** Run the deferred reveal synchronously. */
  function syncFrames(): void {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  }

  function addRow(testId: string): ReturnType<typeof vi.fn> {
    const row = document.createElement("button");
    row.setAttribute("data-testid", testId);
    const scroll = vi.fn();
    row.scrollIntoView = scroll;
    document.body.appendChild(row);
    return scroll;
  }

  it("falls back to the deepest rendered ancestor folder (#5706)", () => {
    const outer = addRow("folder-toggle-outer");
    const inner = addRow("folder-toggle-inner");
    syncFrames();
    revealConnectionRow("hidden", ["outer", "inner", "missing"]);
    vi.unstubAllGlobals();
    expect(inner).toHaveBeenCalledWith({ block: "nearest" });
    expect(outer).not.toHaveBeenCalled();
  });

  it("prefers the connection row over its folders", () => {
    const folder = addRow("folder-toggle-f");
    const row = addRow("connection-item-c");
    syncFrames();
    revealConnectionRow("c", ["f"]);
    vi.unstubAllGlobals();
    expect(row).toHaveBeenCalled();
    expect(folder).not.toHaveBeenCalled();
  });
});

describe("connectionAncestorFolderIds", () => {
  const folders = [
    { id: "root", parentId: null },
    { id: "mid", parentId: "root" },
    { id: "leaf", parentId: "mid" },
    { id: "loop-a", parentId: "loop-b" },
    { id: "loop-b", parentId: "loop-a" },
  ];
  const connections = [
    { id: "deep", folderId: "leaf" },
    { id: "top", folderId: null },
    { id: "cyclic", folderId: "loop-a" },
  ];

  it("lists the enclosing folders root first", () => {
    expect(connectionAncestorFolderIds("deep", connections, folders)).toEqual([
      "root",
      "mid",
      "leaf",
    ]);
  });

  it("is empty for a root-level, unknown or missing connection", () => {
    expect(connectionAncestorFolderIds("top", connections, folders)).toEqual([]);
    expect(connectionAncestorFolderIds("nope", connections, folders)).toEqual([]);
    expect(connectionAncestorFolderIds(null, connections, folders)).toEqual([]);
  });

  it("stops on a malformed parent cycle", () => {
    expect(connectionAncestorFolderIds("cyclic", connections, folders)).toEqual([
      "loop-b",
      "loop-a",
    ]);
  });
});
