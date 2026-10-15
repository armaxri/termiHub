/**
 * "Move tabs" carries an unsaved Settings panel to another window (#4758): the
 * panel mounted for the moved tab shows the pending values, is dirty, and then
 * auto-saves them as the source window would have. A secret typed into the
 * settings never travels, and a saved one is never overwritten with `""`.
 *
 * When the destination already shows Settings, the moved values are merged into
 * that tab instead of opening a second one (#4760).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { seedSettings, setupSettingsRegion, settingsDoc } from "@/test/settingsRegionTestHarness";
import { hydrateInDestination, moveTabs, seedSingleTab } from "@/test/formDraftMove";
import { clearEditorBuffers } from "@/utils/editorBufferRegistry";
import type { AppSettings } from "@/types/connection";
import type { TerminalTab } from "@/types/terminal";
import { TooltipProvider, toast } from "@/components/ui";
import { collectWindowTabs } from "@/store/layoutHelpers";
import type { PanelNode } from "@/types/terminal";
import { seedLayoutState } from "@/test/layoutState";
import { SettingsPanel } from "./SettingsPanel";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
  frontendError: vi.fn(),
  fireAndForget: vi.fn(),
}));

/** A settings document with a secret-named field, as a plugin setting could add. */
type SettingsWithSecret = AppSettings & { apiToken?: string };

// The General category is replaced by two buttons that edit the document the
// way a real section does (through `onChange`): one plain field, one secret.
vi.mock("./GeneralSettings", () => ({
  GeneralSettings: ({
    onChange,
  }: {
    onChange: (update: (prev: SettingsWithSecret) => SettingsWithSecret) => void;
  }) => (
    <div>
      <button
        data-testid="edit-font-size"
        onClick={() => onChange((prev) => ({ ...prev, fontSize: 18 }))}
      />
      <button
        data-testid="type-api-token"
        onClick={() => onChange((prev) => ({ ...prev, apiToken: "typed-secret" }))}
      />
      <button
        data-testid="edit-font-size-20"
        onClick={() => onChange((prev) => ({ ...prev, fontSize: 20 }))}
      />
      <button
        data-testid="disable-file-browser"
        onClick={() => onChange((prev) => ({ ...prev, fileBrowserEnabled: false }))}
      />
      <button
        data-testid="type-api-token-here"
        onClick={() => onChange((prev) => ({ ...prev, apiToken: "typed-here" }))}
      />
    </div>
  ),
}));

const { invoke } = await import("@tauri-apps/api/core");
const mockedInvoke = vi.mocked(invoke);

const SAVED: SettingsWithSecret = settingsDoc({ fontSize: 13 });
const SAVED_WITH_SECRET: SettingsWithSecret = { ...SAVED, apiToken: "saved-secret" };

const SOURCE_TAB: TerminalTab = {
  id: "tab-src",
  sessionId: null,
  title: "Settings",
  connectionType: "local",
  contentType: "settings",
  config: { type: "local", config: {} },
  panelId: "panel-src",
  isActive: true,
};

let container: HTMLDivElement;
let root: Root;

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function render(tabId: string) {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <SettingsPanel key={tabId} tabId={tabId} isVisible={true} />
      </TooltipProvider>
    );
  });
  await settle();
}

async function click(testId: string) {
  await act(async () => {
    container.querySelector<HTMLElement>(`[data-testid='${testId}']`)!.click();
  });
}

/** Every settings document persisted through `save_settings`. */
function savedDocs(): SettingsWithSecret[] {
  return mockedInvoke.mock.calls
    .filter(([command]) => command === "save_settings")
    .map(([, args]) => (args as { settings: SettingsWithSecret }).settings);
}

/**
 * Leave the source window and hydrate the moved tab in a destination window
 * whose saved settings are `destinationSaved`, then mount the panel there.
 * Whatever the source window did on its way out is forgotten, so the saves seen
 * afterwards are the destination's own. Returns the new tab's id.
 */
async function arriveInDestination(
  record: Awaited<ReturnType<typeof moveTabs>>,
  destinationSaved: SettingsWithSecret
): Promise<string> {
  act(() => root.unmount());
  root = createRoot(container);
  const tabId = hydrateInDestination(record, "panel-dst");
  seedSettings(destinationSaved);
  mockedInvoke.mockClear();
  await render(tabId);
  return tabId;
}

setupSettingsRegion();

