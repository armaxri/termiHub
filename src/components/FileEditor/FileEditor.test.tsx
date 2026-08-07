import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import React from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { useAppStore, deriveEditorHostLabel } from "@/store/appStore";
import { FileEditor } from "./FileEditor";
import type { EditorTabMeta, LeafPanel, TerminalTab } from "@/types/terminal";

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

/** Encode text the way session_read_file returns it: a plain byte array. */
function toBytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

const TAB_ID = "tab-fe-1";
// A remote editor tab is backed by the session layer (#2422). An SFTP-backed
// session (SSH) reads/writes through the `session_*` commands and, once its
// exec-capability probe resolves, unlocks the SFTP-advanced affordances.
const REMOTE_META: EditorTabMeta = {
  filePath: "/etc/hosts",
  isRemote: true,
  sessionBrowser: { sessionId: "sftp-sess-1", connectionType: "ssh" },
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
      if (cmd === "session_read_file") return Promise.resolve(toBytes("127.0.0.1 localhost\n"));
      if (cmd === "session_write_file")
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
      if (cmd === "session_read_file") return Promise.resolve(toBytes("data\n"));
      if (cmd === "session_write_file") return Promise.reject(new Error("disk quota exceeded"));
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
      if (cmd === "session_read_file") return Promise.resolve(toBytes("v1\n"));
      if (cmd === "session_write_file") {
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
      if (cmd === "session_read_file") return Promise.reject(new Error("ssh session closed"));
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
      if (cmd === "session_read_file") return Promise.reject(new Error("ssh session closed"));
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

describe("FileEditor — read-only badge + banner (#1325)", () => {
  const REMOTE_RO_META: EditorTabMeta = {
    filePath: "/etc/hosts",
    isRemote: true,
    sessionBrowser: { sessionId: "sftp-sess-1", connectionType: "ssh" },
    permissions: "-rw-r--r--",
  };
  const LOCAL_META: EditorTabMeta = {
    filePath: "/tmp/local.txt",
    isRemote: false,
  };

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

  function mockWritability(result: "writable" | "readOnly" | "unknown"): void {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "session_read_file") return Promise.resolve(toBytes("127.0.0.1 localhost\n"));
      if (cmd === "local_read_file") return Promise.resolve("local body\n");
      // A resolved exec-capability probe marks the session SFTP-backed, unlocking
      // the writability probe (#2420). Detection only here — no exec channel.
      if (cmd === "session_has_exec_capability") return Promise.resolve(false);
      if (cmd === "session_check_writable") return Promise.resolve(result);
      return Promise.resolve(undefined);
    });
  }

  it("renders the badge + banner and shows the parsed permissions in the tooltip", async () => {
    mockWritability("readOnly");
    render(REMOTE_RO_META);
    await flush();

    const badge = query("file-editor-readonly-badge");
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("title") ?? "").toContain("rw-r--r--");
    expect(query("file-editor-readonly-banner")).not.toBeNull();
  });

  it("dismisses the banner while keeping the badge", async () => {
    mockWritability("readOnly");
    render(REMOTE_RO_META);
    await flush();

    expect(query("file-editor-readonly-banner")).not.toBeNull();
    await act(async () => {
      (query("file-editor-readonly-banner-dismiss") as HTMLButtonElement).click();
    });
    await flush();

    expect(query("file-editor-readonly-banner")).toBeNull();
    // The badge is a persistent state indicator and stays after dismissal.
    expect(query("file-editor-readonly-badge")).not.toBeNull();
  });

  it("shows neither badge nor banner for a writable remote file", async () => {
    mockWritability("writable");
    render(REMOTE_RO_META);
    await flush();

    expect(query("file-editor-readonly-badge")).toBeNull();
    expect(query("file-editor-readonly-banner")).toBeNull();
  });

  it("shows neither badge nor banner when writability is unknown", async () => {
    mockWritability("unknown");
    render(REMOTE_RO_META);
    await flush();

    expect(query("file-editor-readonly-badge")).toBeNull();
    expect(query("file-editor-readonly-banner")).toBeNull();
  });

  it("does not probe writability for a local file and renders no badge/banner", async () => {
    mockWritability("readOnly");
    render(LOCAL_META);
    await flush();

    const probed = mockedInvoke.mock.calls.some(([cmd]) => cmd === "session_check_writable");
    expect(probed).toBe(false);
    expect(query("file-editor-readonly-badge")).toBeNull();
    expect(query("file-editor-readonly-banner")).toBeNull();
  });
});

