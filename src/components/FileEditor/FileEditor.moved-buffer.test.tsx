import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import React from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { FileEditor } from "./FileEditor";
import type { EditorTabMeta } from "@/types/terminal";
import {
  clearEditorBuffers,
  readEditorBuffer,
  stashCarriedBuffer,
} from "@/utils/editorBufferRegistry";

// Stub the local file watch; keep the module's other exports.
vi.mock("@/services/events", async () => {
  const actual = await vi.importActual<typeof import("@/services/events")>("@/services/events");
  return {
    ...actual,
    onLocalFileChanged: vi.fn(() => Promise.resolve(() => {})),
  };
});

// Functional Monaco mock (mirrors the sibling external-change suite): renders a
// textarea, reflects onChange into a shared `currentModelValue`, and seeds that
// value from `defaultValue` on mount. Because the editor is only rendered once
// `loading` is false, a reload that re-runs the load effect remounts it and
// re-seeds `currentModelValue` from the freshly-loaded content — which is
// exactly the clobber this suite guards against.
let currentModelValue = "";
vi.mock("@monaco-editor/react", () => {
  const MockEditor = ({
    defaultValue,
    onChange,
    onMount,
  }: {
    defaultValue?: string;
    onChange?: (value: string | undefined) => void;
    onMount?: (editor: unknown) => void;
  }) => {
    const ref = React.useRef<HTMLTextAreaElement | null>(null);
    React.useEffect(() => {
      currentModelValue = defaultValue ?? "";
      const ta = ref.current;
      const fakeModel = {
        getValue: () => currentModelValue,
        setValue: (v: string) => {
          currentModelValue = v;
          if (ta) ta.value = v;
          onChange?.(v);
        },
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
        setValue: (v: string) => fakeModel.setValue(v),
      };
      onMount?.(fakeEditor);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return React.createElement("textarea", {
      ref,
      "data-testid": "mock-monaco",
      defaultValue,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        currentModelValue = e.target.value;
        onChange?.(e.target.value);
      },
    });
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
const TAB_ID = "tab-fe-moved-1";
const FILE_PATH = "/home/me/notes.txt";

let container: HTMLDivElement;
let root: Root;
let diskText = "";
let readFails = false;

function render(meta: EditorTabMeta) {
  act(() => {
    root.render(<FileEditor tabId={TAB_ID} meta={meta} isVisible={true} />);
  });
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) {
      await Promise.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function editContent(value: string): void {
  const ta = query("mock-monaco") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  )!.set!;
  act(() => {
    setter.call(ta, value);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("FileEditor — buffers that move between windows (#4412)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState({ ...useAppStore.getInitialState() });
    clearEditorBuffers();
    currentModelValue = "";
    diskText = "disk text\n";
    readFails = false;
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_read_file") {
        return readFails ? Promise.reject(new Error("file not found")) : Promise.resolve(diskText);
      }
      return Promise.resolve(undefined);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("registers its live buffer so a window move can carry it", async () => {
    render({ filePath: FILE_PATH, isRemote: false });
    await flush();
    expect(readEditorBuffer(TAB_ID)).toEqual({
      content: "disk text\n",
      filePath: FILE_PATH,
      scratch: false,
      dirty: false,
    });

    editContent("disk text\nunsaved line\n");
    await flush();

    expect(readEditorBuffer(TAB_ID)).toMatchObject({
      content: "disk text\nunsaved line\n",
      dirty: true,
    });
  });

  it("unregisters its buffer on unmount", async () => {
    render({ filePath: FILE_PATH, isRemote: false });
    await flush();
    act(() => root.render(<></>));
    expect(readEditorBuffer(TAB_ID)).toBeNull();
  });

  it("shows a carried unsaved buffer over the disk content and stays dirty", async () => {
    stashCarriedBuffer(TAB_ID, "moved unsaved text\n");
    render({ filePath: FILE_PATH, isRemote: false });
    await flush();

    expect(currentModelValue).toBe("moved unsaved text\n");
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(true);
    expect(readEditorBuffer(TAB_ID)).toMatchObject({
      content: "moved unsaved text\n",
      dirty: true,
    });
  });

  it("keeps a carried buffer when the file can no longer be read", async () => {
    readFails = true;
    stashCarriedBuffer(TAB_ID, "moved unsaved text\n");
    render({ filePath: FILE_PATH, isRemote: false });
    await flush();

    expect(currentModelValue).toBe("moved unsaved text\n");
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(true);
    expect(query("file-editor-save-error")?.textContent).toContain("file not found");
  });
});
