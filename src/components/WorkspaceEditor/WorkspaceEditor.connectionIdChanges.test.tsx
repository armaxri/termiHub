/**
 * An open workspace editor follows a saved connection's id change (#3603): the
 * draft's tab `connectionRef`s are re-pointed, so saving does not write the old
 * id back over the backend's follow of the saved workspace (#3596). Following a
 * rename is not a user edit, so it never marks an unedited editor dirty (#4413).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { seedLayoutState } from "@/test/layoutState";
import { setupConnectionsRegion } from "@/test/connectionsHarness";
import { flushAsync } from "@/test/flushAsync";
import { installConnectionIdChangesHarness } from "@/test/connectionIdChangesHarness";
import { withTooltip } from "@/test/tooltip";
import { typeInto } from "@/test/dirtyDismiss";
import type { WorkspaceDefinition } from "@/types/workspace";
import { WorkspaceEditor } from "./WorkspaceEditor";

const WORKSPACE: WorkspaceDefinition = {
  id: "ws-1",
  name: "Ops",
  tabGroups: [
    {
      name: "Main",
      layout: {
        type: "split",
        direction: "horizontal",
        children: [
          { type: "leaf", tabs: [{ connectionRef: "Work/web" }] },
          { type: "leaf", tabs: [{ connectionRef: "Work/db" }, { connectionRef: "local" }] },
        ],
      },
    },
  ],
};

vi.mock("@/services/workspaceApi", () => ({
  loadWorkspace: vi.fn(() => Promise.resolve(WORKSPACE)),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const TAB_ID = "tab-ws-edit";

let container: HTMLDivElement;
let root: Root;
type SaveWorkspace = (definition: WorkspaceDefinition) => Promise<void>;
let saveWorkspace: ReturnType<typeof vi.fn<SaveWorkspace>>;

setupConnectionsRegion();

describe("WorkspaceEditor — follows connection id changes (#3603)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    saveWorkspace = vi.fn<SaveWorkspace>(() => Promise.resolve());
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      saveWorkspaceToBackend: saveWorkspace,
      closeTab: vi.fn(),
    });
    seedLayoutState({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rootPanel: { type: "leaf", id: "panel-ws", tabs: [{ id: TAB_ID }] } as any,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderEditor() {
    const events = installConnectionIdChangesHarness();
    act(() => {
      root.render(
        withTooltip(
          <WorkspaceEditor tabId={TAB_ID} meta={{ workspaceId: WORKSPACE.id }} isVisible={true} />
        )
      );
    });
    await flushAsync();
    return events;
  }

  const isDirty = () => !!useAppStore.getState().editorDirtyTabs[TAB_ID];

  it("stays clean when a referenced connection is renamed (#4413)", async () => {
    const events = await renderEditor();
    expect(isDirty()).toBe(false);

    events.emit([{ oldId: "Work/web", newId: "Job/web" }]);
    await flushAsync();

    expect(isDirty()).toBe(false);
  });

  it("still turns dirty on a real edit after following a rename (#4413)", async () => {
    const events = await renderEditor();
    events.emit([{ oldId: "Work/web", newId: "Job/web" }]);
    await flushAsync();

    typeInto("workspace-name-input", "Ops 2");
    expect(isDirty()).toBe(true);

    // Undoing the edit returns to the (followed) baseline: clean again.
    typeInto("workspace-name-input", "Ops");
    expect(isDirty()).toBe(false);
  });

  it("an edited draft stays dirty across a rename and is clean once the edit is undone", async () => {
    const events = await renderEditor();
    typeInto("workspace-name-input", "Ops 2");
    expect(isDirty()).toBe(true);

    events.emit([{ oldId: "Work/db", newId: "Job/db" }]);
    await flushAsync();
    expect(isDirty()).toBe(true);

    typeInto("workspace-name-input", "Ops");
    expect(isDirty()).toBe(false);
  });

  it("saves the draft with the renamed connections' new ids", async () => {
    const events = await renderEditor();

    // A folder rename moves both connections in one batch.
    events.emit([
      { oldId: "Work/web", newId: "Job/web" },
      { oldId: "Work/db", newId: "Job/db" },
    ]);
    const save = container.querySelector<HTMLButtonElement>('[data-testid="workspace-save-btn"]')!;
    act(() => save.click());
    await flushAsync();

    expect(saveWorkspace).toHaveBeenCalledTimes(1);
    const saved = saveWorkspace.mock.calls[0][0];
    expect(saved.tabGroups[0].layout).toEqual({
      type: "split",
      direction: "horizontal",
      children: [
        { type: "leaf", tabs: [{ connectionRef: "Job/web" }] },
        { type: "leaf", tabs: [{ connectionRef: "Job/db" }, { connectionRef: "local" }] },
      ],
    });
  });
});