describe("FileEditor — elevated (sudo) edit mode (#1329)", () => {
  const REMOTE_RO_META: EditorTabMeta = {
    filePath: "/etc/hosts",
    isRemote: true,
    sessionBrowser: { sessionId: "sftp-sess-1", connectionType: "ssh" },
    permissions: "-rw-r--r--",
  };

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

  /** Query portalled (Radix) dialog content from the whole document. */
  function docQuery(testId: string): HTMLElement | null {
    return document.querySelector(`[data-testid="${testId}"]`);
  }

  function typeInto(el: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    act(() => {
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  /**
   * Mock the backend for elevated flows. `elevatedResults` is consumed one entry
   * per `session_write_file_elevated` call so a test can script
   * incorrect→incorrect→success sequences.
   */
  function mockBackend(opts: {
    readOnly?: boolean;
    execCapable?: boolean;
    elevatedResults?: unknown[];
    storeStatus?: "unlocked" | "locked" | "unavailable";
  }): { elevatedCalls: Array<Record<string, unknown>> } {
    const { readOnly = true, execCapable = true, elevatedResults = [] } = opts;
    const elevatedCalls: Array<Record<string, unknown>> = [];
    const queue = [...elevatedResults];
    mockedInvoke.mockImplementation((cmd, args) => {
      if (cmd === "session_read_file") return Promise.resolve(toBytes("127.0.0.1 localhost\n"));
      if (cmd === "session_has_exec_capability") return Promise.resolve(execCapable);
      if (cmd === "session_check_writable")
        return Promise.resolve(readOnly ? "readOnly" : "writable");
      if (cmd === "session_write_file_elevated") {
        elevatedCalls.push((args ?? {}) as Record<string, unknown>);
        return Promise.resolve(queue.shift() ?? { kind: "success" });
      }
      if (cmd === "store_credential") return Promise.resolve(undefined);
      if (cmd === "resolve_credential") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });
    return { elevatedCalls };
  }

  it("offers 'Edit with sudo' only when the file is read-only and exec-capable", async () => {
    mockBackend({ readOnly: true, execCapable: true });
    render(REMOTE_RO_META);
    await flush();

    expect(query("file-editor-edit-with-sudo")).not.toBeNull();
    // The plain Save button is replaced by the sudo entry point.
    expect(query("file-editor-save")).toBeNull();
  });

  it("does not offer 'Edit with sudo' when the connection is not exec-capable", async () => {
    mockBackend({ readOnly: true, execCapable: false });
    render(REMOTE_RO_META);
    await flush();

    expect(query("file-editor-edit-with-sudo")).toBeNull();
    expect(query("file-editor-save")).not.toBeNull();
  });

  it("routes an authorized save through the elevated command and shows the sudo marker", async () => {
    const { elevatedCalls } = mockBackend({
      readOnly: true,
      execCapable: true,
      elevatedResults: [{ kind: "success" }],
    });
    render(REMOTE_RO_META);
    await flush();

    editContent("127.0.0.1 localhost\nedited\n");
    await flush();

    await act(async () => {
      (query("file-editor-edit-with-sudo") as HTMLButtonElement).click();
    });
    await flush();

    // The sudo prompt appears; authorize it.
    typeInto(docQuery("sudo-prompt-input") as HTMLInputElement, "sudo-pw");
    await act(async () => {
      (docQuery("sudo-prompt-submit") as HTMLButtonElement).click();
    });
    await flush();

    expect(elevatedCalls).toHaveLength(1);
    expect(elevatedCalls[0].sudoPassword).toBe("sudo-pw");
    // Success: buffer is clean and the persistent sudo marker is shown.
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(false);
    expect(query("file-editor-sudo-badge")).not.toBeNull();
  });

  it("re-prompts on an incorrect password up to 3 times, then falls to the #969 banner", async () => {
    const { elevatedCalls } = mockBackend({
      readOnly: true,
      execCapable: true,
      elevatedResults: [
        { kind: "incorrectPassword" },
        { kind: "incorrectPassword" },
        { kind: "incorrectPassword" },
      ],
    });
    render(REMOTE_RO_META);
    await flush();
    editContent("127.0.0.1 localhost\nedited\n");
    await flush();

    await act(async () => {
      (query("file-editor-edit-with-sudo") as HTMLButtonElement).click();
    });
    await flush();

    // Three wrong attempts.
    for (let i = 0; i < 3; i++) {
      typeInto(docQuery("sudo-prompt-input") as HTMLInputElement, `wrong-${i}`);
      await act(async () => {
        (docQuery("sudo-prompt-submit") as HTMLButtonElement).click();
      });
      await flush();
    }

    expect(elevatedCalls).toHaveLength(3);
    // Dialog is dismissed and the #969 save-error banner is shown with the buffer intact.
    expect(docQuery("sudo-prompt-dialog")).toBeNull();
    expect(query("file-editor-save-error")).not.toBeNull();
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(true);
  });

  it("surfaces a non-password failure ('other') in the #969 banner with the buffer intact", async () => {
    mockBackend({
      readOnly: true,
      execCapable: true,
      elevatedResults: [{ kind: "other", message: "sudo: command not found" }],
    });
    render(REMOTE_RO_META);
    await flush();
    editContent("127.0.0.1 localhost\nedited\n");
    await flush();

    await act(async () => {
      (query("file-editor-edit-with-sudo") as HTMLButtonElement).click();
    });
    await flush();
    typeInto(docQuery("sudo-prompt-input") as HTMLInputElement, "pw");
    await act(async () => {
      (docQuery("sudo-prompt-submit") as HTMLButtonElement).click();
    });
    await flush();

    const banner = query("file-editor-save-error");
    expect(banner?.textContent ?? "").toMatch(/command not found/i);
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(true);
  });

  it("caches the session password so a second elevated save does not re-prompt", async () => {
    const { elevatedCalls } = mockBackend({
      readOnly: true,
      execCapable: true,
      elevatedResults: [{ kind: "success" }, { kind: "success" }],
    });
    render(REMOTE_RO_META);
    await flush();
    editContent("127.0.0.1 localhost\nedit1\n");
    await flush();

    await act(async () => {
      (query("file-editor-edit-with-sudo") as HTMLButtonElement).click();
    });
    await flush();
    typeInto(docQuery("sudo-prompt-input") as HTMLInputElement, "cached-pw");
    await act(async () => {
      (docQuery("sudo-prompt-submit") as HTMLButtonElement).click();
    });
    await flush();
    expect(elevatedCalls).toHaveLength(1);

    // Edit again and save via the (now elevated) Save button — no dialog.
    editContent("127.0.0.1 localhost\nedit2\n");
    await flush();
    await act(async () => {
      (query("file-editor-save") as HTMLButtonElement).click();
    });
    await flush();

    expect(docQuery("sudo-prompt-dialog")).toBeNull();
    expect(elevatedCalls).toHaveLength(2);
    expect(elevatedCalls[1].sudoPassword).toBe("cached-pw");
  });

  it("adds a 'Retry with sudo' action to the #969 banner after a failed direct save", async () => {
    // Writability unknown → direct save attempted → permission denied → banner.
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "session_read_file") return Promise.resolve(toBytes("body\n"));
      if (cmd === "session_has_exec_capability") return Promise.resolve(true);
      if (cmd === "session_check_writable") return Promise.resolve("unknown");
      if (cmd === "session_write_file") return Promise.reject(new Error("permission denied"));
      return Promise.resolve(undefined);
    });
    render(REMOTE_RO_META);
    await flush();
    editContent("body\nmore\n");
    await flush();

    await act(async () => {
      (query("file-editor-save") as HTMLButtonElement).click();
    });
    await flush();

    expect(query("file-editor-save-error")).not.toBeNull();
    expect(query("file-editor-save-error-retry-sudo")).not.toBeNull();
  });
});

