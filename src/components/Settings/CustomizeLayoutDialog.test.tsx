import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { CustomizeLayoutDialog } from "./CustomizeLayoutDialog";
import { DEFAULT_LAYOUT, LAYOUT_PRESETS } from "@/types/connection";

// Mock storage and API modules (required by appStore)
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
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  monitoringOpen: vi.fn(),
  monitoringClose: vi.fn(),
  monitoringFetchStats: vi.fn(),
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  getDefaultShell: vi.fn(() => Promise.resolve(null)),
  connectAgent: vi.fn(),
  disconnectAgent: vi.fn(),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  listAgentDefinitions: vi.fn(() => Promise.resolve([])),
  saveAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(),
  getCredentialStoreStatus: vi.fn(() =>
    Promise.resolve({ mode: "none", status: "unavailable", keychainAvailable: false })
  ),
}));

vi.mock("@/services/tunnelApi", () => ({
  getTunnels: vi.fn(() => Promise.resolve([])),
  saveTunnel: vi.fn(),
  deleteTunnel: vi.fn(),
  startTunnel: vi.fn(),
  stopTunnel: vi.fn(),
  getTunnelStatuses: vi.fn(() => Promise.resolve([])),
}));

import { useAppStore } from "@/store/appStore";

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function queryAll(testId: string): NodeListOf<HTMLElement> {
  return document.querySelectorAll(`[data-testid="${testId}"]`);
}

function renderDialog() {
  act(() => {
    root.render(<CustomizeLayoutDialog />);
  });
}

function clickTestId(testId: string) {
  const el = query(testId);
  expect(el).not.toBeNull();
  act(() => {
    el!.click();
  });
}

function isChecked(testId: string): boolean {
  const el = query(testId) as HTMLInputElement | null;
  return el?.checked ?? false;
}

function isDisabled(testId: string): boolean {
  const el = query(testId) as HTMLInputElement | null;
  return el?.disabled ?? false;
}

