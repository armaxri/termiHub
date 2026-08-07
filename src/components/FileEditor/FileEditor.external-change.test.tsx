import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import React from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { FileEditor } from "./FileEditor";
import type { EditorTabMeta } from "@/types/terminal";

// Capture the external-change event callback the editor registers so the test
// can fire a simulated `local-file-changed` event at it.
let fileChangeCb: ((watchId: string, path: string) => void) | null = null;
vi.mock("@/services/events", () => ({
  onLocalFileChanged: vi.fn((cb: (watchId: string, path: string) => void) => {
    fileChangeCb = cb;
    return Promise.resolve(() => {
      fileChangeCb = null;
    });
  }),
}));

// Functional Monaco mock: renders a textarea, calls onMount with a small fake
// editor backed by a mutable model string, and reflects model.setValue back
// into the textarea. This lets the reload path (which drives the Monaco model
// directly, since the real editor is uncontrolled) be observed end to end.
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

// This suite mounts the editor (calls onMount), unlike the sibling suite, so the
// monaco mock must carry the keybinding/EOL constants handleEditorMount reads.
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

const TAB_ID = "tab-fe-ext-1";
const LOCAL_META: EditorTabMeta = {
  filePath: "/home/user/notes.txt",
  isRemote: false,
};
const REMOTE_META: EditorTabMeta = {
  filePath: "/etc/hosts",
  isRemote: true,
  sessionBrowser: { sessionId: "sftp-sess-1", connectionType: "ssh" },
};

const INITIAL = "line one\n";

let container: HTMLDivElement;
let root: Root;