describe("FileEditor — sudo host label from the session (#2424 / #2426)", () => {
  // A session-backed SSH editor tab (no legacy `sftpSessionId`). Read-only +
  // exec-capable so it reaches the sudo path.
  const SSH_META: EditorTabMeta = {
    filePath: "/etc/hosts",
    isRemote: true,
    sessionBrowser: { sessionId: "sftp-sess-1", connectionType: "ssh" },
    sessionKey: "session:term-owner",
    permissions: "-rw-r--r--",
  };

  /**
   * Seed the owning terminal tab whose connection config supplies the host
   * label. `sessionId` defaults to the editor tab's live session id; pass a
   * different one to simulate a reconnect (the tab id / `sessionKey` stays put).
   */
  function seedOwningTab(
    opts: {
      tabId?: string;
      sessionId?: string;
      config?: Record<string, unknown>;
      type?: string;
    } = {}
  ): void {
    const {
      tabId = "term-owner",
      sessionId = "sftp-sess-1",
      config = { username: "pi", host: "raspberrypi", port: 22 },
      type = "ssh",
    } = opts;
    const tab = {
      id: tabId,
      sessionId,
      title: "owner",
      connectionType: type,
      contentType: "terminal",
      config: { type, config },
      panelId: "leaf-1",
      isActive: true,
    } as unknown as TerminalTab;
    const leaf: LeafPanel = { type: "leaf", id: "leaf-1", tabs: [tab], activeTabId: tabId };
    useAppStore.setState({ rootPanel: leaf, activePanelId: "leaf-1" });
  }

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

  function docQuery(testId: string): HTMLElement | null {
    return document.querySelector(`[data-testid="${testId}"]`);
  }

  function typeInto(el: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    act(() => {
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  /**
   * Mock the elevated backend and capture credential-store calls. `resolvePw`
   * seeds a stored sudo password returned by `resolve_credential`.
   */
  function mockBackend(opts: { resolvePw?: string | null; unlocked?: boolean } = {}): {
    elevatedCalls: Array<Record<string, unknown>>;
    credentialCalls: Array<{ cmd: string; args: Record<string, unknown> }>;
  } {
    const { resolvePw = null } = opts;
    const elevatedCalls: Array<Record<string, unknown>> = [];
    const credentialCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    mockedInvoke.mockImplementation((cmd, args) => {
      if (cmd === "session_read_file") return Promise.resolve(toBytes("127.0.0.1 localhost\n"));
      if (cmd === "session_has_exec_capability") return Promise.resolve(true);
      if (cmd === "session_check_writable") return Promise.resolve("readOnly");
      if (cmd === "session_write_file_elevated") {
        elevatedCalls.push((args ?? {}) as Record<string, unknown>);
        return Promise.resolve({ kind: "success" });
      }
      if (cmd === "store_credential") {
        credentialCalls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
        return Promise.resolve(undefined);
      }
      if (cmd === "resolve_credential") {
        credentialCalls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
        return Promise.resolve(resolvePw);
      }
      if (cmd === "remove_credential") {
        credentialCalls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });
    return { elevatedCalls, credentialCalls };
  }

  function unlockCredentialStore(): void {
    act(() => {
      useAppStore.setState({
        credentialStoreStatus: { status: "unlocked", mode: "master_password" },
      });
    });
  }

  it("derives the legacy `user@host:port` label from the owning tab config", () => {
    seedOwningTab();
    const label = deriveEditorHostLabel(useAppStore.getState(), SSH_META);
    expect(label).toBe("pi@raspberrypi:22");
  });

  it("stays reconnect-stable: resolves via the owning tab id after the session id changes", () => {
    // A reconnect swapped the live session id, but the owning tab id (and its
    // config) is unchanged — the stale `sessionBrowser.sessionId` no longer
    // matches any tab, yet the label must still resolve via `sessionKey`.
    seedOwningTab({ sessionId: "sftp-sess-RECONNECTED" });
    const label = deriveEditorHostLabel(useAppStore.getState(), SSH_META);
    expect(label).toBe("pi@raspberrypi:22");
  });

  it("returns null for a byte-based backend (no host) → path fallback", () => {
    // A Docker/agent-style session has no user@host:port in its config.
    seedOwningTab({ type: "docker", config: { image: "alpine" } });
    const label = deriveEditorHostLabel(useAppStore.getState(), {
      ...SSH_META,
      sessionBrowser: { sessionId: "sftp-sess-1", connectionType: "docker" },
    });
    expect(label).toBeNull();
  });

  it("returns null when the owning terminal tab is gone", () => {
    // No tab seeded → nothing to source the label from.
    expect(deriveEditorHostLabel(useAppStore.getState(), SSH_META)).toBeNull();
  });

  it("names the host in the sudo prompt for a session-backed SSH tab", async () => {
    mockBackend();
    seedOwningTab();
    render(SSH_META);
    await flush();

    editContent("127.0.0.1 localhost\nedited\n");
    await flush();
    await act(async () => {
      (query("file-editor-edit-with-sudo") as HTMLButtonElement).click();
    });
    await flush();

    // Prompt shows the host, not the file path.
    expect(docQuery("sudo-prompt-host")?.textContent).toBe("raspberrypi:22");
    expect(docQuery("sudo-prompt-user")?.textContent).toBe("pi");
  });

  it("falls back to the file path in the sudo prompt when no host label resolves", async () => {
    mockBackend();
    // No owning tab seeded → hostLabel null → file-path fallback.
    render(SSH_META);
    await flush();

    editContent("127.0.0.1 localhost\nedited\n");
    await flush();
    await act(async () => {
      (query("file-editor-edit-with-sudo") as HTMLButtonElement).click();
    });
    await flush();

    expect(docQuery("sudo-prompt-host")?.textContent).toBe("/etc/hosts");
  });

  it("namespaces the persisted sudo password under the host label", async () => {
    const { credentialCalls } = mockBackend();
    seedOwningTab();
    render(SSH_META);
    await flush();
    unlockCredentialStore();
    await flush();

    editContent("127.0.0.1 localhost\nedited\n");
    await flush();
    await act(async () => {
      (query("file-editor-edit-with-sudo") as HTMLButtonElement).click();
    });
    await flush();

    typeInto(docQuery("sudo-prompt-input") as HTMLInputElement, "sudo-pw");
    // Opt into persisting to the credential store.
    await act(async () => {
      (docQuery("sudo-prompt-persist") as HTMLElement).click();
    });
    await act(async () => {
      (docQuery("sudo-prompt-submit") as HTMLButtonElement).click();
    });
    await flush();

    const store = credentialCalls.find((c) => c.cmd === "store_credential");
    expect(store).toBeDefined();
    // The credential is keyed by the host label, not the file path.
    expect(store?.args.connectionId).toBe("pi@raspberrypi:22");
    expect(store?.args.credentialType).toBe("sudo_password");
  });

  it("resolves a saved sudo password under the host label without prompting", async () => {
    const { elevatedCalls, credentialCalls } = mockBackend({ resolvePw: "stored-pw" });
    seedOwningTab();
    render(SSH_META);
    await flush();
    unlockCredentialStore();
    await flush();

    editContent("127.0.0.1 localhost\nedited\n");
    await flush();
    await act(async () => {
      (query("file-editor-edit-with-sudo") as HTMLButtonElement).click();
    });
    await flush();

    // The stored password satisfied the save; no prompt was shown.
    expect(docQuery("sudo-prompt-dialog")).toBeNull();
    expect(elevatedCalls).toHaveLength(1);
    expect(elevatedCalls[0].sudoPassword).toBe("stored-pw");
    const resolve = credentialCalls.find((c) => c.cmd === "resolve_credential");
    expect(resolve?.args.connectionId).toBe("pi@raspberrypi:22");
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
      if (cmd === "session_read_file") return Promise.resolve(toBytes("data\n"));
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
      if (cmd === "session_read_file") return Promise.resolve(toBytes("data\n"));
      if (cmd === "session_write_file") return Promise.reject(new Error("permission denied"));
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

describe("FileEditor — SFTP-only read-only fallback (#1330)", () => {
  const REMOTE_RO_META: EditorTabMeta = {
    filePath: "/etc/hosts",
    isRemote: true,
    sessionBrowser: { sessionId: "sftp-sess-1", connectionType: "ssh" },
    permissions: "-rw-r--r--",
  };

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

  /** Query portalled (Radix) dialog content from the whole document. */
  function docQuery(testId: string): HTMLElement | null {
    return document.querySelector(`[data-testid="${testId}"]`);
  }

  function typeInto(el: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    act(() => {
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  /**
   * Mock a read-only remote file on a connection with **no** exec channel
   * (SFTP-only / relayed), recording any Save-a-copy / Download backend calls.
   */
  function mockSftpOnlyReadonly(home?: string): {
    writeCalls: Array<Record<string, unknown>>;
    downloadCalls: Array<Record<string, unknown>>;
  } {
    const writeCalls: Array<Record<string, unknown>> = [];
    const downloadCalls: Array<Record<string, unknown>> = [];
    mockedInvoke.mockImplementation((cmd, args) => {
      if (cmd === "session_read_file") return Promise.resolve(toBytes("127.0.0.1 localhost\n"));
      if (cmd === "session_has_exec_capability") return Promise.resolve(false);
      if (cmd === "session_check_writable") return Promise.resolve("readOnly");
      if (cmd === "session_realpath") {
        return home !== undefined
          ? Promise.resolve(home)
          : Promise.reject(new Error("no realpath"));
      }
      if (cmd === "session_write_file") {
        writeCalls.push((args ?? {}) as Record<string, unknown>);
        return Promise.resolve(undefined);
      }
      if (cmd === "session_download") {
        downloadCalls.push((args ?? {}) as Record<string, unknown>);
        return Promise.resolve("transfer-1");
      }
      return Promise.resolve(undefined);
    });
    return { writeCalls, downloadCalls };
  }

  it("shows the fallback banner, disables Save, and offers copy/download without Edit-with-sudo", async () => {
    mockSftpOnlyReadonly();
    render(REMOTE_RO_META);
    await flush();

    // The fallback banner explains that sudo elevation is unavailable.
    const banner = query("file-editor-readonly-banner");
    expect(banner).not.toBeNull();
    expect(banner?.textContent ?? "").toMatch(/sudo elevation isn't available/i);

    // No sudo entry point on an SFTP-only connection.
    expect(query("file-editor-edit-with-sudo")).toBeNull();

    // Save is present but disabled — even after an edit (a direct save can't succeed).
    const saveBtn = query("file-editor-save") as HTMLButtonElement;
    expect(saveBtn).not.toBeNull();
    expect(saveBtn.disabled).toBe(true);
    editContent("127.0.0.1 localhost\nedited\n");
    await flush();
    expect((query("file-editor-save") as HTMLButtonElement).disabled).toBe(true);

    // The fallback actions are offered instead.
    expect(query("file-editor-save-copy")).not.toBeNull();
    expect(query("file-editor-download")).not.toBeNull();
  });

  it("pre-fills Save a copy with the file's basename under the remote home (#1535)", async () => {
    mockSftpOnlyReadonly("/home/user");
    render(REMOTE_RO_META);
    await flush();

    await act(async () => {
      (query("file-editor-save-copy") as HTMLButtonElement).click();
    });
    await flush();

    // The read-only original is /etc/hosts; the default should point at the
    // writable home, not the original path the save would fail on.
    const input = docQuery("save-copy-input") as HTMLInputElement;
    expect(input.value).toBe("/home/user/hosts");
  });

  it("falls back to a .copy sibling when the remote home can't be resolved (#1535)", async () => {
    mockSftpOnlyReadonly(); // realpath rejects
    render(REMOTE_RO_META);
    await flush();

    await act(async () => {
      (query("file-editor-save-copy") as HTMLButtonElement).click();
    });
    await flush();

    const input = docQuery("save-copy-input") as HTMLInputElement;
    expect(input.value).toBe("/etc/hosts.copy");
  });

  it("writes the buffer to the chosen writable remote path via Save a copy", async () => {
    const { writeCalls } = mockSftpOnlyReadonly();
    render(REMOTE_RO_META);
    await flush();
    editContent("127.0.0.1 localhost\nmy edit\n");
    await flush();

    await act(async () => {
      (query("file-editor-save-copy") as HTMLButtonElement).click();
    });
    await flush();

    // Choose a writable destination and confirm.
    typeInto(docQuery("save-copy-input") as HTMLInputElement, "/home/user/hosts.copy");
    await act(async () => {
      (docQuery("save-copy-submit") as HTMLButtonElement).click();
    });
    await flush();

    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].path).toBe("/home/user/hosts.copy");
    expect(new TextDecoder().decode(new Uint8Array(writeCalls[0].data as number[]))).toBe(
      "127.0.0.1 localhost\nmy edit\n"
    );
  });

  it("downloads the file to a chosen local path via Download", async () => {
    const { downloadCalls } = mockSftpOnlyReadonly();
    vi.mocked(save).mockResolvedValueOnce("/local/hosts.txt");
    render(REMOTE_RO_META);
    await flush();

    await act(async () => {
      (query("file-editor-download") as HTMLButtonElement).click();
    });
    await flush();
    await flush();

    expect(downloadCalls).toHaveLength(1);
    expect(downloadCalls[0].remotePath).toBe("/etc/hosts");
    expect(downloadCalls[0].localPath).toBe("/local/hosts.txt");
  });

  it("keeps the exec-capable Edit-with-sudo path (no fallback) when a shell exists", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "session_read_file") return Promise.resolve(toBytes("body\n"));
      if (cmd === "session_has_exec_capability") return Promise.resolve(true);
      if (cmd === "session_check_writable") return Promise.resolve("readOnly");
      return Promise.resolve(undefined);
    });
    render(REMOTE_RO_META);
    await flush();

    // The #1329 path is intact: the sudo entry point shows, fallback actions do not.
    expect(query("file-editor-edit-with-sudo")).not.toBeNull();
    expect(query("file-editor-save-copy")).toBeNull();
    expect(query("file-editor-download")).toBeNull();
  });
});

describe("FileEditor — session-layer backed tabs (#1557)", () => {
  const SESSION_META: EditorTabMeta = {
    filePath: "/srv/app/config.yml",
    isRemote: true,
    sessionBrowser: { sessionId: "sess-ftp-1", connectionType: "ftp" },
  };

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

  /** Encode text the way session_read_file returns it: a plain byte array. */
  function bytes(text: string): number[] {
    return Array.from(new TextEncoder().encode(text));
  }

  it("reads the file through session_read_file and never touches the SFTP path", async () => {
    mockedInvoke.mockImplementation((cmd, args) => {
      if (cmd === "session_read_file") {
        expect(args).toMatchObject({ sessionId: "sess-ftp-1", path: "/srv/app/config.yml" });
        return Promise.resolve(bytes("port: 8080\n"));
      }
      return Promise.resolve(undefined);
    });

    render(SESSION_META);
    await flush();

    expect((query("mock-monaco") as HTMLTextAreaElement).value).toBe("port: 8080\n");
    const commands = mockedInvoke.mock.calls.map((c) => c[0]);
    expect(commands).toContain("session_read_file");
    expect(commands.filter((c) => String(c).startsWith("sftp_"))).toEqual([]);
  });

  it("decodes non-ASCII content returned as bytes", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "session_read_file") return Promise.resolve(bytes("gruß: 🌍\n"));
      return Promise.resolve(undefined);
    });

    render(SESSION_META);
    await flush();

    expect((query("mock-monaco") as HTMLTextAreaElement).value).toBe("gruß: 🌍\n");
  });

  it("saves the buffer back through session_write_file", async () => {
    const writes: { sessionId: string; path: string; data: number[] }[] = [];
    mockedInvoke.mockImplementation((cmd, args) => {
      if (cmd === "session_read_file") return Promise.resolve(bytes("port: 8080\n"));
      if (cmd === "session_write_file") {
        writes.push(args as unknown as { sessionId: string; path: string; data: number[] });
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    render(SESSION_META);
    await flush();

    editContent("port: 9090\n");
    await flush();

    const saveBtn = query("file-editor-save") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    await act(async () => {
      saveBtn.click();
    });
    await flush();

    expect(writes).toHaveLength(1);
    expect(writes[0].sessionId).toBe("sess-ftp-1");
    expect(writes[0].path).toBe("/srv/app/config.yml");
    expect(new TextDecoder().decode(new Uint8Array(writes[0].data))).toBe("port: 9090\n");
    // A successful save clears the dirty flag and raises no error banner.
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(false);
    expect(query("file-editor-save-error")).toBeNull();
  });

  it("surfaces a failed session save and keeps the buffer dirty", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "session_read_file") return Promise.resolve(bytes("port: 8080\n"));
      if (cmd === "session_write_file")
        return Promise.reject(new Error("write config.yml: permission denied"));
      return Promise.resolve(undefined);
    });

    render(SESSION_META);
    await flush();

    editContent("port: 9090\n");
    await flush();

    await act(async () => {
      (query("file-editor-save") as HTMLButtonElement).click();
    });
    await flush();

    expect(query("file-editor-save-error")?.textContent ?? "").toMatch(/permission denied/i);
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(true);
  });

  it("offers no SFTP-advanced affordances for a byte-based (non-SFTP) backend", async () => {
    // A byte-based session backend (FTP here) rejects the SFTP-advanced probe —
    // exactly how the backend's SessionManager::sftp_transfer_browser behaves for
    // a non-SFTP browser. That reject is the capability signal (#2420): the tab
    // stays on the plain read/write path with none of the advanced affordances,
    // and even a read-only verdict would never be probed for.
    const calls: string[] = [];
    mockedInvoke.mockImplementation((cmd) => {
      calls.push(String(cmd));
      if (cmd === "session_read_file") return Promise.resolve(bytes("body\n"));
      if (cmd === "session_has_exec_capability")
        return Promise.reject(
          new Error("Session file browser does not support SFTP advanced operations")
        );
      // Were these ever reached, they would light up the sudo / fallback UI.
      if (cmd === "session_check_writable") return Promise.resolve("readOnly");
      return Promise.resolve(undefined);
    });

    render(SESSION_META);
    await flush();
    await flush();

    // The session layer exposes read/write only: no writability probe, no sudo,
    // no realpath-backed "save a copy", no SFTP download.
    expect(query("file-editor-remote-badge")).not.toBeNull();
    expect(query("file-editor-readonly-badge")).toBeNull();
    expect(query("file-editor-edit-with-sudo")).toBeNull();
    expect(query("file-editor-save-copy")).toBeNull();
    expect(query("file-editor-download")).toBeNull();
    // The advanced ops are gated off the failed probe: no writability / realpath
    // round-trip is made once the backend reports it is not SFTP-backed.
    expect(calls).not.toContain("session_check_writable");
    expect(calls).not.toContain("session_realpath");
    // The SFTP-family commands are never used on the session path either.
    expect(calls.filter((c) => c.startsWith("sftp_"))).toEqual([]);
  });

  it("surfaces a session read failure as a load error", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "session_read_file") return Promise.reject(new Error("no such file"));
      return Promise.resolve(undefined);
    });

    render(SESSION_META);
    await flush();

    expect(container.textContent ?? "").toMatch(/no such file/i);
  });
});

