import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import React from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { FileEditor, REMOTE_POLL_INTERVAL_MS } from "./FileEditor";
import type { EditorTabMeta } from "@/types/terminal";

// Remote tabs don't OS-watch, but FileEditor still imports onLocalFileChanged;
// stub it so the module resolves (it is never invoked for remote tabs).
vi.mock("@/services/events", () => ({
  onLocalFileChanged: vi.fn(() => Promise.resolve(() => {})),
}));

// Functional Monaco mock: renders a textarea, calls onMount with a small fake
// editor backed by a mutable model string, and reflects model.setValue back
// into the textarea — so the reload path (which drives the model directly) is
// observable end to end. Mirrors the sibling local external-change suite.
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

const TAB_ID = "tab-fe-remote-1";
// An SFTP-backed session tab (SSH). Since the convergence (#2422) SSH file
// editing is backed by the session layer like every other remote transport, so
// even an SFTP-backed tab reads/stats through the `session_*` commands.
const SFTP_META: EditorTabMeta = {
  filePath: "/etc/app.conf",
  isRemote: true,
  sessionBrowser: { sessionId: "sftp-sess-1", connectionType: "ssh" },
};
const SESSION_META: EditorTabMeta = {
  filePath: "/etc/app.conf",
  isRemote: true,
  sessionBrowser: { sessionId: "sess-1", connectionType: "docker" },
};

const INITIAL = "key = 1\n";

// Mutable "remote" state the invoke mock reads. Tests mutate these, then advance
// the poll interval to make the editor observe the change.
let diskContent = INITIAL;
let statValue: { modified: string; size: number } = { modified: "t0", size: INITIAL.length };

function statEntry() {
  return { name: "app.conf", path: SFTP_META.filePath, isDirectory: false, ...statValue };
}

function installInvoke() {
  mockedInvoke.mockImplementation((cmd) => {
    switch (cmd) {
      case "session_read_file":
        return Promise.resolve(Array.from(new TextEncoder().encode(diskContent)));
      case "session_stat":
        return Promise.resolve(statEntry());
      case "session_check_writable":
        return Promise.resolve("unknown");
      case "session_has_exec_capability":
        return Promise.resolve(false);
      case "session_realpath":
        return Promise.resolve("/home/user");
      default:
        return Promise.resolve(undefined);
    }
  });
}

let container: HTMLDivElement;
let root: Root;

function render(meta: EditorTabMeta, isVisible = true) {
  act(() => {
    root.render(<FileEditor tabId={TAB_ID} meta={meta} isVisible={isVisible} />);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
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

/** Advance one poll interval and flush the async stat + reload chain. */
async function pollOnce(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(REMOTE_POLL_INTERVAL_MS + 1);
  });
  await flush();
}

/** Mutate the "remote" file: new content bumps size/mtime. */
function setRemoteFile(content: string, modified = "t1"): void {
  diskContent = content;
  statValue = { modified, size: content.length };
}

function countInvokes(cmd: string): number {
  return mockedInvoke.mock.calls.filter((c) => c[0] === cmd).length;
}

describe("FileEditor — remote external-change poll (#1627)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState({ ...useAppStore.getInitialState() });
    currentModelValue = "";
    diskContent = INITIAL;
    statValue = { modified: "t0", size: INITIAL.length };
    // jsdom reports the window as focused so the poll is not paused.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    installInvoke();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("re-stats an SFTP file on an interval and does not watch it via the OS", async () => {
    render(SFTP_META);
    await flush();
    // No OS file watch for remote files.
    expect(countInvokes("watch_local_file")).toBe(0);
    // Seeds the baseline (immediate stat) on mount…
    const seeded = countInvokes("session_stat");
    expect(seeded).toBeGreaterThan(0);
    // …and keeps polling on the interval.
    await pollOnce();
    expect(countInvokes("session_stat")).toBeGreaterThan(seeded);
  });

  it("reflects the new content on an SFTP mtime/size change with a clean buffer", async () => {
    render(SFTP_META);
    await flush();
    expect(currentModelValue).toBe(INITIAL);

    setRemoteFile("key = 1\nkey = 2 (external)\n");
    await pollOnce();

    expect(currentModelValue).toBe("key = 1\nkey = 2 (external)\n");
    // Clean reload: no conflict banner, buffer stays clean.
    expect(query("file-editor-disk-changed-banner")).toBeNull();
    expect((query("file-editor-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not clobber unsaved edits, surfacing the conflict banner instead", async () => {
    render(SFTP_META);
    await flush();

    editContent("key = 1\nmy local edit\n");
    await flush();
    expect((query("file-editor-save") as HTMLButtonElement).disabled).toBe(false);

    setRemoteFile("key = 1\nexternal edit\n");
    await pollOnce();

    // Edits preserved (not overwritten by the remote change), conflict surfaced.
    expect(currentModelValue).toBe("key = 1\nmy local edit\n");
    expect(query("file-editor-disk-changed-banner")).not.toBeNull();
    expect((query("file-editor-save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not re-read the file when mtime/size is unchanged", async () => {
    render(SFTP_META);
    await flush();
    const readsAfterLoad = countInvokes("session_read_file");

    // Several polls with no remote change.
    await pollOnce();
    await pollOnce();

    // Stat kept polling, but no extra content reads happened.
    expect(countInvokes("session_read_file")).toBe(readsAfterLoad);
    expect(query("file-editor-disk-changed-banner")).toBeNull();
  });

  it("does not poll a remote file that is not the visible tab", async () => {
    render(SFTP_META, /* isVisible */ false);
    await flush();
    await pollOnce();
    expect(countInvokes("session_stat")).toBe(0);
  });

  it("reflects an external change for a session-layer (Docker/FTP/agent) file", async () => {
    render(SESSION_META);
    await flush();
    expect(currentModelValue).toBe(INITIAL);
    expect(countInvokes("session_stat")).toBeGreaterThan(0);

    setRemoteFile("key = 1\nsession external\n");
    await pollOnce();

    expect(currentModelValue).toBe("key = 1\nsession external\n");
    expect(query("file-editor-disk-changed-banner")).toBeNull();
  });
});
