import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import React from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { FileEditor } from "./FileEditor";
import type { EditorTabMeta } from "@/types/terminal";

// FEC-018 (part 2): while a file tab is zoomed, the zoom overlay mounts the
// authoritative FileEditor and the in-panel copy stays mounted (to own the
// shared Monaco model) but goes dormant. A dormant (`supersededByZoom`) instance
// must not run a second OS file watch, and must not fight the overlay for the
// singleton editor status bar.

vi.mock("@/services/events", () => ({
  onLocalFileChanged: vi.fn(() => Promise.resolve(() => {})),
}));

// Minimal functional Monaco mock that fires onMount with a fake editor carrying
// exactly what handleEditorMount / readEditorStatus read.
vi.mock("@monaco-editor/react", () => {
  const MockEditor = ({
    defaultValue,
    onMount,
  }: {
    defaultValue?: string;
    onMount?: (editor: unknown) => void;
  }) => {
    React.useEffect(() => {
      const fakeModel = {
        getValue: () => defaultValue ?? "",
        setValue: () => {},
        getOptions: () => ({ tabSize: 4, insertSpaces: true }),
        getLanguageId: () => "plaintext",
        getEOL: () => "\n",
        updateOptions: () => {},
        setEOL: () => {},
      };
      const fakeEditor = {
        getModel: () => fakeModel,
        getPosition: () => ({ lineNumber: 1, column: 1 }),
        getDomNode: () => document.createElement("div"),
        addAction: () => {},
        onDidChangeCursorPosition: () => {},
        saveViewState: () => ({}),
        restoreViewState: () => {},
        setValue: () => {},
      };
      onMount?.(fakeEditor);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return React.createElement("textarea", { "data-testid": "mock-monaco", defaultValue });
  };
  return { default: MockEditor, loader: { config: vi.fn() } };
});

vi.mock("monaco-editor", () => ({
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { KeyS: 49 },
  editor: {
    setTheme: vi.fn(),
    setModelLanguage: vi.fn(),
    EndOfLineSequence: { LF: 0, CRLF: 1 },
  },
  languages: {
    getLanguages: vi.fn(() => [{ id: "plaintext", aliases: ["Plain Text"] }]),
    register: vi.fn(),
    setMonarchTokensProvider: vi.fn(),
    setLanguageConfiguration: vi.fn(),
  },
}));

vi.mock("@/themes", () => ({
  getCurrentTheme: () => ({ id: "dark" }),
  onThemeChange: vi.fn(() => vi.fn()),
}));

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const mockedInvoke = vi.mocked(invoke);

const TAB_ID = "tab-superseded-1";
const LOCAL_META: EditorTabMeta = { filePath: "/home/user/notes.txt", isRemote: false };
const INITIAL = "line one\n";

let container: HTMLDivElement;
let root: Root;

function render(supersededByZoom: boolean) {
  act(() => {
    root.render(
      <FileEditor
        tabId={TAB_ID}
        meta={LOCAL_META}
        isVisible={!supersededByZoom}
        supersededByZoom={supersededByZoom}
      />
    );
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function watchCalls() {
  return mockedInvoke.mock.calls.filter((c) => c[0] === "watch_local_file");
}
function unwatchCalls() {
  return mockedInvoke.mock.calls.filter((c) => c[0] === "unwatch_local_file");
}

describe("FileEditor — dormant while superseded by zoom (FEC-018)", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState({ ...useAppStore.getInitialState() });
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "local_read_file") return Promise.resolve(INITIAL);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("does not register an OS file watch while superseded", async () => {
    render(true);
    await flush();
    expect(watchCalls()).toHaveLength(0);
  });

  it("does not drive the global editor status bar while superseded", async () => {
    render(true);
    await flush();
    // The overlay copy is authoritative; the dormant instance leaves the
    // singleton status/actions untouched (never sets, never nulls).
    expect(useAppStore.getState().editorStatus).toBeNull();
    expect(useAppStore.getState().editorActions).toBeNull();
  });

  it("watches and drives status normally when NOT superseded", async () => {
    render(false);
    await flush();
    expect(watchCalls()).toHaveLength(1);
    expect(useAppStore.getState().editorStatus).not.toBeNull();
  });

  it("drops its watch and stops nulling status when it becomes superseded", async () => {
    render(false);
    await flush();
    expect(watchCalls()).toHaveLength(1);
    expect(useAppStore.getState().editorStatus).not.toBeNull();

    // Zoom opens for this tab: the in-panel copy becomes superseded + hidden.
    render(true);
    await flush();

    // Its watch is torn down (leaving only the overlay's), so the file is not
    // double-watched while zoomed.
    expect(unwatchCalls().length).toBeGreaterThanOrEqual(1);
    expect(watchCalls()).toHaveLength(1); // no new watch registered

    // Crucially it does NOT null the status the overlay is now driving — the
    // status the previous (visible) render pushed is left intact.
    expect(useAppStore.getState().editorStatus).not.toBeNull();
  });
});
