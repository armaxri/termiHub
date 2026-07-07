import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AppSettings } from "@/types/connection";
import { TooltipProvider } from "@/components/ui";
import { SettingsPanel } from "./SettingsPanel";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
}));

vi.mock("@/utils/shell-detection", () => ({
  detectAvailableShells: vi.fn().mockResolvedValue([]),
  getWslDistroName: vi.fn(() => null),
}));

const { invoke } = await import("@tauri-apps/api/core");
const mockedInvoke = vi.mocked(invoke);

const SPARSE_SETTINGS: AppSettings = {
  version: "1",
  externalConnectionFiles: [],
  powerMonitoringEnabled: true,
  fileBrowserEnabled: true,
};

const FULL_SETTINGS: AppSettings = {
  ...SPARSE_SETTINGS,
  defaultShellIntegration: true,
  defaultX11Forwarding: true,
  provideXServerAutomatically: true,
  stopXServerWhenIdle: true,
  updates: { autoCheck: true },
};

const TAB_ID = "test-settings-tab";

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <SettingsPanel tabId={TAB_ID} isVisible={true} />
      </TooltipProvider>
    );
  });
}

function findShellIntegrationCheckbox(): HTMLInputElement | null {
  return container.querySelector(
    "[data-testid='settings-default-shell-integration']"
  ) as HTMLInputElement | null;
}

function findProvideXServerCheckbox(): HTMLInputElement | null {
  return container.querySelector(
    "[data-testid='settings-provide-x-server']"
  ) as HTMLInputElement | null;
}

function findStopXServerIdleCheckbox(): HTMLInputElement | null {
  return container.querySelector(
    "[data-testid='settings-stop-x-server-idle']"
  ) as HTMLInputElement | null;
}

/** Toggle a controlled React checkbox by clicking it and returning the new value. */
async function clickCheckbox(checkbox: HTMLInputElement) {
  await act(async () => {
    checkbox.click();
  });
}

describe("SettingsPanel — dirty state on revert to default", () => {
  beforeEach(() => {
    // Use fake timers so the panel's 300ms debounced save (SAVE_DEBOUNCE_MS)
    // never fires on its own during a test. With real timers, a starved parallel
    // worker can let the debounce elapse between the two clicks of a
    // toggle-then-revert flow: the save would rewrite `savedSettings` to the
    // intermediate value, shifting the dirty baseline, so the revert click would
    // wrongly leave the tab dirty. Fake timers make the flow order-independent —
    // the debounce only advances when a test explicitly asks it to.
    vi.useFakeTimers();

    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    useAppStore.setState(useAppStore.getInitialState());

    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "get_app_info") return Promise.resolve({ version: "0.0.0", gitHash: "abc" });
      if (cmd === "save_settings") return Promise.resolve(undefined);
      if (cmd === "list_available_shells") return Promise.resolve([]);
      if (cmd === "get_default_shell") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("clears dirty flag when setting is reverted to its last-saved value", async () => {
    useAppStore.setState({ settings: FULL_SETTINGS, savedSettings: FULL_SETTINGS });
    render();

    const checkbox = findShellIntegrationCheckbox();
    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(true);

    // User disables shell integration → dirty
    await clickCheckbox(checkbox!);
    expect(checkbox!.checked).toBe(false);
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(true);

    // User reverts to original (enabled) value → clean
    await clickCheckbox(checkbox!);
    expect(checkbox!.checked).toBe(true);
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(false);
  });

  it("clears dirty flag after revert when settings were updated externally after mount", async () => {
    // Simulate panel mounting before loadFromBackend completes (sparse initial state)
    useAppStore.setState({ settings: SPARSE_SETTINGS });
    render();

    // Simulate loadFromBackend: settings now include defaultShellIntegration
    await act(async () => {
      useAppStore.setState({ settings: FULL_SETTINGS, savedSettings: FULL_SETTINGS });
    });

    const checkbox = findShellIntegrationCheckbox();
    expect(checkbox).not.toBeNull();
    // Displayed value is true (from FULL_SETTINGS or the ?? true fallback)
    expect(checkbox!.checked).toBe(true);

    // User disables shell integration → dirty
    await clickCheckbox(checkbox!);
    expect(checkbox!.checked).toBe(false);
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(true);

    // User reverts → because lastSavedSettingsRef was synced when the external update arrived,
    // the comparison correctly finds no difference → clean
    await clickCheckbox(checkbox!);
    expect(checkbox!.checked).toBe(true);
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(false);
  });

  it("does not reset dirty baseline while user has pending unsaved changes", async () => {
    useAppStore.setState({ settings: FULL_SETTINGS, savedSettings: FULL_SETTINGS });
    render();

    const checkbox = findShellIntegrationCheckbox();
    expect(checkbox).not.toBeNull();

    // User disables shell integration → dirty
    await clickCheckbox(checkbox!);
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(true);

    // External settings update (e.g., skipUpdate) while user has unsaved edits
    await act(async () => {
      useAppStore.setState({
        settings: { ...FULL_SETTINGS, defaultX11Forwarding: false },
        savedSettings: { ...FULL_SETTINGS, defaultX11Forwarding: false },
      });
    });

    // Dirty flag must still be true — the external update must not have reset the baseline
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(true);
  });

  it("marks settings dirty when toggling Provide X Server Automatically", async () => {
    useAppStore.setState({ settings: FULL_SETTINGS, savedSettings: FULL_SETTINGS });
    render();

    const checkbox = findProvideXServerCheckbox();
    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(true);

    // User disables auto-provisioning → dirty
    await clickCheckbox(checkbox!);
    expect(checkbox!.checked).toBe(false);
    expect(useAppStore.getState().settings.provideXServerAutomatically).toBe(false);
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(true);

    // User reverts to original (enabled) value → clean
    await clickCheckbox(checkbox!);
    expect(checkbox!.checked).toBe(true);
    expect(useAppStore.getState().settings.provideXServerAutomatically).toBe(true);
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(false);
  });

  it("marks settings dirty when toggling Stop X Server When Idle", async () => {
    useAppStore.setState({ settings: FULL_SETTINGS, savedSettings: FULL_SETTINGS });
    render();

    const checkbox = findStopXServerIdleCheckbox();
    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(true);

    // User disables idle shutdown → dirty
    await clickCheckbox(checkbox!);
    expect(checkbox!.checked).toBe(false);
    expect(useAppStore.getState().settings.stopXServerWhenIdle).toBe(false);
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(true);

    // User reverts to original (enabled) value → clean
    await clickCheckbox(checkbox!);
    expect(checkbox!.checked).toBe(true);
    expect(useAppStore.getState().settings.stopXServerWhenIdle).toBe(true);
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(false);
  });
});
