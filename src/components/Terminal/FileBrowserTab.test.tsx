/**
 * Tests for {@link FileBrowserTab} — the terminal-less (browser-only) tab body
 * used by connections whose `Capabilities.terminal === false` (FTP), added for
 * #1335. It verifies the tab mints and owns its own session (its own
 * session-creation entry, not via `<Terminal>`), adopts a pre-existing session,
 * renders the placeholder, and closes the session on unmount.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { FileBrowserTab } from "./FileBrowserTab";
import { createTerminal, closeTerminal } from "@/services/api";
import { getAllLeaves } from "@/utils/panelTree";
import { layoutState } from "@/test/layoutState";

vi.mock("@/services/api", () => ({
  createTerminal: vi.fn(() => Promise.resolve("ftp-session-1")),
  closeTerminal: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

const mockedCreateTerminal = vi.mocked(createTerminal);
const mockedCloseTerminal = vi.mocked(closeTerminal);

function tabSessionId(tabId: string): string | null {
  return (
    getAllLeaves(layoutState().rootPanel)
      .flatMap((l) => l.tabs)
      .find((t) => t.id === tabId)?.sessionId ?? null
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  mockedCreateTerminal.mockResolvedValue("ftp-session-1");
  useAppStore.setState(useAppStore.getInitialState());
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  container.remove();
});

/** Create a file-browser tab in the store and return its id. */
function addFileBrowserTab(): string {
  return useAppStore
    .getState()
    .addTab(
      "My FTP Server",
      "ftp",
      { type: "ftp", config: { host: "ftp.example.com" } },
      { contentType: "file-browser" }
    );
}

describe("FileBrowserTab", () => {
  it("mints a session on mount and attaches it to the tab", async () => {
    const tabId = addFileBrowserTab();
    expect(tabSessionId(tabId)).toBeNull();

    await act(async () => {
      root.render(React.createElement(FileBrowserTab, { tabId, isVisible: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockedCreateTerminal).toHaveBeenCalledOnce();
    expect(mockedCreateTerminal).toHaveBeenCalledWith({
      type: "ftp",
      config: { host: "ftp.example.com" },
    });
    expect(tabSessionId(tabId)).toBe("ftp-session-1");
    expect(container.querySelector('[data-testid="file-browser-tab"]')).not.toBeNull();
    expect(container.textContent).toContain("No terminal for this connection");
  });

  it("adopts an existing tab session instead of minting a new one", async () => {
    const tabId = addFileBrowserTab();
    act(() => {
      useAppStore.getState().setTabSessionId(tabId, "pre-minted");
    });

    await act(async () => {
      root.render(React.createElement(FileBrowserTab, { tabId, isVisible: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockedCreateTerminal).not.toHaveBeenCalled();
    expect(tabSessionId(tabId)).toBe("pre-minted");
  });

  it("closes the owned session when the tab is closed", async () => {
    const tabId = addFileBrowserTab();
    await act(async () => {
      root.render(React.createElement(FileBrowserTab, { tabId, isVisible: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(tabSessionId(tabId)).toBe("ftp-session-1");

    await act(async () => {
      root.unmount();
    });
    // The close is deferred (50 ms) so a StrictMode remount can cancel it.
    expect(mockedCloseTerminal).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(mockedCloseTerminal).toHaveBeenCalledWith("ftp-session-1");
  });
});
