import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { SavedConnection } from "@/types/connection";
import { EmptyWindowState } from "./EmptyWindowState";

// Standard mocks required when importing useAppStore.
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

// The empty-window CTA branches on the live saved-connection count and the
// number of open native windows; drive both through configurable hook mocks so
// each test controls the first-run vs. returning-user and single- vs. multi-
// window cases without a real bridge or window registry.
let mockConnections: SavedConnection[] = [];
let mockWindowCount = 1;

vi.mock("@/store/useProjectedConnections", () => ({
  useProjectedConnections: () => ({ connections: mockConnections, folders: [] }),
}));

vi.mock("@/hooks/useWindowInfo", () => ({
  useWindowInfo: () => ({ label: "main", name: "Main Window", count: mockWindowCount }),
}));

/** A throwaway saved connection — only its presence (list length) matters here. */
function fakeConnection(): SavedConnection {
  return { id: "c1", name: "box" } as unknown as SavedConnection;
}

/** Click the button carrying the given test id. */
function clickTestId(container: HTMLElement, testid: string): void {
  const btn = container.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement;
  act(() => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("EmptyWindowState (#1902, UX-003)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockConnections = [];
    mockWindowCount = 1;
    useAppStore.setState(useAppStore.getInitialState());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the empty-window call-to-action", () => {
    act(() => root.render(<EmptyWindowState />));
    expect(container.querySelector('[data-testid="empty-window-state"]')).not.toBeNull();
    expect(container.textContent).toContain("This window is empty");
    expect(container.querySelector('[data-testid="empty-window-new-terminal"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="empty-window-open-connection"]')).not.toBeNull();
  });

  it("launches a local shell into this window via New Terminal", () => {
    const addTab = vi.fn();
    useAppStore.setState({ addTab });
    act(() => root.render(<EmptyWindowState />));

    clickTestId(container, "empty-window-new-terminal");

    expect(addTab).toHaveBeenCalledWith("Terminal", "local");
  });

  it("opens a connection picker (command palette) when saved connections exist", () => {
    mockConnections = [fakeConnection()];
    const setCommandPaletteOpen = vi.fn();
    const openConnectionEditorTab = vi.fn();
    useAppStore.setState({ setCommandPaletteOpen, openConnectionEditorTab });
    act(() => root.render(<EmptyWindowState />));

    clickTestId(container, "empty-window-open-connection");

    // With ≥1 saved connection the CTA opens the palette to pick one — it does
    // not just reveal a sidebar and does not open the new-connection editor.
    expect(setCommandPaletteOpen).toHaveBeenCalledWith(true);
    expect(openConnectionEditorTab).not.toHaveBeenCalled();
  });

  it("routes to the new-connection editor when there are zero connections", () => {
    mockConnections = [];
    const setCommandPaletteOpen = vi.fn();
    const openConnectionEditorTab = vi.fn();
    useAppStore.setState({ setCommandPaletteOpen, openConnectionEditorTab });
    act(() => root.render(<EmptyWindowState />));

    clickTestId(container, "empty-window-open-connection");

    // First-run user with no connections → straight to the create flow, not a
    // blank picker or panel.
    expect(openConnectionEditorTab).toHaveBeenCalledWith("new");
    expect(setCommandPaletteOpen).not.toHaveBeenCalled();
  });

  it("shows first-run copy (not the multi-window hint) for a single empty window", () => {
    mockConnections = [];
    mockWindowCount = 1;
    act(() => root.render(<EmptyWindowState />));

    // First-run guidance, and no power-user multi-window instruction.
    expect(container.textContent).toContain("create a connection");
    expect(container.textContent).not.toContain("Move to Window");
  });

  it("surfaces the multi-window hint only when more than one window is open", () => {
    mockWindowCount = 2;
    act(() => root.render(<EmptyWindowState />));

    expect(container.textContent).toContain("Move to Window");
  });
});
