/**
 * Delayed-render paste of remote-copied files (#1804 macOS, #1814 Windows,
 * #1815/#1847 Linux): opening the clipboard panel lists the files the remote
 * copied under "Remote files", and "Copy to clipboard" binds them onto the host
 * OS clipboard and confirms with an "N file(s) ready" toast (#4004).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { withTooltip } from "@/test/tooltip";
import type { RemoteDesktopSession } from "@/hooks/useRemoteDesktopSession";
import type { RemoteClipboardFile } from "@/types/remoteDesktop";
import { RemoteDesktopTab } from "./RemoteDesktopTab";

const hoisted = vi.hoisted(() => ({
  session: null as unknown as RemoteDesktopSession,
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("@/hooks/useRemoteDesktopSession", () => ({
  useRemoteDesktopSession: () => hoisted.session,
}));

vi.mock("./RemoteDesktopCanvas", () => ({
  RemoteDesktopCanvas: () => <div data-testid="remote-desktop-canvas" />,
}));

vi.mock("./RemoteDesktopClipboardImage", () => ({
  RemoteDesktopClipboardImage: () => null,
}));

vi.mock("@/services/api", () => ({
  claimSession: vi.fn(() => Promise.resolve(null)),
  releaseSession: vi.fn(() => Promise.resolve(true)),
  remoteDesktopGetClipboard: vi.fn(() => Promise.resolve(null)),
  remoteDesktopFileChannel: vi.fn(() =>
    Promise.resolve({ status: "unavailable", reason: "noRoute" })
  ),
  remoteDesktopMonitorLayout: vi.fn(() => Promise.resolve([])),
}));

vi.mock("sonner", () => ({
  toast: {
    success: hoisted.toastSuccess,
    info: hoisted.toastInfo,
    error: vi.fn(),
  },
}));

const SID = "rd-files";

function file(index: number, name: string, isDir = false): RemoteClipboardFile {
  return { index, name, isDir, relativePath: null, size: isDir ? null : 42 };
}

function fakeSession(files: RemoteClipboardFile[], bound: number): RemoteDesktopSession {
  return {
    sessionId: SID,
    state: "active",
    reconnectAttempt: 0,
    message: null,
    remoteClipboard: null,
    certPrompt: null,
    respondCert: vi.fn(),
    viewOnly: false,
    scaleMode: "fit",
    fixedResolution: false,
    multiMonitor: false,
    monitorLayoutVersion: 0,
    sendInput: vi.fn(),
    releaseInput: vi.fn(),
    resize: vi.fn(),
    sendClipboard: vi.fn(),
    remoteClipboardFiles: vi.fn(async () => files),
    bindClipboardFiles: vi.fn(async () => bound),
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

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  hoisted.toastSuccess.mockReset();
  hoisted.toastInfo.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  tabId = useAppStore
    .getState()
    .addTab(
      "Mock RD",
      "mock-remote-desktop",
      { type: "mock-remote-desktop", config: { host: "mock.local" } },
      { contentType: "remote-desktop" }
    );
  act(() => useAppStore.getState().setTabSessionId(tabId, SID));
  useAppStore.setState({ windowLabel: "main", sessionOwners: { [SID]: "main" } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const byTestId = <T extends HTMLElement = HTMLElement>(id: string) =>
  container.querySelector<T>(`[data-testid='${id}']`);

/** Render the tab with `files` on the remote clipboard and open the panel. */
async function openPanel(files: RemoteClipboardFile[], bound = files.length) {
  hoisted.session = fakeSession(files, bound);
  act(() => root.render(withTooltip(<RemoteDesktopTab tabId={tabId} isVisible />)));
  const toggle = byTestId<HTMLButtonElement>("remote-desktop-clipboard-btn");
  if (!toggle) throw new Error("clipboard toggle not rendered");
  await act(async () => {
    toggle.click();
    await Promise.resolve();
  });
  expect(byTestId("remote-desktop-clipboard-panel")).not.toBeNull();
}

/** Click "Copy to clipboard" and let the async bind settle. */
async function clickCopy() {
  const copy = byTestId<HTMLButtonElement>("remote-desktop-clipboard-copy-files");
  if (!copy) throw new Error("copy button not rendered");
  await act(async () => {
    copy.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("RemoteDesktopTab — remote clipboard files (#1804/#1814/#1815)", () => {
  it("lists the remote-copied files under 'Remote files', marking folders", async () => {
    await openPanel([file(0, "report.pdf"), file(1, "photos", true), file(2, "naïve 日本.txt")]);
    expect(hoisted.session.remoteClipboardFiles).toHaveBeenCalledTimes(1);

    const section = byTestId("remote-desktop-clipboard-files");
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain("Remote files");
    const names = Array.from(section?.querySelectorAll(".rd-clipboard__file") ?? []).map(
      (el) => el.textContent
    );
    expect(names).toEqual(["report.pdf", "photos/", "naïve 日本.txt"]);
    expect(byTestId("remote-desktop-clipboard-copy-files")?.textContent).toContain(
      "Copy to clipboard"
    );
  });

  it("hides the section when the remote copied no files", async () => {
    await openPanel([]);
    expect(byTestId("remote-desktop-clipboard-files")).toBeNull();
    expect(byTestId("remote-desktop-clipboard-copy-files")).toBeNull();
  });

  it("binds the files to the host clipboard and toasts 'N files ready'", async () => {
    await openPanel([file(0, "a.txt"), file(1, "b.txt")]);
    await clickCopy();
    expect(hoisted.session.bindClipboardFiles).toHaveBeenCalledTimes(1);
    expect(hoisted.toastSuccess).toHaveBeenCalledWith("2 files ready — paste into any app");
  });

  it("uses the singular for one file", async () => {
    await openPanel([file(0, "only.txt")]);
    await clickCopy();
    expect(hoisted.toastSuccess).toHaveBeenCalledWith("1 file ready — paste into any app");
  });

  it("reports when nothing could be bound", async () => {
    await openPanel([file(0, "gone.txt")], 0);
    await clickCopy();
    expect(hoisted.toastSuccess).not.toHaveBeenCalled();
    expect(hoisted.toastInfo).toHaveBeenCalledWith("No remote files to paste");
  });
});
