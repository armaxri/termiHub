import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import React from "react";
import { createRoot, Root } from "react-dom/client";
import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { FileEditor } from "./FileEditor";
import type { EditorTabMeta } from "@/types/terminal";

// SEC-012: on mount the editor installs a global Monaco link opener that routes
// link clicks in edited file content through the external-URL scheme allowlist.
// `registerLinkOpener` exists in production Monaco (>= 0.44) but not in older
// Monaco or in the lightweight test mock, so the call is guarded — it must
// register when the API exists and no-op cleanly (never throw on mount) when it
// does not.

vi.mock("@/services/events", () => ({
  onLocalFileChanged: vi.fn(() => Promise.resolve(() => {})),
}));

// Minimal functional @monaco-editor/react mock that fires onMount with a fake
// editor carrying exactly what handleEditorMount reads.
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

// Monaco mock WITH registerLinkOpener present (mirrors production Monaco 0.55).
vi.mock("monaco-editor", () => ({
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { KeyS: 49 },
  editor: {
    setTheme: vi.fn(),
    setModelLanguage: vi.fn(),
    registerLinkOpener: vi.fn(),
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

const TAB_ID = "tab-link-opener-1";
const LOCAL_META: EditorTabMeta = { filePath: "/home/user/notes.txt", isRemote: false };

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(<FileEditor tabId={TAB_ID} meta={LOCAL_META} isVisible={true} />);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("FileEditor — safe Monaco link opener (SEC-012)", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState({ ...useAppStore.getInitialState() });
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "local_read_file") return Promise.resolve("line one\n");
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("registers a link opener on mount when Monaco exposes the API", async () => {
    render();
    await flush();

    expect(monaco.editor.registerLinkOpener).toHaveBeenCalledTimes(1);
    const opener = vi.mocked(monaco.editor.registerLinkOpener).mock.calls[0][0];
    expect(typeof opener.open).toBe("function");
    // The registered opener reports links as handled (routed through the
    // external-URL allowlist rather than Monaco's default OS opener).
    expect(
      opener.open({ toString: () => "https://example.com/docs" } as unknown as monaco.Uri)
    ).toBe(true);
  });
});
