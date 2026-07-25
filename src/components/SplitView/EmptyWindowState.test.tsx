import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
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

/** Click the button carrying the given test id. */
function clickTestId(container: HTMLElement, testid: string): void {
  const btn = container.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement;
  act(() => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("EmptyWindowState (#1902)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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

  it("reveals the Connections sidebar when Open Connection is clicked", () => {
    const setSidebarView = vi.fn();
    // A non-connections view so the CTA action switches to Connections rather
    // than toggling an already-open panel closed.
    useAppStore.setState({ setSidebarView, sidebarView: "files", sidebarCollapsed: false });
    act(() => root.render(<EmptyWindowState />));

    clickTestId(container, "empty-window-open-connection");

    expect(setSidebarView).toHaveBeenCalledWith("connections");
  });

  it("expands a collapsed Connections sidebar rather than toggling it shut", () => {
    const setSidebarView = vi.fn();
    useAppStore.setState({ setSidebarView, sidebarView: "connections", sidebarCollapsed: true });
    act(() => root.render(<EmptyWindowState />));

    clickTestId(container, "empty-window-open-connection");

    // Already the active view but collapsed → still call to expand it.
    expect(setSidebarView).toHaveBeenCalledWith("connections");
  });

  it("does not collapse the Connections sidebar when it is already open", () => {
    const setSidebarView = vi.fn();
    useAppStore.setState({ setSidebarView, sidebarView: "connections", sidebarCollapsed: false });
    act(() => root.render(<EmptyWindowState />));

    clickTestId(container, "empty-window-open-connection");

    // Already showing Connections → do nothing (calling would toggle it shut).
    expect(setSidebarView).not.toHaveBeenCalled();
  });
});
