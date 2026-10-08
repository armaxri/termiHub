/**
 * The plugin crash overlay (#4188): a plugin tab whose sandboxed plugin process
 * failed shows the failure-specific heading, names the plugin, reports the
 * restart count from the `plugin-sandbox` region and offers Restart session /
 * Close tab — all driven by the backend regions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TerminalDisconnectOverlay } from "./TerminalDisconnectOverlay";
import { withTooltip } from "@/test/tooltip";
import { useAppStore } from "@/store/appStore";
import {
  setSessionTransportForTest,
  stopSessionSubscription,
  type PluginSessionExit,
} from "@/store/sessionBridge";
import {
  connected,
  disconnected,
  FakeSessionTransport,
} from "@/test/sessionLifecycleRegionTestHarness";
import type { PluginSandboxView } from "@/store/pluginSandboxBridge";

let mockSandbox: PluginSandboxView = { outOfProcess: true, plugins: {} };
vi.mock("@/store/usePluginSandbox", () => ({
  usePluginSandbox: () => mockSandbox,
}));

const TAB = "tab-plugin";

function pluginExit(kind: PluginSessionExit["kind"], message: string): PluginSessionExit {
  return { pluginId: "acme", pluginName: "Acme Modbus Terminal", kind, message };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("TerminalPluginExitOverlay (#4188)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let transport: FakeSessionTransport;
  const reconnectTerminal = vi.fn();
  const closeTab = vi.fn();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    transport = new FakeSessionTransport();
    setSessionTransportForTest(transport);
    mockSandbox = { outOfProcess: true, plugins: {} };
    useAppStore.setState({ terminalViewMode: {}, reconnectTerminal, closeTab });
    reconnectTerminal.mockReset();
    closeTab.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    stopSessionSubscription();
    setSessionTransportForTest(null);
  });

  async function renderWith(exit: PluginSessionExit | undefined): Promise<void> {
    transport.setSession(TAB, { ...disconnected("unexpected"), pluginExit: exit });
    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();
  }

  function q(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid='${testId}']`);
  }

  it("shows the crash variant with the plugin, the restart count and the signal", async () => {
    mockSandbox = {
      outOfProcess: true,
      plugins: {
        acme: {
          isolation: "full",
          enforced: ["seatbelt"],
          missing: [],
          denials: [],
          process: { state: "running", sessions: 0, crashes: 1, maxRestarts: 3 },
        },
      },
    };
    await renderWith(
      pluginExit("crashed", "plugin process exited: signal SIGSEGV (segmentation fault)")
    );
    const overlay = q("terminal-plugin-exit")!;
    expect(overlay.textContent).toContain("The plugin stopped unexpectedly");
    expect(overlay.textContent).toContain(
      '"Acme Modbus Terminal" ran in its own sandboxed process, so termiHub and your other sessions are not affected. termiHub restarted the plugin (1 of 3).'
    );
    expect(q("terminal-plugin-exit-reason")!.textContent).toBe(
      "Plugin process exited: signal SIGSEGV (segmentation fault)"
    );
  });

  it.each([
    ["notResponding", "the plugin stopped responding", "The plugin stopped responding"],
    ["outOfMemory", "the plugin used too much memory", "The plugin used too much memory"],
    ["invalidData", "the plugin sent invalid data: bad frame", "The plugin sent invalid data"],
  ] as const)("shows the %s variant", async (kind, message, heading) => {
    await renderWith(pluginExit(kind, message));
    expect(q("terminal-plugin-exit")!.textContent).toContain(heading);
  });

  it("restarts the session on Restart session", async () => {
    await renderWith(pluginExit("crashed", "plugin process exited"));
    act(() => q("terminal-plugin-exit-restart-btn")!.click());
    expect(reconnectTerminal).toHaveBeenCalledWith(TAB);
  });

  it("disables Restart session once the plugin was disabled after crashes", async () => {
    mockSandbox = {
      outOfProcess: true,
      plugins: {
        acme: {
          isolation: "full",
          enforced: [],
          missing: [],
          denials: [],
          process: {
            state: "disabled",
            sessions: 0,
            crashes: 4,
            maxRestarts: 3,
            autoDisabled: "Disabled after 3 crashes",
          },
        },
      },
    };
    await renderWith(pluginExit("crashed", "plugin process exited"));
    expect(q("terminal-plugin-exit")!.textContent).toContain("Disabled after 3 crashes");
    expect((q("terminal-plugin-exit-restart-btn") as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the generic overlay for a session without a plugin exit", async () => {
    await renderWith(undefined);
    expect(q("terminal-plugin-exit")).toBeNull();
    expect(q("terminal-disconnect-overlay")!.textContent).toContain("Session disconnected");
  });

  it("does not show a stale plugin exit over a live session", async () => {
    transport.setSession(TAB, {
      ...connected(),
      pluginExit: pluginExit("crashed", "plugin process exited"),
    });
    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();
    expect(q("terminal-plugin-exit")).toBeNull();
  });
});
