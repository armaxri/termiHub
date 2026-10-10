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
import { checkA11y } from "@/test/axe";

vi.mock("@/services/api", () => ({
  createTerminal: vi.fn(() => Promise.resolve("ftp-session-1")),
  closeTerminal: vi.fn(() => Promise.resolve()),
}));

// Preserve the real module (incl. fireAndForget) and stub only the DEBUG logger,
// so the component's fireAndForget teardown calls remain real functions.
vi.mock("@/utils/frontendLog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/frontendLog")>()),
  frontendLog: vi.fn(),
}));
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
  // Unmount so a still-mounted tab does not re-render on the next test's store reset.
  act(() => root.unmount());
  vi.useRealTimers();
  container.remove();
});

/** Create a file-browser tab in the store and return its id. */
function addFileBrowserTab(connectionId?: string): string {
  return useAppStore
    .getState()
    .addTab(
      "My FTP Server",
      "ftp",
      { type: "ftp", config: { host: "ftp.example.com" } },
      { contentType: "file-browser", connectionId }
    );
}

describe("FileBrowserTab", () => {
  it("names the saved connection the tab was opened from (#3876)", async () => {
    const tabId = addFileBrowserTab("Work/ftp");

    await act(async () => {
      root.render(React.createElement(FileBrowserTab, { tabId, isVisible: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockedCreateTerminal).toHaveBeenCalledOnce();
    expect(mockedCreateTerminal.mock.calls[0][5]).toBe("Work/ftp");
  });

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
    expect(mockedCreateTerminal.mock.calls[0][0]).toEqual({
      type: "ftp",
      config: { host: "ftp.example.com" },
    });
    expect(mockedCreateTerminal.mock.calls[0][5]).toBeUndefined();
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

  it("shows the backend error's message, not [object Object], on a failed connect (#4017)", async () => {
    // Tauri rejects a command error as a structured envelope, not an Error.
    mockedCreateTerminal.mockRejectedValueOnce({
      code: "invalid_config",
      message: "Invalid FTP settings: invalid type: null, expected a string",
    });
    const tabId = addFileBrowserTab();

    await act(async () => {
      root.render(React.createElement(FileBrowserTab, { tabId, isVisible: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Could not open connection");
    expect(container.textContent).toContain("Invalid FTP settings: invalid type: null");
    expect(container.textContent).not.toContain("[object Object]");
    expect(container.querySelector('[data-testid="file-browser-tab-retry"]')).not.toBeNull();
  });

  describe("shared ContentOverlay phases (UISF2-006 / #4382)", () => {
    function liveRegion(): HTMLElement | null {
      return container.querySelector("[data-testid='content-overlay-live']");
    }

    it("connecting: shared Spinner + busy overlay announced through the live region", async () => {
      // Never resolve, so the tab stays in its connecting phase.
      mockedCreateTerminal.mockReturnValueOnce(new Promise<string>(() => {}));
      const tabId = addFileBrowserTab();
      await act(async () => {
        root.render(React.createElement(FileBrowserTab, { tabId, isVisible: true }));
      });

      const body = container.querySelector(
        "[data-testid='file-browser-tab-connecting']"
      ) as HTMLElement;
      expect(body).not.toBeNull();
      expect(body.classList.contains("ui-content-overlay")).toBe(true);
      expect(body.getAttribute("aria-busy")).toBe("true");
      const spinner = body.querySelector(".ui-spinner");
      expect(spinner).not.toBeNull();
      expect(spinner?.getAttribute("class")).toContain("motion-essential-spinner");
      expect(spinner?.getAttribute("aria-hidden")).toBe("true");
      const region = liveRegion();
      expect(region?.getAttribute("role")).toBe("status");
      expect(region?.getAttribute("aria-live")).toBe("polite");
      expect(region?.textContent).toBe("Connecting… Opening My FTP Server.");
      // No hand-rolled spin class remains.
      expect(container.querySelector(".file-browser-tab__spin")).toBeNull();
    });

    it("error: failure is announced assertively with the backend message", async () => {
      mockedCreateTerminal.mockRejectedValueOnce(new Error("connection refused"));
      const tabId = addFileBrowserTab();
      await act(async () => {
        root.render(React.createElement(FileBrowserTab, { tabId, isVisible: true }));
      });
      await act(async () => {
        await Promise.resolve();
      });

      const region = liveRegion();
      expect(region?.getAttribute("role")).toBe("alert");
      expect(region?.textContent).toBe("Could not open connection. connection refused");
      const body = container.querySelector("[data-testid='file-browser-tab-error']");
      const describedBy = body?.getAttribute("aria-describedby") ?? "";
      const errorEl = container.querySelector(".file-browser-tab__error");
      expect(errorEl?.id).toBeTruthy();
      expect(describedBy.split(" ")).toContain(errorEl?.id);
    });

    it("has no accessibility violations in the error phase", async () => {
      vi.useRealTimers();
      mockedCreateTerminal.mockRejectedValueOnce(new Error("connection refused"));
      const tabId = addFileBrowserTab();
      await act(async () => {
        root.render(React.createElement(FileBrowserTab, { tabId, isVisible: true }));
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(container.querySelector("[data-testid='file-browser-tab-error']")).not.toBeNull();
      expect(await checkA11y()).toHaveNoViolations();
    });
  });
});
