/**
 * App-level wiring of the "Open Saved File in Tab" dialog (MT-TAB-11/12, #3693).
 *
 * The dialog component and the Save-to-File flow that raises it are unit-tested
 * in isolation (OpenSavedFileDialog.test.tsx, TerminalRegistry.saveAndPaste.test.tsx).
 * What was left manual is the glue in `App.tsx`: that the dialog's Open button
 * really opens a Monaco editor tab for the saved path, and that Cancel closes the
 * dialog without opening one. This mounts the real `App` shell (as the smoke test
 * does) and drives the dialog through the store action the save flow calls.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { getAllLeaves } from "@/utils/panelTree";
import { layoutState } from "@/test/layoutState";
import App from "./App";

const SAVED_PATH = "/tmp/termihub-test/terminal-output.txt";

function allTabs() {
  return getAllLeaves(layoutState().rootPanel).flatMap((leaf) => leaf.tabs);
}

function editorTabsFor(path: string) {
  return allTabs().filter((t) => t.contentType === "editor" && t.editorMeta?.filePath === path);
}

function button(testId: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`missing [data-testid="${testId}"]`);
  return el;
}

describe("App: Open Saved File in Tab dialog (MT-TAB-11/12)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // Same cold-start setup as App.smoke.test.tsx: neuter backend hydration,
    // which would otherwise overwrite store defaults with the stubbed `undefined`.
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      loadFromBackend: async () => {},
    });
    await act(async () => {
      root.render(<App />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function showDialog(): Promise<void> {
    await act(async () => {
      useAppStore.getState().showOpenSavedFileDialog(SAVED_PATH);
    });
    expect(document.querySelector('[data-testid="open-saved-file-dialog"]')).not.toBeNull();
  }

  it("Open opens an editor tab for the saved file (MT-TAB-11)", async () => {
    const before = allTabs().length;
    await showDialog();

    await act(async () => {
      button("open-saved-file-confirm").click();
    });

    const editors = editorTabsFor(SAVED_PATH);
    expect(editors).toHaveLength(1);
    expect(editors[0].editorMeta?.isRemote).toBe(false);
    expect(editors[0].title).toBe("terminal-output.txt");
    expect(editors[0].isActive).toBe(true);
    expect(allTabs()).toHaveLength(before + 1);
    expect(useAppStore.getState().openSavedFileDialog.open).toBe(false);
  });

  it("Cancel closes the dialog and leaves the tab count unchanged (MT-TAB-12)", async () => {
    const before = allTabs().length;
    await showDialog();

    await act(async () => {
      button("open-saved-file-cancel").click();
    });

    expect(useAppStore.getState().openSavedFileDialog.open).toBe(false);
    expect(editorTabsFor(SAVED_PATH)).toHaveLength(0);
    expect(allTabs()).toHaveLength(before);
  });
});
