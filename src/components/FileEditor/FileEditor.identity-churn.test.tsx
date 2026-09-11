import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import React from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { FileEditor } from "./FileEditor";
import type { EditorTabMeta } from "@/types/terminal";

// A remote tab never calls onLocalFileChanged (the local watch is gated on
// !isRemote), but keep the real module's other exports — notably
// base64ToBytes, which sessionReadFile relies on to decode file content.
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

const TAB_ID = "tab-fe-churn-1";
const SESSION_ID = "sftp-sess-1";
const FILE_PATH = "/etc/hosts";

/** A remote editor tab meta with a fresh `sessionBrowser` object each call. */
function remoteMeta(sessionId = SESSION_ID, filePath = FILE_PATH): EditorTabMeta {
  return {
    filePath,
    isRemote: true,
    // A NEW object literal every call — this is the identity churn under test.
    sessionBrowser: { sessionId, connectionType: "ssh" },
  };
}

let container: HTMLDivElement;
let root: Root;
// The text the next `session_read_file` should return (mutated per scenario).
let diskText = "";

function render(meta: EditorTabMeta) {
  act(() => {
    root.render(<FileEditor tabId={TAB_ID} meta={meta} isVisible={true} />);
  });
}

async function flush() {
  // The remote load chains several awaits (size stat → read → decode), so drain
  // the microtask queue generously and let any macrotask settle in between.
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

describe("FileEditor — load identity churn / dirty guard (FEC-011)", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState({ ...useAppStore.getInitialState() });
    currentModelValue = "";
    diskText = "disk original\n";
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "session_read_file") return Promise.resolve(btoa(diskText));
      if (cmd === "session_stat") return Promise.resolve({ size: diskText.length, modified: "t0" });
      // Not SFTP-backed → advancedOps stays null (no writability/home probes).
      if (cmd === "session_has_exec_capability")
        return Promise.reject(new Error("not sftp-backed"));
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  // (a) The core FEC-011 case: the SAME file's meta-object identity churns (a
  // fresh `sessionBrowser` ref, same session) while the buffer is dirty. The
  // load effect must NOT re-read disk over the unsaved edits. Against the old
  // object-ref-keyed unconditional load this fails: the churn re-runs the effect
  // and setContent(disk) clobbers the edits back to "disk original".
  it("keeps unsaved edits when the meta object identity churns for the same file", async () => {
    render(remoteMeta());
    await flush();
    expect(currentModelValue).toBe("disk original\n");

    editContent("my unsaved work\n");
    await flush();
    expect(currentModelValue).toBe("my unsaved work\n");

    // Identity churn: new meta + new sessionBrowser object, SAME session/file.
    render(remoteMeta());
    await flush();

    // Edits preserved — not overwritten by a silent disk reload.
    expect(currentModelValue).toBe("my unsaved work\n");
  });

  // (a2) Defense-in-depth: even when the churn changes the session id itself
  // (a genuine reconnect, which DOES re-run the load effect), the dirty guard
  // preserves the in-progress buffer rather than clobbering it with disk.
  it("keeps unsaved edits across a reconnect (new session id) while dirty", async () => {
    render(remoteMeta());
    await flush();

    editContent("my unsaved work\n");
    await flush();

    // Reconnect: same file, brand new session id.
    render(remoteMeta("sftp-sess-2"));
    await flush();

    expect(currentModelValue).toBe("my unsaved work\n");
  });

  // (b) A genuinely different file must still load its own content normally.
  it("loads content normally when the tab points at a different file", async () => {
    render(remoteMeta(SESSION_ID, "/etc/hosts"));
    await flush();
    expect(currentModelValue).toBe("disk original\n");

    // Point the tab at a different file whose disk content differs.
    diskText = "other file body\n";
    render(remoteMeta(SESSION_ID, "/etc/motd"));
    await flush();

    expect(currentModelValue).toBe("other file body\n");
  });

  // (c) A clean (non-dirty) buffer may still refresh from disk when the load
  // effect legitimately re-runs (e.g. a reconnect with a new session id).
  it("refreshes a clean buffer from disk on a reconnect", async () => {
    render(remoteMeta());
    await flush();
    expect(currentModelValue).toBe("disk original\n");

    // No local edits → buffer clean. Reconnect with new disk content.
    diskText = "refreshed from disk\n";
    render(remoteMeta("sftp-sess-2"));
    await flush();

    expect(currentModelValue).toBe("refreshed from disk\n");
  });
});
