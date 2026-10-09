/**
 * Regression tests for UX2-004 (#4314): the workspace editor reports its unsaved
 * state through `setEditorDirty`, so the tab-bar close guard covers it, and its
 * Cancel button goes through the shared unsaved-changes prompt instead of
 * closing the tab straight away. A clean editor still closes at once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { seedLayoutState } from "@/test/layoutState";
import { setupConnectionsRegion } from "@/test/connectionsHarness";
import { flushAsync } from "@/test/flushAsync";
import { withTooltip } from "@/test/tooltip";
import { click, typeInto, unsavedPromptOpen, byTestId } from "@/test/dirtyDismiss";
import type { WorkspaceDefinition } from "@/types/workspace";
import { WorkspaceEditor } from "./WorkspaceEditor";

const WORKSPACE: WorkspaceDefinition = {
  id: "ws-1",
  name: "Ops",
  tabGroups: [{ name: "Main", layout: { type: "leaf", tabs: [{ connectionRef: "local" }] } }],
};

vi.mock("@/services/workspaceApi", () => ({
  loadWorkspace: vi.fn(() => Promise.resolve(WORKSPACE)),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const TAB_ID = "tab-ws-edit";
const PANEL_ID = "panel-ws";

let container: HTMLDivElement;
let root: Root;

setupConnectionsRegion();

async function render(workspaceId: string | null, isVisible = true) {
  act(() => {
    root.render(
      withTooltip(<WorkspaceEditor tabId={TAB_ID} meta={{ workspaceId }} isVisible={isVisible} />)
    );
  });
  await flushAsync();
}

const closeTab = () => useAppStore.getState().closeTab as ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    saveWorkspaceToBackend: vi.fn(() => Promise.resolve()),
    closeTab: vi.fn(),
  });
  seedLayoutState({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rootPanel: { type: "leaf", id: PANEL_ID, tabs: [{ id: TAB_ID }] } as any,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("WorkspaceEditor — unsaved changes (UX2-004)", () => {
  it("a loaded workspace starts clean and turns dirty on an edit", async () => {
    await render("ws-1");
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBeFalsy();
    typeInto("workspace-name-input", "Ops 2");
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(true);
  });

  it("Cancel on a dirty editor asks before discarding", async () => {
    await render("ws-1");
    typeInto("workspace-name-input", "Ops 2");
    click("workspace-cancel-btn");
    await flushAsync();
    expect(closeTab()).not.toHaveBeenCalled();
    expect(unsavedPromptOpen()).toBe(true);
    expect(byTestId("unsaved-changes-message")!.textContent).toContain("“Ops 2”");
  });

  it("Just Close on the prompt closes the tab without saving", async () => {
    await render("ws-1");
    typeInto("workspace-name-input", "Ops 2");
    click("workspace-cancel-btn");
    await flushAsync();
    click("unsaved-changes-just-close");
    expect(closeTab()).toHaveBeenCalledWith(TAB_ID, PANEL_ID);
    expect(useAppStore.getState().saveWorkspaceToBackend).not.toHaveBeenCalled();
  });

  it("a clean editor closes on Cancel without asking", async () => {
    await render(null);
    click("workspace-cancel-btn");
    await flushAsync();
    expect(closeTab()).toHaveBeenCalledWith(TAB_ID, PANEL_ID);
    expect(unsavedPromptOpen()).toBe(false);
  });

  it("answers a tab-bar close request even while hidden", async () => {
    await render("ws-1");
    typeInto("workspace-name-input", "Ops 2");
    await render("ws-1", false);
    act(() => useAppStore.getState().setPendingCloseRequest({ tabId: TAB_ID, panelId: PANEL_ID }));
    expect(unsavedPromptOpen()).toBe(true);
  });
});
