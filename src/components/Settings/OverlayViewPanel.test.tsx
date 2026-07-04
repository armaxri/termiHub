import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { OverlayViewPanel } from "./OverlayViewPanel";

// Mock storage and API modules (required by appStore + About/Update children)
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

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/api", () => ({
  getAppInfo: vi.fn(() => Promise.resolve({ version: "1.2.3", gitHash: "abcdef1" })),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  getDefaultShell: vi.fn(() => Promise.resolve(null)),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  listAgentDefinitions: vi.fn(() => Promise.resolve([])),
  getCredentialStoreStatus: vi.fn(() => Promise.resolve({ mode: "none", status: "unavailable" })),
  setUpdateAutoCheck: vi.fn(),
}));

vi.mock("@/services/tunnelApi", () => ({
  getTunnels: vi.fn(() => Promise.resolve([])),
  getTunnelStatuses: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

import { useAppStore } from "@/store/appStore";

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function renderPanel() {
  act(() => {
    root.render(<OverlayViewPanel />);
  });
}

describe("OverlayViewPanel", () => {
  beforeEach(() => {
    useAppStore.setState({ ...useAppStore.getInitialState() });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders nothing when no overlay view is active", () => {
    renderPanel();
    expect(query("overlay-view")).toBeNull();
  });

  it("renders the About view in a modal when active", () => {
    act(() => {
      useAppStore.setState({ overlayView: "about" });
    });
    renderPanel();

    expect(query("overlay-view")).not.toBeNull();
    expect(query("about-settings")).not.toBeNull();
  });

  it("closes the overlay when the modal close button is clicked", () => {
    act(() => {
      useAppStore.setState({ overlayView: "about" });
    });
    renderPanel();

    const closeBtn = query("modal-close");
    expect(closeBtn).not.toBeNull();
    act(() => {
      closeBtn!.click();
    });

    expect(useAppStore.getState().overlayView).toBeNull();
  });
});
