/**
 * A refused chmod / chown / symlink on an SSH session's file browser (#5320).
 *
 * The backend maps an SFTP refusal to a specific `SFTP error: …` message
 * (`src-tauri/src/files/sftp.rs::sftp_op_error`). The file browser must show
 * that message to the user, and a failed operation must never look like a
 * success: no success toast, the dialog stays open, and the listing is not
 * reloaded as if something had changed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { setupFileBrowsersRegion } from "@/test/fileBrowsersRegionTestHarness";
import { setupVirtualListSizing } from "@/test/virtualListSize";
import { flushAsync } from "@/test/flushAsync";
import { seedLayoutState } from "@/test/layoutState";
import { FileBrowser } from "./FileBrowser";
import { TooltipProvider } from "@/components/ui";
import type { TerminalTab, LeafPanel } from "@/types/terminal";
import type { FileEntry } from "@/types/connection";

const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@/components/ui/Toast", async () => {
  const actual =
    await vi.importActual<typeof import("@/components/ui/Toast")>("@/components/ui/Toast");
  return {
    ...actual,
    toast: {
      success: (...args: unknown[]) => toastSuccess(...args),
      error: (...args: unknown[]) => toastError(...args),
      info: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
    },
  };
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: vi.fn(() => Promise.resolve(vi.fn())),
  }),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/events", () => ({
  onVscodeEditComplete: vi.fn(() => Promise.resolve(vi.fn())),
  onLocalDirChanged: vi.fn(() => Promise.resolve(vi.fn())),
  base64ToBytes: vi.fn(() => new Uint8Array()),
}));

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return { ...actual, getHomeDir: vi.fn(() => Promise.resolve("/home/test")) };
});

const mockedInvoke = vi.mocked(invoke);

const SESSION_ID = "ssh-sess-1";

/** The IPC envelope a refused SFTP operation rejects with. */
function sftpRefusal(message: string) {
  return { code: "sftp_error", message, details: null };
}

const passwd: FileEntry = {
  name: "passwd",
  path: "/etc/passwd",
  isDirectory: false,
  size: 1800,
  modified: "2026-09-01T00:00:00Z",
  permissions: "rw-r--r--",
  writable: false,
};

let container: HTMLDivElement;
let root: Root;
/** Backend command → its rejection, for the operation under test. */
let refusals: Record<string, unknown>;

setupFileBrowsersRegion();
setupVirtualListSizing();

function seedSshSession() {
  const tab: TerminalTab = {
    id: "tab-1",
    sessionId: SESSION_ID,
    title: "ssh",
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: { host: "example.com", port: 22, username: "testuser" } },
    panelId: "panel-1",
    isActive: true,
  };
  const panel: LeafPanel = { type: "leaf", id: tab.panelId, tabs: [tab], activeTabId: tab.id };
  seedLayoutState({ activePanelId: tab.panelId, rootPanel: panel });
  useAppStore.setState({
    sidebarView: "files",
    connectionTypes: [
      {
        typeId: "ssh",
        displayName: "SSH",
        icon: "terminal",
        schema: { groups: [] },
        capabilities: { monitoring: false, fileBrowser: true, resize: true, persistent: false },
      },
    ],
  });
}

async function renderBrowser() {
  seedSshSession();
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <FileBrowser />
      </TooltipProvider>
    );
  });
  await flushAsync();
  await flushAsync();
}

const inBody = (testId: string) =>
  document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

/** Open the row's context menu and pick an action. */
async function contextAction(actionTestId: string) {
  const row = container.querySelector('[data-testid="file-row-passwd"]') as HTMLElement;
  expect(row).not.toBeNull();
  await act(async () => {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  });
  const item = inBody(actionTestId);
  expect(item, `${actionTestId} must be offered on an SSH session`).not.toBeNull();
  await act(async () => {
    item!.click();
  });
  await flushAsync();
}

/** Click a dialog button and let the rejected operation settle. */
async function clickAndSettle(testId: string) {
  await act(async () => {
    inBody(testId)!.click();
  });
  await flushAsync();
  await flushAsync();
}

async function setInputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const listCalls = () => mockedInvoke.mock.calls.filter(([cmd]) => cmd === "session_list_files");

/** The failure is shown with the backend's message and nothing reads as success. */
function expectShownFailure(command: string, message: string, dialogTestId: string) {
  expect(mockedInvoke.mock.calls.some(([cmd]) => cmd === command)).toBe(true);
  expect(toastSuccess).not.toHaveBeenCalled();
  expect(toastError).toHaveBeenCalledTimes(1);
  expect(String(toastError.mock.calls[0][0])).toContain(message);
  expect(String(toastError.mock.calls[0][0])).not.toContain("[object Object]");
  expect(inBody(dialogTestId), "the dialog stays open after a failure").not.toBeNull();
}

describe("FileBrowser — refused attribute operations on an SSH session (#5320)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    toastSuccess.mockClear();
    toastError.mockClear();
    refusals = {};
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd in refusals) return Promise.reject(refusals[cmd]);
      if (cmd === "session_list_files") return Promise.resolve([passwd]);
      if (cmd === "session_has_exec_capability") return Promise.resolve(true);
      if (cmd === "session_file_capabilities") {
        return Promise.resolve({ permissions: true, owner: true, symlink: true });
      }
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows a refused chmod's message and never reports success", async () => {
    const message = "SFTP error: Permission denied: cannot change the permissions of /etc/passwd";
    refusals.session_set_permissions = sftpRefusal(message);
    await renderBrowser();
    await contextAction("context-file-permissions");
    const listsBefore = listCalls().length;

    await clickAndSettle("permissions-apply");

    expectShownFailure("session_set_permissions", message, "permissions-dialog");
    expect(String(toastError.mock.calls[0][0])).toContain('"passwd"');
    expect(listCalls().length, "a failed chmod does not reload the listing").toBe(listsBefore);
  });

  it("shows a refused chown's message and never reports success", async () => {
    const message = "SFTP error: Permission denied: cannot change the owner of /etc/passwd";
    refusals.session_set_owner = sftpRefusal(message);
    await renderBrowser();
    await contextAction("context-file-owner");
    await setInputValue(inBody("owner-uid") as HTMLInputElement, "0");
    const listsBefore = listCalls().length;

    await clickAndSettle("owner-apply");

    expectShownFailure("session_set_owner", message, "owner-dialog");
    expect(listCalls().length, "a failed chown does not reload the listing").toBe(listsBefore);
  });

  it("shows a refused symlink's message and never reports success", async () => {
    const message = "SFTP error: Permission denied: cannot create the symlink /etc/passwd-link";
    refusals.session_create_symlink = sftpRefusal(message);
    await renderBrowser();
    await contextAction("context-file-symlink");
    await setInputValue(inBody("symlink-name") as HTMLInputElement, "passwd-link");
    const listsBefore = listCalls().length;

    await clickAndSettle("symlink-create");

    expectShownFailure("session_create_symlink", message, "symlink-dialog");
    expect(listCalls().length, "a failed symlink does not reload the listing").toBe(listsBefore);
  });

  it("reports success only when the operation resolves", async () => {
    await renderBrowser();
    await contextAction("context-file-permissions");

    await clickAndSettle("permissions-apply");

    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(String(toastSuccess.mock.calls[0][0])).toContain('"passwd"');
    expect(inBody("permissions-dialog")).toBeNull();
  });
});
