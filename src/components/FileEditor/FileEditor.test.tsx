import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import React from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { FileEditor } from "./FileEditor";
import type { EditorTabMeta } from "@/types/terminal";

// Render Monaco as a plain textarea so the editor mounts in jsdom and we can
// drive content changes through its onChange.
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

const TAB_ID = "tab-fe-1";
const REMOTE_META: EditorTabMeta = {
  filePath: "/etc/hosts",
  isRemote: true,
  sftpSessionId: "sftp-sess-1",
};

let container: HTMLDivElement;
let root: Root;

function render(meta: EditorTabMeta = REMOTE_META) {
  act(() => {
    root.render(<FileEditor tabId={TAB_ID} meta={meta} isVisible={true} />);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

/** Type into the mock Monaco textarea the way React expects (native setter + input event). */
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

describe("FileEditor — save error handling (#969)", () => {
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

  it("surfaces a permission-denied save failure and keeps the buffer dirty", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "sftp_read_file_content") return Promise.resolve("127.0.0.1 localhost\n");
      if (cmd === "sftp_write_file_content")
        return Promise.reject(new Error("create remote file: permission denied"));
      return Promise.resolve(undefined);
    });

    render();
    await flush();

    // Make an edit so the buffer is dirty and Save is enabled.
    editContent("127.0.0.1 localhost\n10.0.0.1 edited\n");
    await flush();

    const saveBtn = query("file-editor-save") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);

    // No error before the save attempt.
    expect(query("file-editor-save-error")).toBeNull();

    await act(async () => {
      saveBtn.click();
    });
    await flush();

    // The failure is surfaced with a clear, permission-specific message...
    const banner = query("file-editor-save-error");
    expect(banner).not.toBeNull();
    expect(banner?.textContent ?? "").toMatch(/permission denied/i);

    // ...and the buffer stays dirty/unsaved so the user can retry.
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(true);
    expect((query("file-editor-save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a generic save-failed message for non-permission errors", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "sftp_read_file_content") return Promise.resolve("data\n");
      if (cmd === "sftp_write_file_content")
        return Promise.reject(new Error("disk quota exceeded"));
      return Promise.resolve(undefined);
    });

    render();
    await flush();
    editContent("data\nmore\n");
    await flush();

    await act(async () => {
      (query("file-editor-save") as HTMLButtonElement).click();
    });
    await flush();

    const banner = query("file-editor-save-error");
    expect(banner?.textContent ?? "").toMatch(/disk quota exceeded/i);
  });

  it("clears a prior save error when a later save succeeds", async () => {
    let failNext = true;
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "sftp_read_file_content") return Promise.resolve("v1\n");
      if (cmd === "sftp_write_file_content") {
        if (failNext) return Promise.reject(new Error("permission denied"));
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    render();
    await flush();
    editContent("v1\nv2\n");
    await flush();

    await act(async () => {
      (query("file-editor-save") as HTMLButtonElement).click();
    });
    await flush();
    expect(query("file-editor-save-error")).not.toBeNull();

    // Second save succeeds → banner clears and the buffer is clean.
    failNext = false;
    await act(async () => {
      (query("file-editor-save") as HTMLButtonElement).click();
    });
    await flush();

    expect(query("file-editor-save-error")).toBeNull();
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(false);
  });
});

describe("FileEditor — close while in error state (#971)", () => {
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

  it("clears the dirty flag when the file fails to load, so the tab is closable", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "sftp_read_file_content") return Promise.reject(new Error("ssh session closed"));
      return Promise.resolve(undefined);
    });
    // Simulate a tab that was dirty before the connection dropped.
    useAppStore.setState({ editorDirtyTabs: { [TAB_ID]: true } });

    render();
    await flush();

    // The error view is shown...
    expect(query("file-editor-error")).not.toBeNull();
    // ...and the dirty flag is cleared so TabBar won't raise a stuck close prompt.
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(false);
  });

  it("resolves an already-pending close request by closing the failed tab", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "sftp_read_file_content") return Promise.reject(new Error("ssh session closed"));
      return Promise.resolve(undefined);
    });
    const closeTabSpy = vi.fn();
    useAppStore.setState({
      closeTab: closeTabSpy,
      pendingCloseRequest: { tabId: TAB_ID, panelId: "panel-1" },
    });

    render();
    await flush();

    expect(closeTabSpy).toHaveBeenCalledWith(TAB_ID, "panel-1");
    expect(useAppStore.getState().pendingCloseRequest).toBeNull();
  });
});

describe("FileEditor — toolbar composes shared UI primitives (#1358)", () => {
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

  it("renders the Save action as a shared Button primitive", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "sftp_read_file_content") return Promise.resolve("data\n");
      return Promise.resolve(undefined);
    });
    render();
    await flush();

    const saveBtn = query("file-editor-save") as HTMLButtonElement;
    expect(saveBtn).not.toBeNull();
    expect(saveBtn.classList.contains("ui-btn")).toBe(true);
  });

  it("renders the save-error dismiss as a shared Button primitive", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "sftp_read_file_content") return Promise.resolve("data\n");
      if (cmd === "sftp_write_file_content") return Promise.reject(new Error("permission denied"));
      return Promise.resolve(undefined);
    });
    render();
    await flush();
    editContent("data\nmore\n");
    await flush();
    await act(async () => {
      (query("file-editor-save") as HTMLButtonElement).click();
    });
    await flush();

    const dismiss = query("file-editor-save-error-dismiss") as HTMLButtonElement;
    expect(dismiss).not.toBeNull();
    expect(dismiss.classList.contains("ui-btn")).toBe(true);
  });
});
