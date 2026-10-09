/**
 * Regression tests for UX2-004 (#4314): the tunnel editor reports its unsaved
 * state through `setEditorDirty`, so the tab-bar close guard covers it, and its
 * Cancel button and Escape go through the shared unsaved-changes prompt instead
 * of closing the tab straight away. A clean editor still closes at once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { seedLayoutState } from "@/test/layoutState";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { flushAsync } from "@/test/flushAsync";
import { click, pressEscape, typeInto, unsavedPromptOpen, byTestId } from "@/test/dirtyDismiss";
import { TunnelEditor } from "./TunnelEditor";
import { TooltipProvider } from "@/components/ui";
import type { SavedConnection } from "@/types/connection";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const TAB_ID = "tab-tun-1";
const PANEL_ID = "panel-tun-1";

const SSH_CONN: SavedConnection = {
  id: "ssh-1",
  name: "My SSH",
  config: { type: "ssh", config: { host: "h", username: "u" } },
  folderId: null,
};

let container: HTMLDivElement;
let root: Root;

async function render() {
  act(() => {
    root.render(
      <TooltipProvider>
        <TunnelEditor tabId={TAB_ID} meta={{ tunnelId: null }} isVisible={true} />
      </TooltipProvider>
    );
  });
  await flushAsync();
}

const closeTab = () => useAppStore.getState().closeTab as ReturnType<typeof vi.fn>;

setupConnectionsRegion();

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  seedConnectionsRegion({ connections: [SSH_CONN] });
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    tunnels: [],
    saveTunnel: vi.fn(() => Promise.resolve()),
    startTunnel: vi.fn(() => Promise.resolve()),
    closeTab: vi.fn(),
  });
  seedLayoutState({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rootPanel: { type: "leaf", id: PANEL_ID, tabs: [{ id: TAB_ID }], activeTabId: TAB_ID } as any,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("TunnelEditor — unsaved changes (UX2-004)", () => {
  it("marks the tab dirty once a field changes, and clean again when reverted", async () => {
    await render();
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBeFalsy();
    typeInto("tunnel-editor-name", "Dev DB");
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(true);
    typeInto("tunnel-editor-name", "");
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(false);
  });

  it.each([
    ["Cancel", () => click("tunnel-editor-cancel")],
    ["Escape", () => pressEscape("tunnel-editor-name")],
  ])("%s on a dirty editor asks before discarding", async (_label, dismiss) => {
    await render();
    typeInto("tunnel-editor-name", "Dev DB");
    dismiss();
    await flushAsync();
    expect(closeTab()).not.toHaveBeenCalled();
    expect(unsavedPromptOpen()).toBe(true);
    expect(byTestId("unsaved-changes-message")!.textContent).toContain("“Dev DB”");
  });

  it("Just Close on the prompt closes the tab without saving", async () => {
    await render();
    typeInto("tunnel-editor-name", "Dev DB");
    click("tunnel-editor-cancel");
    await flushAsync();
    click("unsaved-changes-just-close");
    expect(closeTab()).toHaveBeenCalledWith(TAB_ID, PANEL_ID);
    expect(useAppStore.getState().saveTunnel).not.toHaveBeenCalled();
  });

  it("Save & Close on the prompt saves, then closes", async () => {
    await render();
    typeInto("tunnel-editor-name", "Dev DB");
    click("tunnel-editor-cancel");
    await flushAsync();
    await act(async () => byTestId("unsaved-changes-save-and-close")!.click());
    await flushAsync();
    expect(useAppStore.getState().saveTunnel).toHaveBeenCalledTimes(1);
    expect(closeTab()).toHaveBeenCalledWith(TAB_ID, PANEL_ID);
  });

  it("a clean editor closes on Cancel without asking", async () => {
    await render();
    click("tunnel-editor-cancel");
    await flushAsync();
    expect(closeTab()).toHaveBeenCalledWith(TAB_ID, PANEL_ID);
    expect(unsavedPromptOpen()).toBe(false);
  });
});
