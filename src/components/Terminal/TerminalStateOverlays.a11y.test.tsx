/**
 * Screen-reader announcement and focus handling of the remaining terminal
 * content overlays (#4514, follow-up to #4331): the "Taken over" overlays
 * (desktop and window), the plugin crash overlay and the files-only panel must
 * each be announced exactly once with the right politeness, describe
 * themselves by their message, move focus to their primary action only in the
 * active tab, and pass axe.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { TerminalEvictedOverlay, TerminalWindowEvictedOverlay } from "./TerminalEvictedOverlay";
import { TerminalPluginExitOverlay } from "./TerminalPluginExitOverlay";
import { TerminalFilesOnlyPanel } from "./TerminalFilesOnlyPanel";
import { withTooltip } from "@/test/tooltip";
import { checkA11y } from "@/test/axe";
import {
  connected,
  evicted,
  flushSessionRegion,
  installSessionLifecycleHarness,
} from "@/test/sessionLifecycleRegionTestHarness";
import type { PluginSessionExit } from "@/store/sessionBridge";
import type { PluginSandboxView } from "@/store/pluginSandboxBridge";

let mockSandbox: PluginSandboxView = { plugins: {} };
vi.mock("@/store/usePluginSandbox", () => ({
  usePluginSandbox: () => mockSandbox,
}));

const TAB = "tab-overlay-a11y";
const harness = installSessionLifecycleHarness();

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockSandbox = { plugins: {} };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderUi(ui: ReactElement): Promise<void> {
  act(() => root.render(withTooltip(ui)));
  await flushSessionRegion();
}

/** Every announcing node in the render — there must be exactly one. */
function announcers(): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[role='status'], [role='alert'], [aria-live]")
  );
}

