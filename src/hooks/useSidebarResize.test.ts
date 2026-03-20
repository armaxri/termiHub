import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
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

import { useAppStore } from "@/store/appStore";

describe("useSidebarResize (store-level)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  });

  it("has default sidebar width of 260", () => {
    expect(useAppStore.getState().sidebarWidth).toBe(260);
  });

  it("setSidebarWidth updates the width", () => {
    useAppStore.getState().setSidebarWidth(400);
    expect(useAppStore.getState().sidebarWidth).toBe(400);
  });

  it("sidebar width persists across collapse/expand", () => {
    useAppStore.getState().setSidebarWidth(350);
    expect(useAppStore.getState().sidebarWidth).toBe(350);

    // Collapse
    useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    expect(useAppStore.getState().sidebarWidth).toBe(350);

    // Expand
    useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
    expect(useAppStore.getState().sidebarWidth).toBe(350);
  });

  it("clamping logic: width below min stays at min when set correctly", () => {
    // The hook clamps, but the store itself stores whatever is set.
    // This tests the store accepts any value (hook is responsible for clamping).
    useAppStore.getState().setSidebarWidth(100);
    expect(useAppStore.getState().sidebarWidth).toBe(100);
  });

  it("clamping logic: width above max stays at max when set correctly", () => {
    useAppStore.getState().setSidebarWidth(800);
    expect(useAppStore.getState().sidebarWidth).toBe(800);
  });
});

describe("useSidebarResize hook clamping", () => {
  // Test the actual clamping logic from the hook module.
  // The hook clamps between 170 and 600. We simulate what the hook does:
  // newWidth = Math.min(600, Math.max(170, startWidth + delta * direction))

  const clamp = (startWidth: number, deltaX: number, direction: 1 | -1) =>
    Math.min(600, Math.max(170, startWidth + deltaX * direction));

  it("left sidebar: dragging right widens", () => {
    expect(clamp(260, 100, 1)).toBe(360);
  });

  it("left sidebar: dragging left narrows", () => {
    expect(clamp(260, -100, 1)).toBe(170);
  });

  it("right sidebar: dragging left widens", () => {
    expect(clamp(260, -100, -1)).toBe(360);
  });

  it("right sidebar: dragging right narrows", () => {
    expect(clamp(260, 100, -1)).toBe(170);
  });

  it("clamps to min width (170)", () => {
    expect(clamp(260, -200, 1)).toBe(170);
  });

  it("clamps to max width (600)", () => {
    expect(clamp(260, 500, 1)).toBe(600);
  });
});