describe("CustomizeLayoutDialog", () => {
  beforeEach(() => {
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      layoutDialogOpen: true,
      layoutConfig: { ...DEFAULT_LAYOUT },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // --- Opening/closing ---

  it("renders dialog content when open", () => {
    renderDialog();

    expect(query("layout-preset-default")).not.toBeNull();
    expect(query("layout-preset-focus")).not.toBeNull();
    expect(query("layout-preset-zen")).not.toBeNull();
    expect(query("layout-ab-visible")).not.toBeNull();
    expect(query("layout-sidebar-visible")).not.toBeNull();
    expect(query("layout-statusbar-visible")).not.toBeNull();
    expect(query("layout-reset-default")).not.toBeNull();
    expect(query("layout-close")).not.toBeNull();
    expect(query("layout-preview")).not.toBeNull();
  });

  it("does not render dialog content when closed", () => {
    useAppStore.setState({ layoutDialogOpen: false });
    renderDialog();

    expect(query("layout-preset-default")).toBeNull();
  });

  // --- Preset buttons ---

  it("applies Focus preset when clicked (hides sidebar, keeps AB and statusbar)", () => {
    renderDialog();
    clickTestId("layout-preset-focus");

    const state = useAppStore.getState();
    expect(state.layoutConfig).toEqual(LAYOUT_PRESETS.focus);
  });

  it("applies Zen preset when clicked (hides AB, sidebar, statusbar)", () => {
    renderDialog();
    clickTestId("layout-preset-zen");

    const state = useAppStore.getState();
    expect(state.layoutConfig).toEqual(LAYOUT_PRESETS.zen);
  });

  it("applies Default preset when clicked (restores all elements)", () => {
    // Start from Zen
    useAppStore.setState({ layoutConfig: { ...LAYOUT_PRESETS.zen } });
    renderDialog();
    clickTestId("layout-preset-default");

    const state = useAppStore.getState();
    expect(state.layoutConfig).toEqual(LAYOUT_PRESETS.default);
  });

  it("shows active accent class on the matching preset card", () => {
    renderDialog();

    const defaultBtn = query("layout-preset-default");
    expect(defaultBtn?.className).toContain("--active");

    const focusBtn = query("layout-preset-focus");
    expect(focusBtn?.className).not.toContain("--active");
  });

  it("updates active preset indicator after switching presets", () => {
    renderDialog();
    clickTestId("layout-preset-focus");

    // Re-render to pick up state change
    renderDialog();

    const focusBtn = query("layout-preset-focus");
    expect(focusBtn?.className).toContain("--active");

    const defaultBtn = query("layout-preset-default");
    expect(defaultBtn?.className).not.toContain("--active");
  });

  // --- Activity Bar visibility ---

  it("unchecking Activity Bar visibility hides it", () => {
    renderDialog();
    expect(isChecked("layout-ab-visible")).toBe(true);

    clickTestId("layout-ab-visible");

    const state = useAppStore.getState();
    expect(state.layoutConfig.activityBarPosition).toBe("hidden");
  });

  it("re-checking Activity Bar visibility restores last position", () => {
    // Set to right, then hide, then re-show
    useAppStore.setState({
      layoutConfig: { ...DEFAULT_LAYOUT, activityBarPosition: "right" },
    });
    renderDialog();

    // Hide
    clickTestId("layout-ab-visible");
    expect(useAppStore.getState().layoutConfig.activityBarPosition).toBe("hidden");

    // Re-render with hidden state
    renderDialog();

    // Show again — should restore to "right", not "left"
    clickTestId("layout-ab-visible");
    expect(useAppStore.getState().layoutConfig.activityBarPosition).toBe("right");
  });

  it("disables position radios when Activity Bar is hidden", () => {
    renderDialog();
    clickTestId("layout-ab-visible");
    renderDialog();

    expect(isDisabled("layout-ab-left")).toBe(true);
    expect(isDisabled("layout-ab-right")).toBe(true);
    expect(isDisabled("layout-ab-top")).toBe(true);
  });

  it("enables position radios when Activity Bar is visible", () => {
    renderDialog();

    expect(isDisabled("layout-ab-left")).toBe(false);
    expect(isDisabled("layout-ab-right")).toBe(false);
    expect(isDisabled("layout-ab-top")).toBe(false);
  });

  // --- Activity Bar position ---

  it("selects Right position for Activity Bar", () => {
    renderDialog();
    clickTestId("layout-ab-right");

    expect(useAppStore.getState().layoutConfig.activityBarPosition).toBe("right");
  });

  it("selects Top position for Activity Bar", () => {
    renderDialog();
    clickTestId("layout-ab-top");

    expect(useAppStore.getState().layoutConfig.activityBarPosition).toBe("top");
  });

  // --- Sidebar visibility ---

  it("unchecking Sidebar visibility hides it", () => {
    renderDialog();
    expect(isChecked("layout-sidebar-visible")).toBe(true);

    clickTestId("layout-sidebar-visible");

    expect(useAppStore.getState().layoutConfig.sidebarVisible).toBe(false);
  });

  it("re-checking Sidebar visibility shows it", () => {
    useAppStore.setState({
      layoutConfig: { ...DEFAULT_LAYOUT, sidebarVisible: false },
    });
    renderDialog();

    clickTestId("layout-sidebar-visible");

    expect(useAppStore.getState().layoutConfig.sidebarVisible).toBe(true);
  });

  it("disables Sidebar position radios when sidebar is hidden", () => {
    renderDialog();
    clickTestId("layout-sidebar-visible");
    renderDialog();

    expect(isDisabled("layout-sidebar-left")).toBe(true);
    expect(isDisabled("layout-sidebar-right")).toBe(true);
  });

  // --- Sidebar position ---

  it("selects Right position for Sidebar", () => {
    renderDialog();
    clickTestId("layout-sidebar-right");

    expect(useAppStore.getState().layoutConfig.sidebarPosition).toBe("right");
  });

  // --- Status Bar visibility ---

  it("unchecking Status Bar visibility hides it", () => {
    renderDialog();
    expect(isChecked("layout-statusbar-visible")).toBe(true);

    clickTestId("layout-statusbar-visible");

    expect(useAppStore.getState().layoutConfig.statusBarVisible).toBe(false);
  });

  // --- Reset to Default ---

  it("Reset to Default restores DEFAULT_LAYOUT from any config", () => {
    useAppStore.setState({ layoutConfig: { ...LAYOUT_PRESETS.zen } });
    renderDialog();

    clickTestId("layout-reset-default");

    expect(useAppStore.getState().layoutConfig).toEqual(DEFAULT_LAYOUT);
  });

  // --- Close button ---

  it("Close button closes the dialog", () => {
    renderDialog();
    clickTestId("layout-close");

    // The Radix dialog calls onOpenChange(false) → setLayoutDialogOpen(false)
    expect(useAppStore.getState().layoutDialogOpen).toBe(false);
  });

  // --- Layout Preview integration ---

  it("renders LayoutPreview inside the dialog", () => {
    renderDialog();

    expect(query("layout-preview")).not.toBeNull();
    expect(query("preview-ab")).not.toBeNull();
    expect(query("preview-sidebar")).not.toBeNull();
    expect(query("preview-terminal")).not.toBeNull();
    expect(query("preview-statusbar")).not.toBeNull();
  });

  it("LayoutPreview updates when Activity Bar position changes to Right", () => {
    renderDialog();
    clickTestId("layout-ab-right");
    renderDialog();

    // AB should now be on the right side of the terminal in the preview
    const main = query("preview-main");
    expect(main).not.toBeNull();
    const children = Array.from(main!.children);
    const abIndex = children.findIndex((el) => el.getAttribute("data-testid") === "preview-ab");
    const termIndex = children.findIndex(
      (el) => el.getAttribute("data-testid") === "preview-terminal"
    );
    expect(abIndex).toBeGreaterThan(termIndex);
  });

  it("LayoutPreview updates when Activity Bar position changes to Top", () => {
    renderDialog();
    clickTestId("layout-ab-top");
    renderDialog();

    expect(query("preview-ab-top")).not.toBeNull();
    expect(query("preview-ab")).toBeNull();
  });

  it("LayoutPreview hides AB when Activity Bar visibility is unchecked", () => {
    renderDialog();
    clickTestId("layout-ab-visible");
    renderDialog();

    expect(query("preview-ab")).toBeNull();
    expect(query("preview-ab-top")).toBeNull();
  });

  it("LayoutPreview hides sidebar when Sidebar visibility is unchecked", () => {
    renderDialog();
    clickTestId("layout-sidebar-visible");
    renderDialog();

    expect(query("preview-sidebar")).toBeNull();
  });

  it("LayoutPreview moves sidebar to right when Sidebar position changes", () => {
    renderDialog();
    clickTestId("layout-sidebar-right");
    renderDialog();

    const main = query("preview-main");
    expect(main).not.toBeNull();
    const children = Array.from(main!.children);
    const sbIndex = children.findIndex(
      (el) => el.getAttribute("data-testid") === "preview-sidebar"
    );
    const termIndex = children.findIndex(
      (el) => el.getAttribute("data-testid") === "preview-terminal"
    );
    expect(sbIndex).toBeGreaterThan(termIndex);
  });

  it("LayoutPreview hides status bar when Status Bar visibility is unchecked", () => {
    renderDialog();
    clickTestId("layout-statusbar-visible");
    renderDialog();

    expect(query("preview-statusbar")).toBeNull();
  });

  it("LayoutPreview shows only terminal in Zen preset", () => {
    renderDialog();
    clickTestId("layout-preset-zen");
    renderDialog();

    expect(query("preview-ab")).toBeNull();
    expect(query("preview-ab-top")).toBeNull();
    expect(query("preview-sidebar")).toBeNull();
    expect(query("preview-statusbar")).toBeNull();
    expect(query("preview-terminal")).not.toBeNull();
  });

  it("LayoutPreview restores all elements when returning to Default preset", () => {
    renderDialog();
    clickTestId("layout-preset-zen");
    renderDialog();
    clickTestId("layout-preset-default");
    renderDialog();

    expect(query("preview-ab")).not.toBeNull();
    expect(query("preview-sidebar")).not.toBeNull();
    expect(query("preview-terminal")).not.toBeNull();
    expect(query("preview-statusbar")).not.toBeNull();
  });

  // --- Reopen reflects current state ---

  it("reflects current layout state when dialog is reopened", () => {
    // Apply zen preset while dialog is open
    renderDialog();
    clickTestId("layout-preset-zen");

    // Close dialog
    useAppStore.setState({ layoutDialogOpen: false });
    renderDialog();
    expect(query("layout-preset-zen")).toBeNull();

    // Reopen
    useAppStore.setState({ layoutDialogOpen: true });
    renderDialog();

    // Zen should still be the active preset
    const zenBtn = query("layout-preset-zen");
    expect(zenBtn?.className).toContain("--active");

    // AB should be unchecked
    expect(isChecked("layout-ab-visible")).toBe(false);
    expect(isChecked("layout-sidebar-visible")).toBe(false);
    expect(isChecked("layout-statusbar-visible")).toBe(false);
  });
});
