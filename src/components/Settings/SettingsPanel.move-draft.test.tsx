/**
 * "Move tabs" carries an unsaved Settings panel to another window (#4758): the
 * panel mounted for the moved tab shows the pending values, is dirty, and then
 * auto-saves them as the source window would have. A secret typed into the
 * settings never travels, and a saved one is never overwritten with `""`.
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
import { TooltipProvider } from "@/components/ui";
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