describe("FileEditor — SFTP-backed session tab reaches SFTP parity (#2420)", () => {
  // A session-layer tab whose backend IS SFTP-backed (SSH). The
  // `session_has_exec_capability` probe resolves for it (rather than rejecting as
  // a byte-based backend would), which is the capability signal that unlocks the
  // SFTP-advanced affordances on the session path.
  const SESSION_SSH_META: EditorTabMeta = {
    filePath: "/etc/hosts",
    isRemote: true,
    sessionBrowser: { sessionId: "sess-ssh-1", connectionType: "ssh" },
    permissions: "-rw-r--r--",
  };

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

  function docQuery(testId: string): HTMLElement | null {
    return document.querySelector(`[data-testid="${testId}"]`);
  }

  function typeInto(el: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    act(() => {
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  /** Encode text the way session_read_file returns it: a plain byte array. */
  function bytes(text: string): number[] {
    return Array.from(new TextEncoder().encode(text));
  }

  /**
   * Mock a session-backed SFTP connection through the `session_*` twins, so the
   * advanced ops resolve exactly as they would for an SSH-backed session.
   */
  function mockSessionSftp(opts: {
    execCapable?: boolean;
    writable?: "writable" | "readOnly" | "unknown";
    home?: string;
    elevatedResults?: unknown[];
  }): {
    calls: string[];
    elevatedCalls: Array<Record<string, unknown>>;
    writeCalls: Array<Record<string, unknown>>;
    downloadCalls: Array<Record<string, unknown>>;
  } {
    const { execCapable = true, writable = "readOnly", home, elevatedResults = [] } = opts;
    const calls: string[] = [];
    const elevatedCalls: Array<Record<string, unknown>> = [];
    const writeCalls: Array<Record<string, unknown>> = [];
    const downloadCalls: Array<Record<string, unknown>> = [];
    const queue = [...elevatedResults];
    mockedInvoke.mockImplementation((cmd, args) => {
      calls.push(String(cmd));
      if (cmd === "session_read_file") return Promise.resolve(bytes("127.0.0.1 localhost\n"));
      // The probe resolves (does not reject) → the session is SFTP-backed.
      if (cmd === "session_has_exec_capability") return Promise.resolve(execCapable);
      if (cmd === "session_check_writable") return Promise.resolve(writable);
      if (cmd === "session_realpath") {
        return home !== undefined
          ? Promise.resolve(home)
          : Promise.reject(new Error("no realpath"));
      }
      if (cmd === "session_write_file_elevated") {
        elevatedCalls.push((args ?? {}) as Record<string, unknown>);
        return Promise.resolve(queue.shift() ?? { kind: "success" });
      }
      if (cmd === "session_write_file") {
        writeCalls.push((args ?? {}) as Record<string, unknown>);
        return Promise.resolve(undefined);
      }
      if (cmd === "session_download") {
        downloadCalls.push((args ?? {}) as Record<string, unknown>);
        return Promise.resolve("transfer-1");
      }
      return Promise.resolve(undefined);
    });
    return { calls, elevatedCalls, writeCalls, downloadCalls };
  }

  it("probes writability over the session path and shows the read-only badge", async () => {
    const { calls } = mockSessionSftp({ execCapable: false, writable: "readOnly" });
    render(SESSION_SSH_META);
    await flush();
    await flush();

    // Writability was probed via the session twin, never the SftpManager path.
    expect(calls).toContain("session_check_writable");
    expect(calls.filter((c) => c.startsWith("sftp_"))).toEqual([]);
    const badge = query("file-editor-readonly-badge");
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("title") ?? "").toContain("rw-r--r--");
  });

  it("offers 'Edit with sudo' for a read-only file on an exec-capable session", async () => {
    mockSessionSftp({ execCapable: true, writable: "readOnly" });
    render(SESSION_SSH_META);
    await flush();
    await flush();

    expect(query("file-editor-edit-with-sudo")).not.toBeNull();
    expect(query("file-editor-save")).toBeNull();
  });

  it("routes an authorized elevated save through session_write_file_elevated", async () => {
    const { elevatedCalls } = mockSessionSftp({
      execCapable: true,
      writable: "readOnly",
      elevatedResults: [{ kind: "success" }],
    });
    render(SESSION_SSH_META);
    await flush();
    await flush();

    editContent("127.0.0.1 localhost\nedited\n");
    await flush();

    await act(async () => {
      (query("file-editor-edit-with-sudo") as HTMLButtonElement).click();
    });
    await flush();

    typeInto(docQuery("sudo-prompt-input") as HTMLInputElement, "sudo-pw");
    await act(async () => {
      (docQuery("sudo-prompt-submit") as HTMLButtonElement).click();
    });
    await flush();

    expect(elevatedCalls).toHaveLength(1);
    expect(elevatedCalls[0].sessionId).toBe("sess-ssh-1");
    expect(elevatedCalls[0].remotePath).toBe("/etc/hosts");
    expect(elevatedCalls[0].sudoPassword).toBe("sudo-pw");
    expect(useAppStore.getState().editorDirtyTabs[TAB_ID]).toBe(false);
    expect(query("file-editor-sudo-badge")).not.toBeNull();
  });

  it("offers the SFTP-only copy/download fallback when the session has no shell", async () => {
    mockSessionSftp({ execCapable: false, writable: "readOnly" });
    render(SESSION_SSH_META);
    await flush();
    await flush();

    const banner = query("file-editor-readonly-banner");
    expect(banner?.textContent ?? "").toMatch(/sudo elevation isn't available/i);
    expect(query("file-editor-edit-with-sudo")).toBeNull();
    expect((query("file-editor-save") as HTMLButtonElement).disabled).toBe(true);
    expect(query("file-editor-save-copy")).not.toBeNull();
    expect(query("file-editor-download")).not.toBeNull();
  });

  it("writes a copy to a writable path via the session layer", async () => {
    const { writeCalls } = mockSessionSftp({ execCapable: false, writable: "readOnly" });
    render(SESSION_SSH_META);
    await flush();
    await flush();
    editContent("127.0.0.1 localhost\nmy edit\n");
    await flush();

    await act(async () => {
      (query("file-editor-save-copy") as HTMLButtonElement).click();
    });
    await flush();

    typeInto(docQuery("save-copy-input") as HTMLInputElement, "/home/user/hosts.copy");
    await act(async () => {
      (docQuery("save-copy-submit") as HTMLButtonElement).click();
    });
    await flush();

    // Save-a-copy on the session path writes bytes through session_write_file.
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].sessionId).toBe("sess-ssh-1");
    expect(writeCalls[0].path).toBe("/home/user/hosts.copy");
    expect(new TextDecoder().decode(new Uint8Array(writeCalls[0].data as number[]))).toBe(
      "127.0.0.1 localhost\nmy edit\n"
    );
  });

  it("pre-fills Save a copy under the session realpath home", async () => {
    mockSessionSftp({ execCapable: false, writable: "readOnly", home: "/home/user" });
    render(SESSION_SSH_META);
    await flush();
    await flush();

    await act(async () => {
      (query("file-editor-save-copy") as HTMLButtonElement).click();
    });
    await flush();

    expect((docQuery("save-copy-input") as HTMLInputElement).value).toBe("/home/user/hosts");
  });

  it("downloads the file via session_download", async () => {
    const { downloadCalls } = mockSessionSftp({ execCapable: false, writable: "readOnly" });
    vi.mocked(save).mockResolvedValueOnce("/local/hosts.txt");
    render(SESSION_SSH_META);
    await flush();
    await flush();

    await act(async () => {
      (query("file-editor-download") as HTMLButtonElement).click();
    });
    await flush();
    await flush();

    expect(downloadCalls).toHaveLength(1);
    expect(downloadCalls[0].sessionId).toBe("sess-ssh-1");
    expect(downloadCalls[0].remotePath).toBe("/etc/hosts");
    expect(downloadCalls[0].localPath).toBe("/local/hosts.txt");
  });
});
