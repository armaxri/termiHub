/**
 * Tests for {@link useSidebarFollowsActiveTab} — the connection sidebar's
 * selection follows tab focus (#5642).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAppStore, getActiveTab } from "@/store/appStore";
import { getActivePanelId } from "@/store/layoutSelectors";
import { useSidebarFollowsActiveTab, revealConnectionRow } from "./useSidebarFollowsActiveTab";

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
});
