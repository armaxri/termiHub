/**
 * Drop-to-upload and the Files button on a graphical tab (#4192, concept
 * `vnc-clipboard-file-transfer`): OS files dragged over the surface show the
 * drop overlay for the resolved route, a drop uploads through
 * `remote_desktop_upload` only when the route is ready, and the route is
 * re-resolved when the session becomes Active again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "@/store/appStore";
import { withTooltip } from "@/test/tooltip";
import { flushAsync } from "@/test/flushAsync";
import type { RemoteDesktopSession } from "@/hooks/useRemoteDesktopSession";
import type { GraphicalSessionState } from "@/types/remoteDesktop";
import type { RemoteDesktopFileChannel } from "@/types/generated/RemoteDesktopFileChannel";
import { useRemoteDesktopBrowseStore } from "@/store/remoteDesktopBrowseStore";
import { RemoteDesktopTab } from "./RemoteDesktopTab";

type DragPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

const hoisted = vi.hoisted(() => ({
  session: null as unknown as RemoteDesktopSession,
  channel: vi.fn(),
  upload: vi.fn(),
  openBrowser: vi.fn(),
  closeBrowser: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  storeCredential: vi.fn(),
}));

vi.mock("@/hooks/useRemoteDesktopSession", () => ({
  useRemoteDesktopSession: () => hoisted.session,
}));

vi.mock("./RemoteDesktopCanvas", () => ({
  RemoteDesktopCanvas: () => <div data-testid="remote-desktop-canvas" />,
}));

vi.mock("@/services/api", () => ({
  claimSession: vi.fn(() => Promise.resolve(null)),
  releaseSession: vi.fn(() => Promise.resolve(true)),
  remoteDesktopGetClipboard: vi.fn(() => Promise.resolve(null)),
  remoteDesktopMonitorLayout: vi.fn(() => Promise.resolve([])),
  remoteDesktopFileChannel: hoisted.channel,
  remoteDesktopUpload: hoisted.upload,
  remoteDesktopOpenFileBrowser: hoisted.openBrowser,
  remoteDesktopCloseFileBrowser: hoisted.closeBrowser,
  sessionListFiles: vi.fn(() => Promise.resolve([])),
  storeCredential: hoisted.storeCredential,
  // Opening the File Browser switches the sidebar view, whose layout is saved
  // on a 300 ms debounce that can fire while later tests in this file run.
  saveSettings: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, toast: { ...actual.toast, info: hoisted.info, error: hoisted.error } };
});

const SID = "rd-1";
const AT = { x: 0, y: 0 };

const READY: RemoteDesktopFileChannel = {
  status: "ready",
  channel: { kind: "ssh", host: "tiger-box", user: "arne", sameHost: true },
  agentId: null,
  defaultDir: "/home/arne/Desktop",
};

function fakeSession(state: GraphicalSessionState, viewOnly = false): RemoteDesktopSession {
  return {
    sessionId: SID,
    state,
    reconnectAttempt: 0,
    message: null,
    remoteClipboard: null,
    certPrompt: null,
    respondCert: vi.fn(),
    viewOnly,
    scaleMode: "fit",
    fixedResolution: false,
    multiMonitor: false,
    monitorLayoutVersion: 0,
    sendInput: vi.fn(),
    releaseInput: vi.fn(),
    resize: vi.fn(),
    sendClipboard: vi.fn(),
    remoteClipboardFiles: vi.fn(async () => []),
    bindClipboardFiles: vi.fn(async () => 0),
    reconnect: vi.fn(),
    cancelConnect: vi.fn(),
    cancelReconnect: vi.fn(),
    awaitingFirstFrame: false,
    noteFirstFrame: vi.fn(),
  };
}

let container: HTMLDivElement;
let root: Root;
let tabId: string;
let drag: ((event: { payload: DragPayload }) => void) | null;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  hoisted.channel.mockResolvedValue(READY);
  useRemoteDesktopBrowseStore.setState({ sources: {} });
  hoisted.openBrowser.mockImplementation((_id: string, dir?: string) =>
    Promise.resolve({
      channel: READY.status === "ready" ? READY.channel : null,
      startDir: dir ?? "/home/arne/Desktop",
    })
  );
  hoisted.closeBrowser.mockResolvedValue(undefined);
  hoisted.upload.mockResolvedValue({
    destDir: "/home/arne/Desktop",
    host: "tiger-box",
    transfers: [],
    folders: 1,
    skipped: [],
  });
  drag = null;
  vi.mocked(getCurrentWindow).mockReturnValue({
    label: "main",
    onDragDropEvent: vi.fn((cb: (event: { payload: DragPayload }) => void) => {
      drag = cb;
      return Promise.resolve(() => {});
    }),
  } as unknown as ReturnType<typeof getCurrentWindow>);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  tabId = useAppStore
    .getState()
    .addTab(
      "VNC tiger-box",
      "vnc",
      { type: "vnc", config: { host: "tiger-box" } },
      { contentType: "remote-desktop" }
    );
  act(() => useAppStore.getState().setTabSessionId(tabId, SID));
  useAppStore.setState({ windowLabel: "main", sessionOwners: { [SID]: "main" } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(state: GraphicalSessionState, viewOnly = false) {
  hoisted.session = fakeSession(state, viewOnly);
  act(() => root.render(withTooltip(<RemoteDesktopTab tabId={tabId} isVisible />)));
  await flushAsync();
}

function fire(payload: DragPayload) {
  act(() => drag?.({ payload }));
}

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid='${id}']`);

describe("RemoteDesktopTab — drop to upload (#4192)", () => {
  it("names the destination while files are dragged over, and uploads the drop", async () => {
    await render("active");
    expect(hoisted.channel).toHaveBeenCalledWith(SID);
    expect(q("remote-desktop-drop-overlay")).toBeNull();

    fire({ type: "enter", paths: ["/l/a.txt", "/l/b.txt"], position: AT });
    const overlay = q("remote-desktop-drop-overlay");
    expect(overlay?.dataset.state).toBe("ready");
    expect(overlay?.textContent).toContain("Drop to upload 2 files");
    expect(overlay?.textContent).toContain("to /home/arne/Desktop on tiger-box");

    fire({ type: "drop", paths: ["/l/a.txt", "/l/b.txt"], position: AT });
    await flushAsync();
    expect(q("remote-desktop-drop-overlay")).toBeNull();
    expect(hoisted.upload).toHaveBeenCalledWith(SID, ["/l/a.txt", "/l/b.txt"], undefined);
  });

  it("explains an unavailable route and ignores the drop", async () => {
    hoisted.channel.mockResolvedValue({ status: "unavailable", reason: "noRoute" });
    await render("active");
    fire({ type: "enter", paths: ["/l/a.txt"], position: AT });
    expect(q("remote-desktop-drop-overlay")?.dataset.state).toBe("noRoute");
    fire({ type: "drop", paths: ["/l/a.txt"], position: AT });
    await flushAsync();
    expect(hoisted.upload).not.toHaveBeenCalled();
    expect(hoisted.info).toHaveBeenCalledWith(
      "File transfer isn't available here",
      expect.objectContaining({ description: expect.stringContaining("SSH Tunnel") })
    );
  });

  it("refuses drops in a view-only session and hides the Files button", async () => {
    await render("active", true);
    expect(q("remote-desktop-files-btn")).toBeNull();
    fire({ type: "enter", paths: ["/l/a.txt"], position: AT });
    expect(q("remote-desktop-drop-overlay")?.dataset.state).toBe("viewOnly");
    fire({ type: "drop", paths: ["/l/a.txt"], position: AT });
    await flushAsync();
    expect(hoisted.upload).not.toHaveBeenCalled();
  });

  it("shows no overlay for a drag that leaves again", async () => {
    await render("active");
    fire({ type: "enter", paths: ["/l/a.txt"], position: AT });
    fire({ type: "leave" });
    expect(q("remote-desktop-drop-overlay")).toBeNull();
  });

  it("disables the Files button without a route, warns on a degraded one", async () => {
    hoisted.channel.mockResolvedValue({ status: "unavailable", reason: "disabled" });
    await render("active");
    expect(q("remote-desktop-files-btn")?.dataset.state).toBe("disabled");

    hoisted.channel.mockResolvedValue({
      status: "degraded",
      channel: READY.status === "ready" ? READY.channel : (null as never),
      agentId: null,
      message: "SFTP is not enabled on tiger-box",
    });
    // A reconnect cycle re-resolves the route.
    await render("reconnecting");
    await render("active");
    expect(q("remote-desktop-files-btn")?.dataset.state).toBe("warning");
    expect(q("remote-desktop-files-warning")).not.toBeNull();
  });

  it("opens the Files popover on the resolved route", async () => {
    await render("active");
    act(() => q("remote-desktop-files-btn")?.click());
    await flushAsync();
    expect(q("remote-desktop-files")).not.toBeNull();
    expect(q("remote-desktop-files-route")?.textContent).toContain(
      "/home/arne/Desktop on tiger-box"
    );
  });
});

describe("RemoteDesktopTab — browse remote files (#4193)", () => {
  async function openBrowse() {
    act(() => q("remote-desktop-files-btn")?.click());
    await flushAsync();
    act(() => q("remote-desktop-files-browse")?.click());
    await flushAsync();
  }

  it("opens the File Browser on the side channel at the upload folder", async () => {
    useAppStore.setState({ sidebarView: "connections", sidebarCollapsed: true });
    await render("active");
    await openBrowse();
    expect(hoisted.openBrowser).toHaveBeenCalledWith(SID, "/home/arne/Desktop");
    const source = useRemoteDesktopBrowseStore.getState().sources[tabId];
    expect(source).toMatchObject({ sessionId: SID, dir: "/home/arne/Desktop" });
    expect(source.channel.host).toBe("tiger-box");
    expect(useAppStore.getState().sidebarView).toBe("files");
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
    // The popover hands over to the sidebar.
    expect(q("remote-desktop-files")).toBeNull();
  });

  it("gives a view-only session no entry point", async () => {
    await render("active", true);
    expect(q("remote-desktop-files-btn")).toBeNull();
    expect(q("remote-desktop-files-browse")).toBeNull();
    expect(hoisted.openBrowser).not.toHaveBeenCalled();
  });

  it("records nothing when the open is refused", async () => {
    hoisted.openBrowser.mockRejectedValue("SFTP is not enabled on tiger-box");
    await render("active");
    await openBrowse();
    expect(useRemoteDesktopBrowseStore.getState().sources[tabId]).toBeUndefined();
  });

  it("re-attaches the browser after a reconnect, keeping its folder", async () => {
    await render("active");
    await openBrowse();
    hoisted.openBrowser.mockClear();
    await render("reconnecting");
    await render("active");
    expect(hoisted.openBrowser).toHaveBeenCalledWith(SID);
    expect(useRemoteDesktopBrowseStore.getState().sources[tabId]?.openCount).toBe(1);
  });

  it("closes the browser source with the session", async () => {
    await render("active");
    await openBrowse();
    act(() => root.unmount());
    root = createRoot(container);
    expect(hoisted.closeBrowser).toHaveBeenCalledWith(SID);
    expect(useRemoteDesktopBrowseStore.getState().sources[tabId]).toBeUndefined();
  });
});

describe("RemoteDesktopTab — linked SSH route without a saved password (#4265)", () => {
  const DEGRADED: RemoteDesktopFileChannel = {
    status: "degraded",
    channel: {
      kind: "ssh",
      host: "tiger-box",
      user: "arne",
      sameHost: false,
      linkedConnection: "Tiger",
    },
    agentId: null,
    message:
      "File transfer to tiger-box is unavailable: no password is saved for the linked SSH " +
      "connection 'Tiger'; enter it with Retry, or save it in that connection",
    needsSecret: {
      connectionId: "Lab/Tiger",
      sourceFile: null,
      kind: "password",
      authMethod: "password",
      host: "tiger-box",
      username: "arne",
      storeLocked: false,
      canSave: true,
      rejected: false,
    },
  };

  /** The backend: degraded until the password is supplied, then ready. */
  function linkedBackend() {
    hoisted.channel.mockImplementation((_id: string, secret?: string) =>
      Promise.resolve(secret === "pw" ? READY : DEGRADED)
    );
  }

  const promptOpen = () => useAppStore.getState().passwordPromptOpen;

  async function answer(password: string | null, save = false) {
    await act(async () => {
      if (password === null) useAppStore.getState().dismissPasswordPrompt();
      else useAppStore.getState().submitPassword(password, save);
    });
    await flushAsync();
  }

  it("never asks when the session starts — the route just waits", async () => {
    linkedBackend();
    await render("active");
    expect(hoisted.channel).toHaveBeenCalledTimes(1);
    expect(hoisted.channel).toHaveBeenCalledWith(SID);
    expect(promptOpen()).toBe(false);
    expect(q("remote-desktop-files-btn")?.dataset.state).toBe("warning");
  });

  it("asks when the Files popover opens, and the route becomes ready", async () => {
    linkedBackend();
    await render("active");
    act(() => q("remote-desktop-files-btn")?.click());
    await flushAsync();
    expect(promptOpen()).toBe(true);
    expect(useAppStore.getState().passwordPromptHost).toBe("tiger-box");
    expect(useAppStore.getState().passwordPromptUsername).toBe("arne");
    await answer("pw");
    expect(hoisted.channel).toHaveBeenLastCalledWith(SID, "pw");
    expect(q("remote-desktop-files-route")?.textContent).toContain(
      "/home/arne/Desktop on tiger-box"
    );
    expect(hoisted.storeCredential).not.toHaveBeenCalled();
  });

  it("saves the password under the linked connection when asked to", async () => {
    linkedBackend();
    await render("active");
    act(() => q("remote-desktop-files-btn")?.click());
    await flushAsync();
    await answer("pw", true);
    expect(hoisted.storeCredential).toHaveBeenCalledWith("Lab/Tiger", "password", "pw", null);
  });

  it("leaves the route degraded with its reason when the prompt is cancelled", async () => {
    linkedBackend();
    await render("active");
    act(() => q("remote-desktop-files-btn")?.click());
    await flushAsync();
    await answer(null);
    expect(promptOpen()).toBe(false);
    expect(q("remote-desktop-files-route")?.textContent).toContain("no password is saved");
    expect(q("remote-desktop-files-btn")?.dataset.state).toBe("warning");
    expect(hoisted.error).not.toHaveBeenCalled();
    expect(hoisted.info).not.toHaveBeenCalled();
  });

  it("asks again on Retry after a cancel", async () => {
    linkedBackend();
    await render("active");
    act(() => q("remote-desktop-files-btn")?.click());
    await flushAsync();
    await answer(null);
    act(() => q("remote-desktop-files-retry")?.click());
    await flushAsync();
    expect(promptOpen()).toBe(true);
    await answer("pw");
    expect(q("remote-desktop-files-route")?.textContent).toContain("on tiger-box");
  });

  it("asks on a drop, then uploads the dropped files", async () => {
    linkedBackend();
    await render("active");
    fire({ type: "enter", paths: ["/l/a.txt"], position: AT });
    fire({ type: "drop", paths: ["/l/a.txt"], position: AT });
    await flushAsync();
    expect(promptOpen()).toBe(true);
    expect(hoisted.upload).not.toHaveBeenCalled();
    await answer("pw");
    expect(hoisted.upload).toHaveBeenCalledWith(SID, ["/l/a.txt"], undefined);
    expect(hoisted.info).not.toHaveBeenCalled();
  });

  it("drops nothing when the drop's prompt is cancelled", async () => {
    linkedBackend();
    await render("active");
    fire({ type: "enter", paths: ["/l/a.txt"], position: AT });
    fire({ type: "drop", paths: ["/l/a.txt"], position: AT });
    await flushAsync();
    await answer(null);
    expect(hoisted.upload).not.toHaveBeenCalled();
    expect(hoisted.error).not.toHaveBeenCalled();
  });

  it("re-asks with the reason when the entered password is rejected", async () => {
    hoisted.channel.mockImplementation((_id: string, secret?: string) =>
      Promise.resolve(
        secret === "wrong"
          ? { ...DEGRADED, needsSecret: { ...DEGRADED.needsSecret!, rejected: true } }
          : secret === "pw"
            ? READY
            : DEGRADED
      )
    );
    await render("active");
    act(() => q("remote-desktop-files-btn")?.click());
    await flushAsync();
    await answer("wrong");
    expect(promptOpen()).toBe(true);
    expect(useAppStore.getState().passwordPromptNotice).toContain("rejected");
    await answer("pw");
    expect(q("remote-desktop-files-route")?.textContent).toContain("on tiger-box");
  });
});
