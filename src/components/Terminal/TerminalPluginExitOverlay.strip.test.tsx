/**
 * The plugin crash notice is a top strip, not a full-pane overlay (#5916).
 *
 * #5908 turned every session-end notice into a full-width strip at the top of
 * the terminal that pushes the output down. The plugin crash notice (#4188)
 * still covered the whole pane with the content scrim and a centred card, so a
 * crashed plugin session hid its scrollback. These pin it on the same strip:
 * no full-pane cover, the strip publishes its height as the top-notice inset,
 * only the strip is a toast keep-clear zone, and Restart session / Close tab
 * still work.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TerminalDisconnectOverlay } from "./TerminalDisconnectOverlay";
import { TOP_NOTICE_INSET_VAR } from "./topNoticeInset";
import { withTooltip } from "@/test/tooltip";
import { useAppStore } from "@/store/appStore";
import {
  setSessionTransportForTest,
  stopSessionSubscription,
  type PluginSessionExit,
} from "@/store/sessionBridge";
import { disconnected, FakeSessionTransport } from "@/test/sessionLifecycleRegionTestHarness";
import type { PluginSandboxView } from "@/store/pluginSandboxBridge";

let mockSandbox: PluginSandboxView = { plugins: {} };
vi.mock("@/store/usePluginSandbox", () => ({
  usePluginSandbox: () => mockSandbox,
}));

const TAB = "tab-plugin-strip";
const EXIT: PluginSessionExit = {
  pluginId: "acme",
  pluginName: "Acme Modbus Terminal",
  kind: "crashed",
  message: "plugin process exited: signal SIGSEGV",
};

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("TerminalPluginExitOverlay — a top strip (#5916)", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let transport: FakeSessionTransport;
  const reconnectTerminal = vi.fn();
  const dismissTerminalDisconnect = vi.fn();

  beforeEach(() => {
    // The slot's wrapper owns the top-notice inset, as in SplitView.
    host = document.createElement("div");
    host.className = "terminal-context-trigger";
    document.body.appendChild(host);
    root = createRoot(host);
    transport = new FakeSessionTransport();
    setSessionTransportForTest(transport);
    mockSandbox = { plugins: {} };
    useAppStore.setState({ reconnectTerminal, dismissTerminalDisconnect });
    reconnectTerminal.mockReset();
    dismissTerminalDisconnect.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    stopSessionSubscription();
    setSessionTransportForTest(null);
  });

  async function render(): Promise<HTMLElement> {
    transport.setSession(TAB, { ...disconnected("unexpected"), pluginExit: EXIT });
    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} isActive />)));
    await flush();
    const strip = host.querySelector<HTMLElement>("[data-testid='terminal-disconnect-overlay']");
    expect(strip).not.toBeNull();
    return strip!;
  }

  const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid='${id}']`);

  it("is the error strip, not the full-pane overlay with a scrim", async () => {
    const strip = await render();
    expect(strip.dataset.variant).toBe("plugin-exit");
    expect(strip.classList).toContain("terminal-disconnect-strip");
    expect(strip.classList).toContain("terminal-disconnect-strip--error");
    expect(strip.classList).not.toContain("terminal-disconnect-overlay");
    expect(host.querySelector(".terminal-disconnect-overlay")).toBeNull();
  });

  it("publishes its height so the terminal is pushed down below it", async () => {
    await render();
    expect(host.style.getPropertyValue(TOP_NOTICE_INSET_VAR)).toMatch(/^\d+px$/);
  });

  it("only the strip is a toast keep-clear zone", async () => {
    const strip = await render();
    const avoid = host.querySelectorAll("[data-toast-avoid]");
    expect(avoid).toHaveLength(1);
    expect(avoid[0]).toBe(strip);
  });

  it("keeps its copy and actions", async () => {
    const strip = await render();
    expect(strip.textContent).toContain("The plugin stopped unexpectedly");
    expect(strip.textContent).toContain("Acme Modbus Terminal");
    expect(q("terminal-plugin-exit-reason")?.textContent).toBe(
      "Plugin process exited: signal SIGSEGV"
    );
    act(() => q("terminal-plugin-exit-restart-btn")!.click());
    expect(reconnectTerminal).toHaveBeenCalledWith(TAB);
    act(() => q("terminal-disconnect-dismiss-btn")!.click());
    expect(dismissTerminalDisconnect).toHaveBeenCalledWith(TAB);
    expect(q("terminal-plugin-exit-close-btn")?.textContent).toBe("Close tab");
  });

  it("the unused full-pane error rule is gone from the stylesheet", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, "TerminalDisconnectOverlay.css"), "utf8");
    expect(css).not.toMatch(/\.terminal-disconnect-overlay--error\b/);
  });
});