describe("SettingsPanel — Move tabs carries unsaved settings (#4758)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    clearEditorBuffers();
    useAppStore.setState(useAppStore.getInitialState());
    seedSettings(SAVED);
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "get_app_info") return Promise.resolve({ version: "0.0.0", gitHash: "abc" });
      return Promise.resolve(undefined);
    });
    seedSingleTab(SOURCE_TAB);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("an unsaved Settings panel reappears dirty with its values, then auto-saves them", async () => {
    await render(SOURCE_TAB.id);
    await click("edit-font-size");
    expect(useAppStore.getState().editorDirtyTabs[SOURCE_TAB.id]).toBe(true);

    // The pending edit no longer blocks the close dialog's Move.
    await useAppStore.getState().prepareWindowClose([{ label: "win-1" }]);
    expect(useAppStore.getState().pendingWindowClose?.dirtyEditors).toEqual([
      { tabId: SOURCE_TAB.id, title: "Settings", movable: true },
    ]);

    const record = await moveTabs();
    expect(record.tab.editorDirty).toBe(true);
    expect(record.tab.formDraft?.kind).toBe("settings");
    expect(record.tab.formDraft?.values).toMatchObject({ fontSize: 18 });

    const tabId = await arriveInDestination(record, SAVED);

    // Dirty with the pending value, and nothing saved yet.
    expect(useAppStore.getState().editorDirtyTabs[tabId]).toBe(true);
    expect(savedDocs()).toEqual([]);

    // The debounced auto-save then persists it, as the source would have.
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(savedDocs()).toEqual([expect.objectContaining({ fontSize: 18 })]);
    expect(useAppStore.getState().editorDirtyTabs[tabId]).toBe(false);
  });

  it("a clean Settings panel moves without a draft", async () => {
    await render(SOURCE_TAB.id);
    await click("edit-font-size");
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(useAppStore.getState().editorDirtyTabs[SOURCE_TAB.id]).toBe(false);

    const record = await moveTabs();
    expect(record.tab.formDraft).toBeUndefined();
    expect(record.tab.editorDirty).toBeUndefined();
  });

  it("clears a typed secret, names it in the dialog and keeps the saved one", async () => {
    seedSettings(SAVED_WITH_SECRET);
    await render(SOURCE_TAB.id);
    await click("type-api-token");
    await click("edit-font-size");

    await useAppStore.getState().prepareWindowClose([{ label: "win-1" }]);
    expect(useAppStore.getState().pendingWindowClose?.dirtyEditors).toEqual([
      { tabId: SOURCE_TAB.id, title: "Settings", movable: true, clearedSecrets: ["API token"] },
    ]);

    const record = await moveTabs();
    const wire = JSON.stringify(record);
    expect(wire).not.toContain("typed-secret");
    expect(wire).not.toContain("saved-secret");
    expect(record.tab.formDraft?.values).toMatchObject({ fontSize: 18, apiToken: "" });

    const tabId = await arriveInDestination(record, SAVED_WITH_SECRET);
    expect(useAppStore.getState().editorDirtyTabs[tabId]).toBe(true);

    // The auto-save keeps the destination's saved secret, never `""`.
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(savedDocs()).toEqual([
      expect.objectContaining({ fontSize: 18, apiToken: "saved-secret" }),
    ]);
  });

  it("does not name a saved secret that was not edited", async () => {
    seedSettings(SAVED_WITH_SECRET);
    await render(SOURCE_TAB.id);
    await click("edit-font-size");

    await useAppStore.getState().prepareWindowClose([{ label: "win-1" }]);
    expect(useAppStore.getState().pendingWindowClose?.dirtyEditors).toEqual([
      { tabId: SOURCE_TAB.id, title: "Settings", movable: true },
    ]);
    expect(JSON.stringify(await moveTabs())).not.toContain("saved-secret");
  });
});

const DESTINATION_TAB: TerminalTab = {
  ...SOURCE_TAB,
  id: "tab-dst",
  panelId: "panel-dst",
};

/** A destination layout already showing its own Settings tab, beside a terminal. */
function seedDestinationWithSettings(): void {
  const terminal: TerminalTab = {
    ...SOURCE_TAB,
    id: "tab-term",
    title: "Terminal",
    contentType: "terminal",
    panelId: "panel-dst",
    isActive: true,
  };
  const rootPanel: PanelNode = {
    type: "leaf",
    id: "panel-dst",
    tabs: [{ ...DESTINATION_TAB, isActive: false }, terminal],
    activeTabId: terminal.id,
  };
  seedLayoutState({
    rootPanel,
    activePanelId: "panel-dst",
    tabGroups: [{ id: "g1", name: "Main", rootPanel, activePanelId: "panel-dst" }],
    activeTabGroupId: "g1",
  });
  useAppStore.setState({ editorDirtyTabs: {} });
}