function liveRegion(): HTMLElement {
  const regions = announcers();
  expect(regions).toHaveLength(1);
  expect(regions[0].getAttribute("data-testid")).toBe("content-overlay-live");
  return regions[0];
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid='${id}']`);
}

function description(): string {
  const body = container.querySelector(".ui-content-overlay") as HTMLElement;
  return (body.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

function pluginExit(kind: PluginSessionExit["kind"], message: string): PluginSessionExit {
  return { pluginId: "acme", pluginName: "Acme Modbus Terminal", kind, message };
}

describe("TerminalEvictedOverlay announcement (#4514)", () => {
  it("announces the desktop takeover politely, exactly once", async () => {
    harness.transport.setSession(TAB, evicted());
    await renderUi(<TerminalEvictedOverlay tabId={TAB} isActive />);
    const region = liveRegion();
    expect(region.getAttribute("role")).toBe("status");
    expect(region.textContent).toBe(
      "Taken over by another desktop. This session is still running, but another desktop or window is now controlling it. Input is paused here until you reclaim it."
    );
  });

  it("focuses Reclaim in the active tab only", async () => {
    harness.transport.setSession(TAB, evicted());
    await renderUi(<TerminalEvictedOverlay tabId={TAB} isActive />);
    expect(document.activeElement).toBe(byTestId("terminal-evicted-reclaim-btn"));
    act(() => root.unmount());
    root = createRoot(container);
    (document.activeElement as HTMLElement | null)?.blur();
    await renderUi(<TerminalEvictedOverlay tabId={TAB} isActive={false} />);
    expect(byTestId("terminal-evicted-reclaim-btn")).not.toBeNull();
    expect(document.activeElement).not.toBe(byTestId("terminal-evicted-reclaim-btn"));
  });

  it("has no axe violations", async () => {
    harness.transport.setSession(TAB, evicted());
    await renderUi(<TerminalEvictedOverlay tabId={TAB} isActive />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

describe("TerminalWindowEvictedOverlay announcement (#4514)", () => {
  it("announces the window takeover politely and focuses Reclaim when active", async () => {
    await renderUi(
      <TerminalWindowEvictedOverlay sessionId="s-1" controllingWindowName="Window 2" isActive />
    );
    const region = liveRegion();
    expect(region.getAttribute("role")).toBe("status");
    expect(region.textContent).toContain("Taken over by another window.");
    expect(region.textContent).toContain("Window 2 is now controlling it.");
    expect(document.activeElement).toBe(byTestId("terminal-evicted-reclaim-btn"));
    expect(await checkA11y(container)).toHaveNoViolations();
  });

  it("does not take focus in a background tab", async () => {
    await renderUi(
      <TerminalWindowEvictedOverlay sessionId="s-1" controllingWindowName="Window 2" />
    );
    expect(document.activeElement).not.toBe(byTestId("terminal-evicted-reclaim-btn"));
  });
});

describe("TerminalPluginExitOverlay announcement (#4514)", () => {
  it("announces the crash assertively with its reason, exactly once", async () => {
    await renderUi(
      <TerminalPluginExitOverlay
        tabId={TAB}
        exit={pluginExit("crashed", "plugin process exited: signal SIGSEGV")}
        isActive
      />
    );
    const region = liveRegion();
    expect(region.getAttribute("role")).toBe("alert");
    expect(region.textContent).toBe(
      "The plugin stopped unexpectedly. Plugin process exited: signal SIGSEGV"
    );
    expect(description()).toContain("Plugin process exited: signal SIGSEGV");
  });

  it("focuses Restart session in the active tab only", async () => {
    await renderUi(
      <TerminalPluginExitOverlay tabId={TAB} exit={pluginExit("crashed", "boom")} isActive />
    );
    expect(document.activeElement).toBe(byTestId("terminal-plugin-exit-restart-btn"));
    act(() => root.unmount());
    root = createRoot(container);
    (document.activeElement as HTMLElement | null)?.blur();
    await renderUi(<TerminalPluginExitOverlay tabId={TAB} exit={pluginExit("crashed", "boom")} />);
    expect(document.activeElement).toBe(document.body);
  });

  it("falls back to Close tab when restarting is disabled", async () => {
    mockSandbox = {
      plugins: {
        acme: {
          isolation: "full",
          enforced: [],
          missing: [],
          denials: [],
          process: {
            state: "running",
            sessions: 0,
            crashes: 3,
            maxRestarts: 3,
            autoDisabled: "Disabled after repeated crashes",
          },
        },
      },
    } as PluginSandboxView;
    await renderUi(
      <TerminalPluginExitOverlay tabId={TAB} exit={pluginExit("crashed", "boom")} isActive />
    );
    expect(document.activeElement).toBe(byTestId("terminal-plugin-exit-close-btn"));
  });

  it("has no axe violations", async () => {
    await renderUi(
      <TerminalPluginExitOverlay tabId={TAB} exit={pluginExit("outOfMemory", "oom")} isActive />
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

describe("TerminalFilesOnlyPanel announcement (#4514)", () => {
  const filesOnly = () => ({ ...connected(), filesOnly: true });

  it("announces the no-shell state politely, exactly once", async () => {
    harness.transport.setSession(TAB, filesOnly());
    await renderUi(<TerminalFilesOnlyPanel tabId={TAB} isActive />);
    const region = liveRegion();
    expect(region.getAttribute("role")).toBe("status");
    expect(region.textContent).toBe(
      "This host doesn't allow a shell. Files are available in the sidebar."
    );
  });

  it("focuses Open Files in the active tab only", async () => {
    harness.transport.setSession(TAB, filesOnly());
    await renderUi(<TerminalFilesOnlyPanel tabId={TAB} isActive />);
    expect(document.activeElement).toBe(byTestId("terminal-files-only-open-files"));
    act(() => root.unmount());
    root = createRoot(container);
    (document.activeElement as HTMLElement | null)?.blur();
    await renderUi(<TerminalFilesOnlyPanel tabId={TAB} />);
    expect(byTestId("terminal-files-only-open-files")).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("has no axe violations", async () => {
    harness.transport.setSession(TAB, filesOnly());
    await renderUi(<TerminalFilesOnlyPanel tabId={TAB} isActive />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
