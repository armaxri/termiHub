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
import { cancelConnecting, createTerminal, closeTerminal } from "@/services/api";
import { CONNECTING_TIMEOUT_MS } from "@/utils/connectTimeout";
import { getAllLeaves } from "@/utils/panelTree";
import { layoutState } from "@/test/layoutState";
import { checkA11y } from "@/test/axe";

vi.mock("@/services/api", () => ({
  createTerminal: vi.fn(() => Promise.resolve("ftp-session-1")),
  closeTerminal: vi.fn(() => Promise.resolve()),
  cancelConnecting: vi.fn(() => Promise.resolve(true)),
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
const mockedCancelConnecting = vi.mocked(cancelConnecting);

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

    expect(container.textContent).toContain("Connection failed");
    expect(container.textContent).toContain("Invalid FTP settings: invalid type: null");
    expect(container.textContent).not.toContain("[object Object]");
    expect(container.querySelector('[data-testid="file-browser-tab-retry"]')).not.toBeNull();
  });

  describe("shared ContentOverlay phases (UISF2-006 / #4382)", () => {
    function liveRegion(): HTMLElement | null {
      return container.querySelector("[data-testid='content-overlay-live']");
    }

    it("connecting: shared connect surface (#5068) + busy overlay announced through the live region", async () => {
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
      expect(body.classList.contains("ui-connect-progress")).toBe(true);
      expect(body.querySelector(".ui-content-overlay")?.getAttribute("aria-busy")).toBe("true");
      const ring = body.querySelector(".ui-connect-progress__ring");
      expect(ring).not.toBeNull();
      expect(ring?.getAttribute("aria-hidden")).toBe("true");
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
      expect(region?.textContent).toBe("Connection failed. My FTP Server: connection refused");
      const body = container.querySelector(
        "[data-testid='file-browser-tab-error'] .ui-content-overlay"
      );
      const describedBy = body?.getAttribute("aria-describedby") ?? "";
      const errorEl = container.querySelector(".ui-connect-progress__error");
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

  describe("connect parity with terminal tabs (#5377)", () => {
    function q(testId: string): HTMLElement | null {
      return container.querySelector(`[data-testid='${testId}']`);
    }
    function phaseOf(): string | null | undefined {
      return q("file-browser-tab-error")?.getAttribute("data-phase");
    }
    async function mount(connectionId?: string): Promise<string> {
      const tabId = addFileBrowserTab(connectionId);
      await act(async () => {
        root.render(React.createElement(FileBrowserTab, { tabId, isVisible: true }));
      });
      await act(async () => {
        await Promise.resolve();
      });
      return tabId;
    }

    it("passes a per-attempt connect id so the connect can be aborted", async () => {
      mockedCreateTerminal.mockReturnValueOnce(new Promise<string>(() => {}));
      const tabId = await mount();
      expect(mockedCreateTerminal.mock.calls[0][1]).toMatch(new RegExp(`^${tabId}:fb:`));
    });

    it("Abort while connecting cancels the backend connect and rests on Connection aborted", async () => {
      let resolve: (id: string) => void = () => {};
      mockedCreateTerminal.mockReturnValueOnce(new Promise<string>((r) => (resolve = r)));
      const tabId = await mount("Work/ftp");
      expect(q("file-browser-tab-abort")?.textContent).toBe("Abort");

      act(() => q("file-browser-tab-abort")?.click());
      const connectId = mockedCreateTerminal.mock.calls[0][1];
      expect(mockedCancelConnecting).toHaveBeenCalledWith(connectId);
      expect(phaseOf()).toBe("aborted");
      expect(q("file-browser-tab-error")?.textContent).toContain("Connection aborted");
      expect(q("file-browser-tab-retry")).not.toBeNull();
      expect(q("file-browser-tab-close")).not.toBeNull();
      // An aborted connect is not a broken connection: no Edit connection.
      expect(q("file-browser-tab-edit")).toBeNull();

      // A session that still arrives is torn down, never adopted.
      await act(async () => {
        resolve("late-session");
        await Promise.resolve();
      });
      expect(mockedCloseTerminal).toHaveBeenCalledWith("late-session");
      expect(tabSessionId(tabId)).toBeNull();
    });

    it("gives up at the terminal connect deadline and offers Retry", async () => {
      mockedCreateTerminal.mockReturnValueOnce(new Promise<string>(() => {}));
      await mount();
      expect(q("file-browser-tab-connecting")?.textContent).toContain("times out in 90s");

      act(() => {
        vi.advanceTimersByTime(CONNECTING_TIMEOUT_MS - 1);
      });
      expect(q("file-browser-tab-connecting")).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(phaseOf()).toBe("timeout");
      expect(q("file-browser-tab-error")?.textContent).toContain("Timed out");
      expect(q("file-browser-tab-error")?.textContent).toContain("Gave up after 1m 30s");
      expect(mockedCancelConnecting).toHaveBeenCalledOnce();
    });

    it("Retry starts a fresh connect", async () => {
      mockedCreateTerminal.mockRejectedValueOnce(new Error("boom"));
      const tabId = await mount();
      await act(async () => {
        q("file-browser-tab-retry")?.click();
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockedCreateTerminal).toHaveBeenCalledTimes(2);
      expect(tabSessionId(tabId)).toBe("ftp-session-1");
    });

    it("Close tab closes the tab", async () => {
      mockedCreateTerminal.mockRejectedValueOnce(new Error("boom"));
      const tabId = await mount();
      act(() => q("file-browser-tab-close")?.click());
      expect(useAppStore.getState().tabContent[tabId]).toBeUndefined();
    });

    it("a refused connect names itself, hides the OS error behind Details and offers Edit", async () => {
      mockedCreateTerminal.mockRejectedValueOnce({ code: "refused", message: "os error 61" });
      const open = vi.spyOn(useAppStore.getState(), "openConnectionEditorTab");
      await mount("Work/ftp");
      expect(phaseOf()).toBe("failed");
      expect(q("file-browser-tab-error")?.textContent).toContain("Connection refused");
      expect(q("terminal-connection-error-details")?.textContent).toContain("os error 61");
      expect(container.querySelector(".ui-connect-progress__error")).toBeNull();
      act(() => q("file-browser-tab-edit")?.click());
      expect(open).toHaveBeenCalledWith(
        "Work/ftp",
        undefined,
        expect.objectContaining({ field: "port" })
      );
    });

    it("a rejected password offers re-entry that retries with the new password", async () => {
      vi.useRealTimers();
      mockedCreateTerminal.mockRejectedValueOnce({ code: "auth_failed", message: "530 Login" });
      await mount();
      expect(q("file-browser-tab-error")?.textContent).toContain(
        "The server rejected the credentials"
      );
      act(() => q("terminal-credential-reentry-open-btn")?.click());
      const input = q("terminal-credential-reentry-secret") as HTMLInputElement;
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, "s3cret");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        q("terminal-credential-reentry-submit")?.click();
        await new Promise((r) => setTimeout(r, 0));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(mockedCreateTerminal).toHaveBeenCalledTimes(2);
      expect(mockedCreateTerminal.mock.calls[1][0]).toEqual({
        type: "ftp",
        config: { host: "ftp.example.com", password: "s3cret" },
      });
    });
  });
});