describe("SettingsPanel — a moved unsaved panel merges into an open Settings tab (#4760)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    clearEditorBuffers();
    useAppStore.setState(useAppStore.getInitialState());
    seedSettings(SAVED);
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "get_app_info") return Promise.resolve({ version: "0.0.0", gitHash: "abc" });
      return Promise.resolve(undefined);
    });
    seedSingleTab(SOURCE_TAB);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Edit Settings in the source window with `clicks` and move it out. */
  async function moveDirtySettings(clicks: string[], sourceSaved = SAVED) {
    seedSettings(sourceSaved);
    await render(SOURCE_TAB.id);
    for (const testId of clicks) await click(testId);
    const record = await moveTabs();
    act(() => root.unmount());
    root = createRoot(container);
    // Let the source's flush-on-unmount save land before the destination seeds.
    await settle();
    return record;
  }

  /** Open the destination's own Settings tab, edited with `clicks`. */
  async function openDestinationSettings(saved: SettingsWithSecret, clicks: string[] = []) {
    seedDestinationWithSettings();
    seedSettings(saved);
    await render(DESTINATION_TAB.id);
    for (const testId of clicks) await click(testId);
    mockedInvoke.mockClear();
  }

  async function hydrate(record: Awaited<ReturnType<typeof moveTabs>>) {
    await act(async () => {
      useAppStore.getState().hydrateHandoffTab(record);
    });
    await settle();
  }

  function settingsTabs(): TerminalTab[] {
    return collectWindowTabs(useAppStore.getState()).filter((t) => t.contentType === "settings");
  }

  it("applies the moved values to a clean Settings tab, activates it and adds no tab", async () => {
    const info = vi.spyOn(toast, "info");
    const record = await moveDirtySettings(["edit-font-size"]);
    await openDestinationSettings(SAVED);

    await hydrate(record);

    const tabs = settingsTabs();
    expect(tabs.map((t) => t.id)).toEqual([DESTINATION_TAB.id]);
    expect(tabs[0].isActive).toBe(true);
    expect(useAppStore.getState().editorDirtyTabs[DESTINATION_TAB.id]).toBe(true);
    expect(savedDocs()).toEqual([]);

    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(savedDocs()).toEqual([expect.objectContaining({ fontSize: 18 })]);
    expect(useAppStore.getState().editorDirtyTabs[DESTINATION_TAB.id]).toBe(false);
    expect(info).not.toHaveBeenCalled();
  });

  it("merges into a dirty Settings tab field by field when nothing conflicts", async () => {
    const record = await moveDirtySettings(["edit-font-size"]);
    await openDestinationSettings(SAVED, ["disable-file-browser"]);

    await hydrate(record);
    expect(settingsTabs()).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(savedDocs()).toEqual([
      expect.objectContaining({ fontSize: 18, fileBrowserEnabled: false }),
    ]);
  });

  it("keeps the destination's value for a field both changed and says so", async () => {
    const info = vi.spyOn(toast, "info");
    const record = await moveDirtySettings(["edit-font-size"]);
    await openDestinationSettings(SAVED, ["edit-font-size-20"]);

    await hydrate(record);
    expect(settingsTabs()).toHaveLength(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toContain("fontSize");

    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(savedDocs()).toEqual([expect.objectContaining({ fontSize: 20 })]);
  });

  it("never copies a typed secret and keeps the destination's saved one", async () => {
    const record = await moveDirtySettings(["type-api-token", "edit-font-size"], SAVED_WITH_SECRET);
    expect(JSON.stringify(record)).not.toContain("typed-secret");
    await openDestinationSettings(SAVED_WITH_SECRET);

    await hydrate(record);
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(savedDocs()).toEqual([
      expect.objectContaining({ fontSize: 18, apiToken: "saved-secret" }),
    ]);
  });

  it("keeps a secret typed in the destination's Settings tab", async () => {
    const info = vi.spyOn(toast, "info");
    const record = await moveDirtySettings(["type-api-token", "edit-font-size"], SAVED_WITH_SECRET);
    await openDestinationSettings(SAVED_WITH_SECRET, ["type-api-token-here"]);

    await hydrate(record);
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(savedDocs()).toEqual([
      expect.objectContaining({ fontSize: 18, apiToken: "typed-here" }),
    ]);
    expect(info).not.toHaveBeenCalled();
  });

  it("holds the draft for a Settings tab that is not mounted yet", async () => {
    const record = await moveDirtySettings(["edit-font-size"]);
    seedDestinationWithSettings();
    seedSettings(SAVED);

    useAppStore.getState().hydrateHandoffTab(record);
    expect(settingsTabs().map((t) => t.id)).toEqual([DESTINATION_TAB.id]);
    expect(useAppStore.getState().editorDirtyTabs[DESTINATION_TAB.id]).toBe(true);

    mockedInvoke.mockClear();
    await render(DESTINATION_TAB.id);
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(savedDocs()).toEqual([expect.objectContaining({ fontSize: 18 })]);
  });
});
