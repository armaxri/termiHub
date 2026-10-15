/**
 * Tests for F6 / Shift+F6 landmark cycling (#4773).
 *
 * The shell is rebuilt as plain DOM with the same landmark elements and class
 * names the real components render (`nav.activity-bar`, `aside.sidebar`,
 * `main.terminal-view`, `footer.status-bar`), so the cycle order, skipping and
 * per-region focus target are exercised without mounting the whole app.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const store = vi.hoisted(() => ({
  activeTab: null as { id: string; contentType: string } | null,
  activePanelId: null as string | null,
}));

vi.mock("@/store/appStore", () => ({
  useAppStore: { getState: () => ({}) },
  getActiveTab: () => store.activeTab,
}));

vi.mock("@/store/layoutSelectors", () => ({
  getActivePanelId: () => store.activePanelId,
}));

import { cycleLandmarkFocus, focusLandmarkRegion } from "./landmarkFocus";

interface ShellOptions {
  activityBar?: boolean;
  sidebar?: boolean;
  statusBar?: boolean;
}

/** Build a shell fixture; omitted regions model a hidden/collapsed region. */
function renderShell({ activityBar = true, sidebar = true, statusBar = true }: ShellOptions = {}) {
  document.body.innerHTML = `
    ${
      activityBar
        ? `<nav class="activity-bar" aria-label="Activity bar">
             <button id="ab-connections" class="activity-bar__item">Connections</button>
             <button id="ab-files" class="activity-bar__item activity-bar__item--active">Files</button>
           </nav>`
        : ""
    }
    ${
      sidebar
        ? `<aside class="sidebar" aria-label="File Browser">
             <span class="sidebar__title">File Browser</span>
             <input id="sidebar-search" />
           </aside>`
        : ""
    }
    <main class="terminal-view">
      <button id="toolbar-broadcast">Broadcast</button>
      <div class="split-view-group split-view-group--active">
        <div data-testid="panel-content-p1">
          <div id="tab-p1" role="tab" aria-selected="true" tabindex="0">Shell 1</div>
        </div>
        <div data-testid="panel-content-p2">
          <div id="tab-p2" role="tab" aria-selected="true" tabindex="0">Shell 2</div>
          <div class="xterm"><textarea id="xterm-p2"></textarea></div>
        </div>
      </div>
    </main>
    ${
      statusBar
        ? `<footer class="status-bar" aria-label="Status bar">
             <span>idle</span>
             <button id="status-window">Window 1</button>
           </footer>`
        : ""
    }
    <button id="outside">outside</button>
  `;
}

const byId = (id: string) => document.getElementById(id) as HTMLElement;
const activeId = () => (document.activeElement as HTMLElement | null)?.id;

describe("cycleLandmarkFocus", () => {
  beforeEach(() => {
    store.activeTab = null;
    store.activePanelId = null;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("moves forward through the regions in order and wraps around", () => {
    renderShell();
    byId("ab-files").focus();

    expect(cycleLandmarkFocus(1)).toBe("sidebar");
    expect(activeId()).toBe("sidebar-search");
    expect(cycleLandmarkFocus(1)).toBe("terminal");
    expect(cycleLandmarkFocus(1)).toBe("status-bar");
    expect(activeId()).toBe("status-window");
    expect(cycleLandmarkFocus(1)).toBe("activity-bar");
    expect(activeId()).toBe("ab-files");
  });

  it("moves backward through the regions in reverse and wraps around", () => {
    renderShell();
    byId("ab-files").focus();

    expect(cycleLandmarkFocus(-1)).toBe("status-bar");
    expect(cycleLandmarkFocus(-1)).toBe("terminal");
    expect(cycleLandmarkFocus(-1)).toBe("sidebar");
    expect(cycleLandmarkFocus(-1)).toBe("activity-bar");
    expect(cycleLandmarkFocus(-1)).toBe("status-bar");
  });

  it("starts at the first region forward and the last backward from outside", () => {
    renderShell();
    byId("outside").focus();
    expect(cycleLandmarkFocus(1)).toBe("activity-bar");

    byId("outside").focus();
    expect(cycleLandmarkFocus(-1)).toBe("status-bar");
  });

  it("skips a collapsed sidebar", () => {
    renderShell({ sidebar: false });
    byId("ab-files").focus();

    expect(cycleLandmarkFocus(1)).toBe("terminal");
    expect(cycleLandmarkFocus(-1)).toBe("activity-bar");
  });

  it("skips a hidden activity bar and status bar", () => {
    renderShell({ activityBar: false, statusBar: false });
    byId("sidebar-search").focus();

    expect(cycleLandmarkFocus(1)).toBe("terminal");
    expect(cycleLandmarkFocus(1)).toBe("sidebar");
  });

  it("skips a region with nothing focusable", () => {
    renderShell();
    byId("status-window").remove();
    byId("toolbar-broadcast").focus();

    expect(cycleLandmarkFocus(1)).toBe("activity-bar");
  });

  it("does nothing while focus is inside a modal dialog", () => {
    renderShell();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const input = document.createElement("input");
    dialog.appendChild(input);
    document.body.appendChild(dialog);
    input.focus();

    expect(cycleLandmarkFocus(1)).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("does nothing when no landmark is rendered", () => {
    document.body.innerHTML = `<button id="lonely">x</button>`;
    byId("lonely").focus();
    expect(cycleLandmarkFocus(1)).toBeNull();
  });
});

describe("focusLandmarkRegion", () => {
  beforeEach(() => {
    store.activeTab = null;
    store.activePanelId = null;
    renderShell();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  const root = (selector: string) => document.querySelector(selector) as Element;

  it("focuses the active activity-bar item", () => {
    expect(focusLandmarkRegion("activity-bar", root("nav.activity-bar"))).toBe(true);
    expect(activeId()).toBe("ab-files");
  });

  it("falls back to the first activity-bar item when none is active", () => {
    byId("ab-files").classList.remove("activity-bar__item--active");
    focusLandmarkRegion("activity-bar", root("nav.activity-bar"));
    expect(activeId()).toBe("ab-connections");
  });

  it("focuses the sidebar's first focusable control", () => {
    focusLandmarkRegion("sidebar", root("aside.sidebar"));
    expect(activeId()).toBe("sidebar-search");
  });

  it("focuses the status bar's first focusable control", () => {
    focusLandmarkRegion("status-bar", root("footer.status-bar"));
    expect(activeId()).toBe("status-window");
  });

  it("asks the active terminal to take focus", () => {
    store.activeTab = { id: "tab-2", contentType: "terminal" };
    const onFocus = vi.fn((e: Event) => {
      expect((e as CustomEvent<{ tabId: string }>).detail.tabId).toBe("tab-2");
      byId("xterm-p2").focus();
    });
    window.addEventListener("termihub:focus-terminal", onFocus);
    try {
      expect(focusLandmarkRegion("terminal", root("main.terminal-view"))).toBe(true);
    } finally {
      window.removeEventListener("termihub:focus-terminal", onFocus);
    }
    expect(onFocus).toHaveBeenCalledOnce();
    expect(activeId()).toBe("xterm-p2");
  });

  it("focuses the active panel's selected tab when the active tab is not a terminal", () => {
    store.activeTab = { id: "settings", contentType: "settings" };
    store.activePanelId = "p2";
    focusLandmarkRegion("terminal", root("main.terminal-view"));
    expect(activeId()).toBe("tab-p2");
  });

  it("falls back to the first selected tab without an active panel", () => {
    focusLandmarkRegion("terminal", root("main.terminal-view"));
    expect(activeId()).toBe("tab-p1");
  });
});
