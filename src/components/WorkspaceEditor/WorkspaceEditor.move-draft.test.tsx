/**
 * "Move tabs" carries a dirty workspace editor's unsaved values to another
 * window (#4500): the editor mounted for the moved tab shows them and is
 * dirty, and nothing is saved on the way.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { setupConnectionsRegion } from "@/test/connectionsHarness";
import { flushAsync } from "@/test/flushAsync";
import { withTooltip } from "@/test/tooltip";
import { typeInto, byTestId } from "@/test/dirtyDismiss";
import { hydrateInDestination, moveTabs, seedSingleTab } from "@/test/formDraftMove";
import { clearEditorBuffers } from "@/utils/editorBufferRegistry";
import type { TerminalTab } from "@/types/terminal";
import type { WorkspaceDefinition } from "@/types/workspace";
import { WorkspaceEditor } from "./WorkspaceEditor";

const WORKSPACE: WorkspaceDefinition = {
  id: "ws-1",
  name: "Ops",
  description: "on-call",
  tabGroups: [{ name: "Main", layout: { type: "leaf", tabs: [{ connectionRef: "local" }] } }],
};

vi.mock("@/services/workspaceApi", () => ({
  loadWorkspace: vi.fn(() => Promise.resolve(WORKSPACE)),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

let container: HTMLDivElement;
let root: Root;

setupConnectionsRegion();

function editorTab(workspaceId: string | null): TerminalTab {
  return {
    id: "tab-src",
    sessionId: null,
    title: workspaceId ? "Edit: Ops" : "New Workspace",
    connectionType: "local",
    contentType: "workspace-editor",
    config: { type: "local", config: {} },
    panelId: "panel-src",
    isActive: true,
    workspaceEditorMeta: { workspaceId },
  };
}

async function render(tabId: string, workspaceId: string | null) {
  act(() => {
    root.render(
      withTooltip(
        <WorkspaceEditor key={tabId} tabId={tabId} meta={{ workspaceId }} isVisible={true} />
      )
    );
  });
  await flushAsync();
}

const nameValue = () => (byTestId("workspace-name-input") as HTMLInputElement).value;

async function moveToDestination(workspaceId: string | null): Promise<string> {
  const record = await moveTabs();
  expect(record.tab.editorDirty).toBe(true);
  expect(record.tab.formDraft?.kind).toBe("workspace-editor");
  act(() => root.unmount());
  root = createRoot(container);
  const newTabId = hydrateInDestination(record, "panel-dst");
  await render(newTabId, workspaceId);
  return newTabId;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  clearEditorBuffers();
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    saveWorkspaceToBackend: vi.fn(() => Promise.resolve()),
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("WorkspaceEditor — Move tabs carries the unsaved draft (#4500)", () => {
  it("a dirty saved workspace reappears dirty with its edits in the target window", async () => {
    seedSingleTab(editorTab("ws-1"));
    await render("tab-src", "ws-1");
    typeInto("workspace-name-input", "Ops (night)");

    const newTabId = await moveToDestination("ws-1");

    expect(nameValue()).toBe("Ops (night)");
    expect(useAppStore.getState().editorDirtyTabs[newTabId]).toBe(true);
    expect(useAppStore.getState().saveWorkspaceToBackend).not.toHaveBeenCalled();
    // The baseline is still the saved workspace: reverting is clean again.
    typeInto("workspace-name-input", "Ops");
    expect(useAppStore.getState().editorDirtyTabs[newTabId]).toBe(false);
  });

  it("a dirty new workspace reappears dirty with its values", async () => {
    seedSingleTab(editorTab(null));
    await render("tab-src", null);
    typeInto("workspace-name-input", "Scratch");

    const newTabId = await moveToDestination(null);

    expect(nameValue()).toBe("Scratch");
    expect(useAppStore.getState().editorDirtyTabs[newTabId]).toBe(true);
  });
});