function render(meta: EditorTabMeta = LOCAL_META) {
  act(() => {
    root.render(<FileEditor tabId={TAB_ID} meta={meta} isVisible={true} />);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function clickButton(testId: string): void {
  const btn = query(testId) as HTMLButtonElement | null;
  expect(btn, `${testId} should be present`).not.toBeNull();
  act(() => {
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
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

/** Read the watchId the editor registered via the watch_local_file invoke. */
function registeredWatchId(): string {
  const call = mockedInvoke.mock.calls.find((c) => c[0] === "watch_local_file");
  expect(call, "watch_local_file should have been invoked").toBeDefined();
  return (call![1] as { watchId: string }).watchId;
}

async function fireExternalChange(diskContent: string): Promise<void> {
  // The next local_read_file resolves with the new on-disk content.
  mockedInvoke.mockImplementation((cmd) => {
    if (cmd === "local_read_file") return Promise.resolve(diskContent);
    return Promise.resolve(undefined);
  });
  const watchId = registeredWatchId();
  await act(async () => {
    fileChangeCb?.(watchId, LOCAL_META.filePath);
  });
  // Frontend debounce is 150ms; advance past it, then flush the async reload.
  await act(async () => {
    vi.advanceTimersByTime(200);
  });
  await flush();
}

describe("FileEditor — external on-disk change reload (#1620)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState({ ...useAppStore.getInitialState() });
    fileChangeCb = null;
    currentModelValue = "";
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "local_read_file") return Promise.resolve(INITIAL);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.useRealTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("registers a watch for a local file on mount and tears it down on unmount", async () => {
    render();
    await flush();

    const watchCall = mockedInvoke.mock.calls.find((c) => c[0] === "watch_local_file");
    expect(watchCall).toBeDefined();
    expect((watchCall![1] as { path: string }).path).toBe(LOCAL_META.filePath);

    act(() => root.unmount());
    // Re-create a root so afterEach's unmount is a harmless no-op.
    root = createRoot(container);

    const unwatchCall = mockedInvoke.mock.calls.find((c) => c[0] === "unwatch_local_file");
    expect(unwatchCall).toBeDefined();
  });

  it("does not watch a remote file", async () => {
    render(REMOTE_META);
    await flush();
    const watchCall = mockedInvoke.mock.calls.find((c) => c[0] === "watch_local_file");
    expect(watchCall).toBeUndefined();
  });

  it("reflects the new on-disk content when the buffer has no unsaved edits", async () => {
    render();
    await flush();
    expect(currentModelValue).toBe(INITIAL);

    await fireExternalChange("line one\nline two (external)\n");

    expect(currentModelValue).toBe("line one\nline two (external)\n");
    // Clean reload: no conflict notice, buffer not marked dirty.
    expect(query("file-editor-disk-changed-banner")).toBeNull();
    expect((query("file-editor-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not clobber unsaved edits, and surfaces a conflict notice instead", async () => {
    render();
    await flush();

    // Local edit → buffer dirty.
    editContent("line one\nmy local edit\n");
    await flush();
    expect((query("file-editor-save") as HTMLButtonElement).disabled).toBe(false);

    await fireExternalChange("line one\nexternal edit\n");

    // Edits preserved (not overwritten by disk), and the conflict is surfaced.
    expect(currentModelValue).toBe("line one\nmy local edit\n");
    expect(query("file-editor-disk-changed-banner")).not.toBeNull();
    expect((query("file-editor-save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("'Reload from disk' discards unsaved edits and loads the on-disk version", async () => {
    render();
    await flush();

    editContent("line one\nmy local edit\n");
    await flush();
    await fireExternalChange("line one\nexternal edit\n");
    // Precondition: conflict banner up, buffer dirty, disk version differs.
    expect(query("file-editor-disk-changed-banner")).not.toBeNull();
    expect((query("file-editor-save") as HTMLButtonElement).disabled).toBe(false);

    clickButton("file-editor-disk-changed-reload");
    await flush();

    // Buffer now holds the disk content, is clean (matches disk), banner gone.
    expect(currentModelValue).toBe("line one\nexternal edit\n");
    expect(query("file-editor-disk-changed-banner")).toBeNull();
    expect((query("file-editor-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("'Keep my changes' dismisses the banner, keeps edits dirty, and a later save still writes", async () => {
    render();
    await flush();

    editContent("line one\nmy local edit\n");
    await flush();
    await fireExternalChange("line one\nexternal edit\n");
    expect(query("file-editor-disk-changed-banner")).not.toBeNull();

    clickButton("file-editor-disk-changed-keep");
    await flush();

    // Banner dismissed, but the buffer keeps the local edits and stays dirty.
    expect(query("file-editor-disk-changed-banner")).toBeNull();
    expect(currentModelValue).toBe("line one\nmy local edit\n");
    expect((query("file-editor-save") as HTMLButtonElement).disabled).toBe(false);

    // A subsequent save is not blocked and writes the user's version to disk.
    mockedInvoke.mockClear();
    clickButton("file-editor-save");
    await flush();
    const writeCall = mockedInvoke.mock.calls.find((c) => c[0] === "local_write_file");
    expect(writeCall, "save should invoke local_write_file").toBeDefined();
    expect((writeCall![1] as { content: string }).content).toBe("line one\nmy local edit\n");
    // Buffer is now saved/clean.
    expect((query("file-editor-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("re-surfaces the banner when the file changes on disk again after 'Keep my changes'", async () => {
    render();
    await flush();

    editContent("line one\nmy local edit\n");
    await flush();
    await fireExternalChange("line one\nexternal edit\n");
    expect(query("file-editor-disk-changed-banner")).not.toBeNull();

    clickButton("file-editor-disk-changed-keep");
    await flush();
    expect(query("file-editor-disk-changed-banner")).toBeNull();

    // A *new* on-disk change (not the one already dismissed) surfaces again —
    // dismissing one change does not mute the file.
    await fireExternalChange("line one\nanother external edit\n");
    expect(query("file-editor-disk-changed-banner")).not.toBeNull();
    // Edits still preserved.
    expect(currentModelValue).toBe("line one\nmy local edit\n");
  });
});
