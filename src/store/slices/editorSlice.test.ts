import { describe, it, expect, beforeEach, vi } from "vitest";
import { create, type StateCreator } from "zustand";

import type { EditorStatus, EditorActions } from "@/types/terminal";

vi.mock("@/services/api", () => ({
  vscodeAvailable: vi.fn(),
}));

import { vscodeAvailable as apiVscodeAvailable } from "@/services/api";
import { createEditorSlice, type EditorSlice } from "./editorSlice";

const mockedVscode = vi.mocked(apiVscodeAvailable);

// Drive the slice directly against a standalone zustand store: its `get()` only
// ever reads its own state here, so the AppState-scoped creator can be re-typed
// to the isolated slice shape.
const makeStore = () =>
  create<EditorSlice>()(createEditorSlice as unknown as StateCreator<EditorSlice>);

const status = (over: Partial<EditorStatus> = {}): EditorStatus => ({
  line: 1,
  column: 1,
  language: "typescript",
  availableLanguages: [],
  encoding: "UTF-8",
  eol: "LF",
  insertSpaces: true,
  tabSize: 2,
  ...over,
});

describe("editorSlice", () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeStore();
  });

  it("starts with VS Code unavailable and no editor status/actions", () => {
    expect(store.getState().vscodeAvailable).toBe(false);
    expect(store.getState().editorStatus).toBeNull();
    expect(store.getState().editorActions).toBeNull();
  });

  it("checkVscodeAvailability reflects the backend probe result", async () => {
    mockedVscode.mockResolvedValueOnce(true);
    await store.getState().checkVscodeAvailability();
    expect(store.getState().vscodeAvailable).toBe(true);
  });

  it("checkVscodeAvailability leaves the flag false and does not throw on error", async () => {
    mockedVscode.mockRejectedValueOnce(new Error("no code cli"));
    await expect(store.getState().checkVscodeAvailability()).resolves.toBeUndefined();
    expect(store.getState().vscodeAvailable).toBe(false);
  });

  it("setEditorStatus / setEditorActions store and clear the handles", () => {
    const actions: EditorActions = {
      setIndent: vi.fn(),
      toggleEol: vi.fn(),
      setLanguage: vi.fn(),
      moveCursor: vi.fn(),
    };
    store.getState().setEditorStatus(status({ line: 4, column: 2 }));
    store.getState().setEditorActions(actions);
    expect(store.getState().editorStatus).toMatchObject({ line: 4, column: 2 });
    expect(store.getState().editorActions).toBe(actions);

    store.getState().setEditorStatus(null);
    store.getState().setEditorActions(null);
    expect(store.getState().editorStatus).toBeNull();
    expect(store.getState().editorActions).toBeNull();
  });
});
