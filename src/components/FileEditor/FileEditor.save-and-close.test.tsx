import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import React from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/store/appStore";
import { FileEditor } from "./FileEditor";
import type { EditorTabMeta } from "@/types/terminal";

// Render Monaco as a plain textarea so the editor mounts in jsdom and we can
// drive content changes through its onChange (mirrors FileEditor.test.tsx).
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

/** Base64 of a string's UTF-8 bytes — the shape `session_read_file` returns. */
function toB64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const TAB_ID = "tab-fe-close-1";
const PANEL_ID = "panel-1";

const LOCAL_META: EditorTabMeta = {
  filePath: "/tmp/note.txt",
  isRemote: false,
};

const SCRATCH_META: EditorTabMeta = {
  filePath: "untitled.txt",
  isRemote: false,
  scratch: true,
  scratchContent: "captured terminal output\n",
};

const REMOTE_RO_META: EditorTabMeta = {
  filePath: "/etc/hosts",
  isRemote: true,
  sessionBrowser: { sessionId: "sftp-sess-1", connectionType: "ssh" },
  permissions: "-rw-r--r--",
};

let container: HTMLDivElement;
let root: Root;

function render(meta: EditorTabMeta) {
  act(() => {
    root.render(<FileEditor tabId={TAB_ID} meta={meta} isVisible={true} />);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Query the editor's own DOM (banners, toolbar). */
function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

/** Query portalled (Radix) dialog content from the whole document. */
function docQuery(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
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

function typeInto(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * Arm a "Save & Close" close request against this tab and swap in a spy for
 * `closeTab`, so a test can observe whether the tab is actually closed. The
 * UnsavedChangesDialog renders once `pendingCloseRequest` targets this tab.
 */
function armCloseRequest(): ReturnType<typeof vi.fn> {
  const closeTabSpy = vi.fn();
  act(() => {
    useAppStore.setState({
      closeTab: closeTabSpy,
      pendingCloseRequest: { tabId: TAB_ID, panelId: PANEL_ID },
    });
  });
  return closeTabSpy;
}

describe("FileEditor — Save & Close gates on a real save (FEC-010)", () => {
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

  it("keeps the tab open (and shows the error) when the save fails", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "local_read_file") return Promise.resolve("body\n");
      if (cmd === "local_write_file")
        return Promise.reject(new Error("write note.txt: permission denied"));
      return Promise.resolve(undefined);
    });

    render(LOCAL_META);
    await flush();
    editContent("body\nedited\n");
    await flush();

    const closeTabSpy = armCloseRequest();
    await flush();

    const saveAndClose = docQuery("unsaved-changes-save-and-close") as HTMLButtonElement;
    expect(saveAndClose).not.toBeNull();
    await act(async () => {
      saveAndClose.click();
    });
    await flush();

    // The failed save surfaces its banner, the tab is NOT closed, and the
    // buffer stays dirty so the edits are still there to retry.
    expect(query("file-editor-save-error")?.textContent ?? "").toMatch(/permission denied/i);
    expect(closeTabSpy).not.toHaveBeenCalled();
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(true);
  });

  it("keeps a scratch tab open when Save-As is cancelled", async () => {
    // The user dismisses the native Save-As dialog: nothing is written.
    vi.mocked(save).mockResolvedValueOnce(null);
    mockedInvoke.mockImplementation(() => Promise.resolve(undefined));

    render(SCRATCH_META);
    await flush();

    const closeTabSpy = armCloseRequest();
    await flush();

    await act(async () => {
      (docQuery("unsaved-changes-save-and-close") as HTMLButtonElement).click();
    });
    await flush();

    // Save-As was cancelled → the scratch content was never written, so the
    // tab must stay open rather than discard the captured buffer.
    expect(closeTabSpy).not.toHaveBeenCalled();
    // No write ever reached the backend.
    const wrote = mockedInvoke.mock.calls.some(([cmd]) => cmd === "local_write_file");
    expect(wrote).toBe(false);
  });

  it("closes the tab after a successful save", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "local_read_file") return Promise.resolve("body\n");
      if (cmd === "local_write_file") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    render(LOCAL_META);
    await flush();
    editContent("body\nedited\n");
    await flush();

    const closeTabSpy = armCloseRequest();
    await flush();

    await act(async () => {
      (docQuery("unsaved-changes-save-and-close") as HTMLButtonElement).click();
    });
    await flush();

    // The write succeeded → the tab is closed and no error banner is shown.
    expect(closeTabSpy).toHaveBeenCalledWith(TAB_ID, PANEL_ID);
    expect(query("file-editor-save-error")).toBeNull();
  });

  describe("sudo path defers the close until the elevated write resolves", () => {
    /** Mock a read-only, exec-capable remote file so Save routes through sudo. */
    function mockSudoBackend(elevatedResults: unknown[] = []): {
      elevatedCalls: Array<Record<string, unknown>>;
    } {
      const elevatedCalls: Array<Record<string, unknown>> = [];
      const queue = [...elevatedResults];
      mockedInvoke.mockImplementation((cmd, args) => {
        if (cmd === "session_read_file") return Promise.resolve(toB64("127.0.0.1 localhost\n"));
        if (cmd === "session_has_exec_capability") return Promise.resolve(true);
        if (cmd === "session_check_writable") return Promise.resolve("readOnly");
        if (cmd === "session_write_file_elevated") {
          elevatedCalls.push((args ?? {}) as Record<string, unknown>);
          return Promise.resolve(queue.shift() ?? { kind: "success" });
        }
        if (cmd === "resolve_credential") return Promise.resolve(null);
        return Promise.resolve(undefined);
      });
      return { elevatedCalls };
    }

    it("does not close while the sudo prompt is open, and cancelling keeps the tab open", async () => {
      mockSudoBackend();
      render(REMOTE_RO_META);
      await flush();
      await flush();

      editContent("127.0.0.1 localhost\nedited\n");
      await flush();

      const closeTabSpy = armCloseRequest();
      await flush();

      await act(async () => {
        (docQuery("unsaved-changes-save-and-close") as HTMLButtonElement).click();
      });
      await flush();

      // The elevated write hasn't happened — the sudo prompt is open and the
      // tab is still there.
      expect(docQuery("sudo-prompt-dialog")).not.toBeNull();
      expect(closeTabSpy).not.toHaveBeenCalled();

      // Cancelling the prompt abandons the deferred close; the tab stays open
      // with its unsaved buffer.
      await act(async () => {
        (docQuery("sudo-prompt-cancel") as HTMLButtonElement).click();
      });
      await flush();

      expect(closeTabSpy).not.toHaveBeenCalled();
      expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(true);
    });

    it("closes the tab once the elevated write is authorized", async () => {
      const { elevatedCalls } = mockSudoBackend([{ kind: "success" }]);
      render(REMOTE_RO_META);
      await flush();
      await flush();

      editContent("127.0.0.1 localhost\nedited\n");
      await flush();

      const closeTabSpy = armCloseRequest();
      await flush();

      await act(async () => {
        (docQuery("unsaved-changes-save-and-close") as HTMLButtonElement).click();
      });
      await flush();

      // Deferred: no close yet, prompt is open.
      expect(closeTabSpy).not.toHaveBeenCalled();

      // Authorize the sudo write.
      typeInto(docQuery("sudo-prompt-input") as HTMLInputElement, "sudo-pw");
      await act(async () => {
        (docQuery("sudo-prompt-submit") as HTMLButtonElement).click();
      });
      await flush();

      // The elevated write landed → only now is the tab closed.
      expect(elevatedCalls).toHaveLength(1);
      expect(closeTabSpy).toHaveBeenCalledWith(TAB_ID, PANEL_ID);
    });
  });
});
