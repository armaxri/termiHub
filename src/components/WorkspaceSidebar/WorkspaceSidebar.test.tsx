import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { withTooltip } from "@/test/tooltip";
import { WorkspaceSummary } from "@/types/workspace";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

// Stub the native file dialogs and fs so import/export can be driven from tests.
const dialogSave = vi.fn();
const dialogOpen = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => dialogSave(...args),
  open: (...args: unknown[]) => dialogOpen(...args),
}));

const fsWriteTextFile = vi.fn();
const fsReadTextFile = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: (...args: unknown[]) => fsWriteTextFile(...args),
  readTextFile: (...args: unknown[]) => fsReadTextFile(...args),
}));

const apiExportWorkspaces = vi.fn();
const apiImportWorkspaces = vi.fn();
vi.mock("@/services/workspaceApi", () => ({
  exportWorkspaces: (...args: unknown[]) => apiExportWorkspaces(...args),
  importWorkspaces: (...args: unknown[]) => apiImportWorkspaces(...args),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();

// Keep the real UI primitives (Modal/Button/Input) so the SaveWorkspaceDialog
// still renders, but spy on the toast helper to assert save feedback.
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    toast: {
      ...actual.toast,
      success: (...args: unknown[]) => toastSuccess(...args),
      error: (...args: unknown[]) => toastError(...args),
    },
  };
});

import { useAppStore } from "@/store/appStore";

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

/** Flush a microtask queue turn so awaited promises settle inside act(). */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Open the Save dialog, enter a name, and click the confirm button. */
function openDialogAndConfirm(name: string) {
  act(() => query("workspace-save-current-btn")!.click());
  const nameInput = query("save-workspace-name") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(nameInput, name);
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => (query("save-workspace-confirm") as HTMLButtonElement).click());
}

const sampleWorkspaces: WorkspaceSummary[] = [
  { id: "ws-1", name: "Dev Setup", description: "Daily dev layout", connectionCount: 3 },
  { id: "ws-2", name: "Production", connectionCount: 1 },
];

