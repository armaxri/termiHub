import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { MacroSidebar } from "./MacroSidebar";
import { withTooltip } from "@/test/tooltip";
import type { Macro } from "@/types/macro";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

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

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();

// Keep the real UI primitives so the ConfirmDeleteDialog/Modal render, but spy
// on the toast helpers to assert action feedback.
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

function setSearch(value: string) {
  const input = query("macro-search") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

const sampleMacros: Macro[] = [
  {
    id: "macro-1",
    name: "Deploy sequence",
    description: "Runs the deploy",
    tags: ["ops", "release"],
    steps: [{ data: "deploy\r", delayMs: 0 }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "macro-2",
    name: "Login banner",
    tags: [],
    steps: [{ data: "whoami\r", delayMs: 10 }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

describe("MacroSidebar", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    // Reset the store slice used by this component to known defaults.
    useAppStore.setState({
      macros: [],
      startMacroRecording: vi.fn(),
      playMacro: vi.fn().mockResolvedValue(undefined),
      saveMacroToBackend: vi.fn().mockResolvedValue(undefined),
      deleteMacroFromBackend: vi.fn().mockResolvedValue(undefined),
      importMacros: vi.fn().mockResolvedValue(0),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render() {
    act(() => {
      root.render(withTooltip(<MacroSidebar />));
    });
  }

  it("shows the empty message when no macros exist", () => {
    render();
    expect(query("macro-empty-message")).not.toBeNull();
    expect(query("macro-list")).toBeNull();
  });

  it("renders a row for each macro", () => {
    useAppStore.setState({ macros: sampleMacros });
    render();
    expect(query("macro-list")).not.toBeNull();
    expect(query("macro-item-macro-1")).not.toBeNull();
    expect(query("macro-item-macro-2")).not.toBeNull();
    expect(query("macro-name-macro-1")?.textContent).toBe("Deploy sequence");
  });

  it("filters the list by the search query across name/description/tags", () => {
    useAppStore.setState({ macros: sampleMacros });
    render();

    setSearch("login");
    expect(query("macro-item-macro-2")).not.toBeNull();
    expect(query("macro-item-macro-1")).toBeNull();

    // Matches on a tag, too.
    setSearch("release");
    expect(query("macro-item-macro-1")).not.toBeNull();
    expect(query("macro-item-macro-2")).toBeNull();
  });

  it("shows a no-results state when the query matches nothing", () => {
    useAppStore.setState({ macros: sampleMacros });
    render();
    setSearch("nonexistent");
    expect(query("macro-no-results")).not.toBeNull();
    expect(query("macro-list")).toBeNull();
  });

  it("starts recording when the record button is clicked", () => {
    const startMacroRecording = vi.fn();
    useAppStore.setState({ macros: [], startMacroRecording });
    render();
    act(() => (query("macro-record-btn") as HTMLButtonElement).click());
    expect(startMacroRecording).toHaveBeenCalledTimes(1);
  });

  it("plays a macro when its Play action is clicked", () => {
    const playMacro = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ macros: sampleMacros, playMacro });
    render();
    act(() => (query("macro-play-macro-1") as HTMLButtonElement).click());
    expect(playMacro).toHaveBeenCalledWith("macro-1");
  });

  it("duplicates a macro through the backend and reports success", async () => {
    const saveMacroToBackend = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ macros: sampleMacros, saveMacroToBackend });
    render();

    act(() => (query("macro-duplicate-macro-1") as HTMLButtonElement).click());
    await flush();

    expect(saveMacroToBackend).toHaveBeenCalledTimes(1);
    const saved = saveMacroToBackend.mock.calls[0][0] as Macro;
    expect(saved.name).toBe("Copy of Deploy sequence");
    expect(saved.id).not.toBe("macro-1");
    expect(saved.steps).toEqual(sampleMacros[0].steps);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("asks for confirmation before deleting and does not delete on click alone", () => {
    const deleteMacroFromBackend = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ macros: [sampleMacros[0]], deleteMacroFromBackend });
    render();

    expect(query("confirm-delete-dialog")).toBeNull();
    act(() => (query("macro-delete-macro-1") as HTMLButtonElement).click());
    expect(query("confirm-delete-dialog")).not.toBeNull();
    expect(deleteMacroFromBackend).not.toHaveBeenCalled();
  });

  it("deletes and reports success when the user confirms", async () => {
    const deleteMacroFromBackend = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ macros: [sampleMacros[0]], deleteMacroFromBackend });
    render();

    act(() => (query("macro-delete-macro-1") as HTMLButtonElement).click());
    act(() => (query("confirm-delete-confirm") as HTMLButtonElement).click());
    await flush();

    expect(deleteMacroFromBackend).toHaveBeenCalledWith("macro-1");
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("opens the editor dialog when a macro's Edit action is clicked", () => {
    useAppStore.setState({ macros: sampleMacros });
    render();
    expect(query("macro-editor-dialog")).toBeNull();
    act(() => (query("macro-edit-macro-1") as HTMLButtonElement).click());
    expect(query("macro-editor-dialog")).not.toBeNull();
    expect((query("macro-editor-name") as HTMLInputElement).value).toBe("Deploy sequence");
  });

  it("disables Export All when there are no macros", () => {
    render();
    expect((query("macro-export-all-btn") as HTMLButtonElement).disabled).toBe(true);
  });

  it("exports the whole library to a chosen file", async () => {
    useAppStore.setState({ macros: sampleMacros });
    dialogSave.mockResolvedValue("/tmp/macros.json");
    fsWriteTextFile.mockResolvedValue(undefined);
    render();

    act(() => (query("macro-export-all-btn") as HTMLButtonElement).click());
    await flush();

    expect(fsWriteTextFile).toHaveBeenCalledTimes(1);
    const [, written] = fsWriteTextFile.mock.calls[0];
    const envelope = JSON.parse(written as string);
    expect(envelope.macros).toHaveLength(2);
    expect(toastSuccess).toHaveBeenCalledWith("Exported 2 macros");
  });

  it("exports a single macro from its row action", async () => {
    useAppStore.setState({ macros: sampleMacros });
    dialogSave.mockResolvedValue("/tmp/macro.json");
    fsWriteTextFile.mockResolvedValue(undefined);
    render();

    act(() => (query("macro-export-macro-1") as HTMLButtonElement).click());
    await flush();

    const [, written] = fsWriteTextFile.mock.calls[0];
    const envelope = JSON.parse(written as string);
    expect(envelope.macros).toHaveLength(1);
    expect(envelope.macros[0].name).toBe("Deploy sequence");
    expect(toastSuccess).toHaveBeenCalledWith('Exported "Deploy sequence"');
  });

  it("shows no toast when the export dialog is cancelled", async () => {
    useAppStore.setState({ macros: sampleMacros });
    dialogSave.mockResolvedValue(null);
    render();

    act(() => (query("macro-export-all-btn") as HTMLButtonElement).click());
    await flush();

    expect(fsWriteTextFile).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("imports macros from a chosen file", async () => {
    const importMacros = vi.fn().mockResolvedValue(3);
    useAppStore.setState({ macros: [], importMacros });
    dialogOpen.mockResolvedValue("/tmp/macros.json");
    fsReadTextFile.mockResolvedValue('{"version":1,"macros":[]}');
    render();

    act(() => (query("macro-import-btn") as HTMLButtonElement).click());
    await flush();

    expect(importMacros).toHaveBeenCalledWith('{"version":1,"macros":[]}');
    expect(toastSuccess).toHaveBeenCalledWith("Imported 3 macros");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("surfaces an error toast when the import file is malformed", async () => {
    const importMacros = vi.fn().mockRejectedValue(new Error("Invalid macro file"));
    useAppStore.setState({ macros: [], importMacros });
    dialogOpen.mockResolvedValue("/tmp/bad.json");
    fsReadTextFile.mockResolvedValue("{not json");
    render();

    act(() => (query("macro-import-btn") as HTMLButtonElement).click());
    await flush();

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("shows no toast when the import dialog is cancelled", async () => {
    const importMacros = vi.fn().mockResolvedValue(0);
    useAppStore.setState({ macros: [], importMacros });
    dialogOpen.mockResolvedValue(null);
    render();

    act(() => (query("macro-import-btn") as HTMLButtonElement).click());
    await flush();

    expect(importMacros).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});
