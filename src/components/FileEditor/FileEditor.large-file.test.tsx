import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import React from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { FileEditor, LARGE_FILE_THRESHOLD_BYTES } from "./FileEditor";
import type { EditorTabMeta } from "@/types/terminal";

// The large-file guard (#PROD-014 / #PERF-002) stats a file before reading it
// and refuses to load blindly above LARGE_FILE_THRESHOLD_BYTES. These tests
// verify that over-threshold files hit the warning path (no eager read) while
// under-threshold files open exactly as before.

// Local editor tabs start a file watch that registers a `local-file-changed`
// listener; stub it so the watch effect is inert in jsdom.
vi.mock("@/services/events", () => ({
  onLocalFileChanged: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@monaco-editor/react", () => ({
  default: ({
    defaultValue,
    onChange,
  }: {
    defaultValue?: string;
    onChange?: (value: string | undefined) => void;
  }) =>
    React.createElement("textarea", {
      "data-testid": "mock-monaco",
      defaultValue,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => onChange?.(e.target.value),
    }),
  loader: { config: vi.fn() },
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

const OVER = LARGE_FILE_THRESHOLD_BYTES + 1;
const UNDER = 1024;

const LOCAL_META: EditorTabMeta = { filePath: "/var/log/huge.log", isRemote: false };
const REMOTE_META: EditorTabMeta = {
  filePath: "/var/log/huge.log",
  isRemote: true,
  sessionBrowser: { sessionId: "sess-1", connectionType: "ssh" },
};

/** A minimal FileEntry — the guard only reads `.size`. */
function entry(size: number) {
  return {
    name: "huge.log",
    path: "/var/log/huge.log",
    isDirectory: false,
    size,
    modified: "",
    permissions: null,
    writable: null,
  };
}

let container: HTMLDivElement;
let root: Root;

function render(meta: EditorTabMeta) {
  act(() => {
    root.render(<FileEditor tabId="tab-lf-1" meta={meta} isVisible={true} />);
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

describe("FileEditor — large-file guard (#PROD-014 / #PERF-002)", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState({ ...useAppStore.getInitialState() });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("shows the guard and does NOT read an over-threshold local file", async () => {
    let readCalled = false;
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "local_stat") return Promise.resolve(entry(OVER));
      if (cmd === "local_read_file") {
        readCalled = true;
        return Promise.resolve("contents");
      }
      return Promise.resolve(undefined);
    });

    render(LOCAL_META);
    await flush();

    expect(query("file-editor-large-file-guard")).not.toBeNull();
    // Nothing was loaded into the editor and the whole-file read never ran.
    expect(query("mock-monaco")).toBeNull();
    expect(readCalled).toBe(false);
  });

  it("loads the file after the user chooses 'Open anyway'", async () => {
    let readCalled = false;
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "local_stat") return Promise.resolve(entry(OVER));
      if (cmd === "local_read_file") {
        readCalled = true;
        return Promise.resolve("contents");
      }
      return Promise.resolve(undefined);
    });

    render(LOCAL_META);
    await flush();

    const openBtn = query("file-editor-large-file-open") as HTMLButtonElement | null;
    expect(openBtn).not.toBeNull();
    act(() => openBtn!.click());
    await flush();

    expect(query("file-editor-large-file-guard")).toBeNull();
    expect(query("mock-monaco")).not.toBeNull();
    expect(readCalled).toBe(true);
  });

  it("opens an under-threshold local file normally, without a guard", async () => {
    let readCalled = false;
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "local_stat") return Promise.resolve(entry(UNDER));
      if (cmd === "local_read_file") {
        readCalled = true;
        return Promise.resolve("small file");
      }
      return Promise.resolve(undefined);
    });

    render(LOCAL_META);
    await flush();

    expect(query("file-editor-large-file-guard")).toBeNull();
    expect(query("mock-monaco")).not.toBeNull();
    expect(readCalled).toBe(true);
  });

  it("guards an over-threshold remote file without reading it over IPC", async () => {
    let readCalled = false;
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "session_stat") return Promise.resolve(entry(OVER));
      if (cmd === "session_read_file") {
        readCalled = true;
        return Promise.resolve([]);
      }
      return Promise.resolve(undefined);
    });

    render(REMOTE_META);
    await flush();

    expect(query("file-editor-large-file-guard")).not.toBeNull();
    expect(query("mock-monaco")).toBeNull();
    expect(readCalled).toBe(false);
  });

  it("falls through to a normal load when the size probe fails", async () => {
    let readCalled = false;
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "local_stat") return Promise.reject(new Error("stat failed"));
      if (cmd === "local_read_file") {
        readCalled = true;
        return Promise.resolve("contents");
      }
      return Promise.resolve(undefined);
    });

    render(LOCAL_META);
    await flush();

    // A failed probe must never block opening an ordinary file.
    expect(query("file-editor-large-file-guard")).toBeNull();
    expect(query("mock-monaco")).not.toBeNull();
    expect(readCalled).toBe(true);
  });
});