describe("WorkspaceSidebar", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows empty message when no workspaces", () => {
    useAppStore.setState({ workspaces: [] });

    act(() => {
      root.render(withTooltip(<WorkspaceSidebar />));
    });

    expect(query("workspace-empty-message")).not.toBeNull();
    expect(query("workspace-list")).toBeNull();
  });

  it("renders workspace list when workspaces exist", () => {
    useAppStore.setState({ workspaces: sampleWorkspaces });

    act(() => {
      root.render(withTooltip(<WorkspaceSidebar />));
    });

    expect(query("workspace-empty-message")).toBeNull();
    expect(query("workspace-list")).not.toBeNull();
    expect(query("workspace-item-ws-1")).not.toBeNull();
    expect(query("workspace-item-ws-2")).not.toBeNull();
  });

  it("shows workspace names", () => {
    useAppStore.setState({ workspaces: sampleWorkspaces });

    act(() => {
      root.render(withTooltip(<WorkspaceSidebar />));
    });

    expect(query("workspace-name-ws-1")?.textContent).toBe("Dev Setup");
    expect(query("workspace-name-ws-2")?.textContent).toBe("Production");
  });

  it("has a New Workspace button", () => {
    useAppStore.setState({ workspaces: [] });

    act(() => {
      root.render(withTooltip(<WorkspaceSidebar />));
    });

    expect(query("workspace-new-btn")).not.toBeNull();
  });

  it("renders action buttons for each workspace", () => {
    useAppStore.setState({ workspaces: [sampleWorkspaces[0]] });

    act(() => {
      root.render(withTooltip(<WorkspaceSidebar />));
    });

    expect(query("workspace-edit-ws-1")).not.toBeNull();
    expect(query("workspace-duplicate-ws-1")).not.toBeNull();
    expect(query("workspace-delete-ws-1")).not.toBeNull();
  });

  it("keeps the save dialog open and surfaces an error when the save rejects", async () => {
    const saveCurrentAsWorkspace = vi.fn().mockRejectedValue(new Error("disk full"));
    useAppStore.setState({ workspaces: [], saveCurrentAsWorkspace });

    act(() => {
      root.render(withTooltip(<WorkspaceSidebar />));
    });

    openDialogAndConfirm("My Layout");
    await flush();

    expect(saveCurrentAsWorkspace).toHaveBeenCalledWith("My Layout", "all", undefined);
    // Dialog must stay open so the user does not falsely believe the save succeeded.
    expect(query("save-workspace-dialog")).not.toBeNull();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("closes the save dialog and surfaces success when the save resolves", async () => {
    const saveCurrentAsWorkspace = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ workspaces: [], saveCurrentAsWorkspace });

    act(() => {
      root.render(withTooltip(<WorkspaceSidebar />));
    });

    openDialogAndConfirm("My Layout");
    await flush();

    expect(saveCurrentAsWorkspace).toHaveBeenCalledWith("My Layout", "all", undefined);
    expect(query("save-workspace-dialog")).toBeNull();
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("asks for confirmation before deleting and does not delete on click alone", () => {
    const deleteWorkspaceFromBackend = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ workspaces: [sampleWorkspaces[0]], deleteWorkspaceFromBackend });

    act(() => {
      root.render(withTooltip(<WorkspaceSidebar />));
    });

    // No confirm dialog before the delete button is pressed.
    expect(query("confirm-delete-dialog")).toBeNull();

    act(() => (query("workspace-delete-ws-1") as HTMLButtonElement).click());

    // Confirm dialog appears; the backend delete has NOT been called yet.
    expect(query("confirm-delete-dialog")).not.toBeNull();
    expect(deleteWorkspaceFromBackend).not.toHaveBeenCalled();
  });

  it("deletes and surfaces success when the user confirms and the backend resolves", async () => {
    const deleteWorkspaceFromBackend = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ workspaces: [sampleWorkspaces[0]], deleteWorkspaceFromBackend });

    act(() => {
      root.render(withTooltip(<WorkspaceSidebar />));
    });

    act(() => (query("workspace-delete-ws-1") as HTMLButtonElement).click());
    act(() => (query("confirm-delete-confirm") as HTMLButtonElement).click());
    await flush();

    expect(deleteWorkspaceFromBackend).toHaveBeenCalledWith("ws-1");
    expect(query("confirm-delete-dialog")).toBeNull();
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("does not remove the workspace and surfaces an error when the backend delete rejects", async () => {
    const deleteWorkspaceFromBackend = vi.fn().mockRejectedValue(new Error("lock poisoned"));
    useAppStore.setState({ workspaces: [sampleWorkspaces[0]], deleteWorkspaceFromBackend });

    act(() => {
      root.render(withTooltip(<WorkspaceSidebar />));
    });

    act(() => (query("workspace-delete-ws-1") as HTMLButtonElement).click());
    act(() => (query("confirm-delete-confirm") as HTMLButtonElement).click());
    await flush();

    expect(deleteWorkspaceFromBackend).toHaveBeenCalledWith("ws-1");
    // The item must remain visible — a failed delete must not silently vanish.
    expect(query("workspace-item-ws-1")).not.toBeNull();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("surfaces a success toast with the imported count when import succeeds", async () => {
    const loadWorkspaces = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ workspaces: [], loadWorkspaces });
    dialogOpen.mockResolvedValue("/tmp/workspaces.json");
    fsReadTextFile.mockResolvedValue("{}");
    apiImportWorkspaces.mockResolvedValue(3);

    act(() => {
      root.render(withTooltip(<WorkspaceSidebar />));
    });

    act(() => (query("workspace-import-btn") as HTMLButtonElement).click());
    await flush();

    expect(apiImportWorkspaces).toHaveBeenCalledWith("{}");
    expect(loadWorkspaces).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith("Imported 3 workspaces");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("uses singular wording when a single workspace is imported", async () => {
    const loadWorkspaces = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ workspaces: [], loadWorkspaces });
    dialogOpen.mockResolvedValue("/tmp/workspaces.json");
    fsReadTextFile.mockResolvedValue("{}");
    apiImportWorkspaces.mockResolvedValue(1);

    act(() => {
      root.render(withTooltip(<WorkspaceSidebar />));
    });

    act(() => (query("workspace-import-btn") as HTMLButtonElement).click());
    await flush();

    expect(toastSuccess).toHaveBeenCalledWith("Imported 1 workspace");
  });

  it("surfaces an error toast when import fails", async () => {
    const loadWorkspaces = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ workspaces: [], loadWorkspaces });
    dialogOpen.mockResolvedValue("/tmp/workspaces.json");
    fsReadTextFile.mockResolvedValue("not json");
    apiImportWorkspaces.mockRejectedValue(new Error("invalid JSON"));

    act(() => {
      root.render(withTooltip(<WorkspaceSidebar />));
    });

    act(() => (query("workspace-import-btn") as HTMLButtonElement).click());
    await flush();

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("shows no toast when the import file dialog is cancelled", async () => {
    const loadWorkspaces = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ workspaces: [], loadWorkspaces });
    dialogOpen.mockResolvedValue(null);

    act(() => {
      root.render(withTooltip(<WorkspaceSidebar />));
    });

    act(() => (query("workspace-import-btn") as HTMLButtonElement).click());
    await flush();

    expect(apiImportWorkspaces).not.toHaveBeenCalled();
    expect(loadWorkspaces).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("surfaces a success toast when export succeeds", async () => {
    useAppStore.setState({ workspaces: [] });
    apiExportWorkspaces.mockResolvedValue("{}");
    dialogSave.mockResolvedValue("/tmp/out.json");
    fsWriteTextFile.mockResolvedValue(undefined);

    act(() => {
      root.render(withTooltip(<WorkspaceSidebar />));
    });

    act(() => (query("workspace-export-btn") as HTMLButtonElement).click());
    await flush();

    expect(fsWriteTextFile).toHaveBeenCalledWith("/tmp/out.json", "{}");
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("surfaces an error toast when export fails", async () => {
    useAppStore.setState({ workspaces: [] });
    apiExportWorkspaces.mockResolvedValue("{}");
    dialogSave.mockResolvedValue("/tmp/out.json");
    fsWriteTextFile.mockRejectedValue(new Error("permission denied"));

    act(() => {
      root.render(withTooltip(<WorkspaceSidebar />));
    });

    act(() => (query("workspace-export-btn") as HTMLButtonElement).click());
    await flush();

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("shows no toast when the export file dialog is cancelled", async () => {
    useAppStore.setState({ workspaces: [] });
    apiExportWorkspaces.mockResolvedValue("{}");
    dialogSave.mockResolvedValue(null);

    act(() => {
      root.render(withTooltip(<WorkspaceSidebar />));
    });

    act(() => (query("workspace-export-btn") as HTMLButtonElement).click());
    await flush();

    expect(fsWriteTextFile).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});
