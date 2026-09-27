import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TerminalPortalProvider } from "@/components/Terminal/TerminalRegistry";
import { TestBridge } from "./TestBridge";
import { TEST_BRIDGE_GLOBAL_KEY, TEST_BRIDGE_PORT_GLOBAL_KEY } from "./testMode";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/api", () => ({
  sendInput: vi.fn().mockResolvedValue(undefined),
  listWindows: vi.fn().mockResolvedValue([{ label: "main", tabCount: 0 }]),
}));

let container: HTMLDivElement;
let root: Root;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <TerminalPortalProvider>
        <TestBridge />
      </TerminalPortalProvider>
    );
  });
}

beforeEach(() => {
  delete window.__termihubTestBridge;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  delete window.__termihubTestBridge;
  delete (window as unknown as Record<string, unknown>)[TEST_BRIDGE_GLOBAL_KEY];
});

describe("TestBridge", () => {
  it("does not install the bridge when test mode is off", () => {
    mount();
    expect(window.__termihubTestBridge).toBeUndefined();
  });

  describe("with test mode enabled", () => {
    beforeEach(() => {
      (window as unknown as Record<string, unknown>)[TEST_BRIDGE_GLOBAL_KEY] = true;
    });

    it("installs a ready, versioned bridge on the window", () => {
      mount();
      expect(window.__termihubTestBridge).toBeDefined();
      expect(window.__termihubTestBridge?.ready).toBe(true);
      expect(typeof window.__termihubTestBridge?.version).toBe("number");
    });

    it("dispatches commands against the live DOM", async () => {
      const probe = document.createElement("div");
      probe.setAttribute("data-testid", "probe");
      probe.textContent = "hello";
      document.body.appendChild(probe);

      mount();
      const res = await window.__termihubTestBridge!.dispatch({
        action: "getText",
        testId: "probe",
      });
      expect(res).toEqual({ ok: true, action: "getText", value: "hello" });

      probe.remove();
    });

    it("dispatches getState against the live store", async () => {
      mount();
      const res = await window.__termihubTestBridge!.dispatch({
        action: "getState",
        path: "sidebarCollapsed",
      });
      expect(res.ok).toBe(true);
      expect(typeof res.value).toBe("boolean");
    });

    it("reports v2 of the protocol (multi-window, #3720)", () => {
      mount();
      expect(window.__termihubTestBridge?.version).toBe(2);
    });

    it("lists the backend window registry via listWindows", async () => {
      mount();
      const res = await window.__termihubTestBridge!.dispatch({ action: "listWindows" });
      expect(res).toEqual({
        ok: true,
        action: "listWindows",
        value: [{ label: "main", tabCount: 0 }],
      });
    });

    it("defers the requested window close until after the reply", async () => {
      vi.useFakeTimers();
      try {
        const close = vi.fn(() => Promise.resolve());
        vi.mocked(getCurrentWindow).mockReturnValueOnce({
          label: "main",
          close,
        } as unknown as ReturnType<typeof getCurrentWindow>);
        mount();

        const res = await window.__termihubTestBridge!.dispatch({ action: "closeWindow" });

        // The reply is produced first; the real close follows on a timer so a
        // window destroyed straight away cannot swallow the response.
        expect(res).toEqual({ ok: true, action: "closeWindow" });
        expect(close).not.toHaveBeenCalled();
        vi.advanceTimersByTime(100);
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("tags the runner socket with this window's label", () => {
      const urls: string[] = [];
      class FakeSocket {
        constructor(url: string) {
          urls.push(url);
        }
        addEventListener() {}
        removeEventListener() {}
        send() {}
        close() {}
      }
      const realWebSocket = globalThis.WebSocket;
      vi.stubGlobal("WebSocket", FakeSocket);
      (window as unknown as Record<string, unknown>)[TEST_BRIDGE_PORT_GLOBAL_KEY] = 45123;
      try {
        mount();
        expect(urls).toEqual(["ws://127.0.0.1:45123/?window=main"]);
      } finally {
        delete (window as unknown as Record<string, unknown>)[TEST_BRIDGE_PORT_GLOBAL_KEY];
        vi.stubGlobal("WebSocket", realWebSocket);
      }
    });

    it("removes the bridge on unmount", () => {
      mount();
      expect(window.__termihubTestBridge).toBeDefined();
      act(() => root.unmount());
      expect(window.__termihubTestBridge).toBeUndefined();
    });
  });
});
