/**
 * Screen-reader announcement and focus handling of the terminal disconnect
 * overlay variants (#4331 / A11Y2-002): every failure and disconnect state must
 * land in a live region with the right politeness, describe itself with its
 * message, and move focus to its primary action only in the active tab.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TerminalDisconnectOverlay } from "./TerminalDisconnectOverlay";
import { withTooltip } from "@/test/tooltip";
import { useAppStore } from "@/store/appStore";
import {
  authFailed,
  disconnected,
  failed,
  flushSessionRegion,
  installSessionLifecycleHarness,
  sessionLost,
} from "@/test/sessionLifecycleRegionTestHarness";
import type { ProjectedSessionLifecycle } from "@/store/sessionBridge";

const TAB = "tab-a11y";
const harness = installSessionLifecycleHarness();

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useAppStore.setState({ terminalViewMode: {}, terminalReconnectPrompt: {} });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderWith(life: ProjectedSessionLifecycle, isActive: boolean): Promise<void> {
  harness.transport.setSession(TAB, life);
  act(() => {
    root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} isActive={isActive} />));
  });
  await flushSessionRegion();
}

function liveRegion(): HTMLElement | null {
  return container.querySelector("[data-testid='content-overlay-live']");
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid='${id}']`);
}

describe("TerminalDisconnectOverlay announcements (#4331)", () => {
  it("announces a failed reconnect assertively with its error", async () => {
    await renderWith(failed("connection timed out"), true);
    expect(liveRegion()?.getAttribute("role")).toBe("alert");
    expect(liveRegion()?.textContent).toBe("Reconnect failed. connection timed out");
  });

  it("announces an authentication failure assertively", async () => {
    await renderWith(authFailed("Permission denied (publickey)"), true);
    expect(liveRegion()?.getAttribute("role")).toBe("alert");
    expect(liveRegion()?.textContent).toBe("Authentication failed. Permission denied (publickey)");
  });

  it("announces a lost session assertively with its cause", async () => {
    await renderWith(sessionLost("the live agent session could not be recovered"), true);
    expect(liveRegion()?.getAttribute("role")).toBe("alert");
    expect(liveRegion()?.textContent).toBe(
      "Session lost. the live agent session could not be recovered"
    );
  });

  it("announces a plain disconnect politely", async () => {
    await renderWith(disconnected("unexpected"), true);
    expect(liveRegion()?.getAttribute("role")).toBe("status");
    expect(liveRegion()?.textContent).toContain("Session disconnected.");
  });

  it("describes the failure body by its error message", async () => {
    await renderWith(failed("connection timed out"), true);
    const body = container.querySelector(".ui-content-overlay") as HTMLElement;
    const description = (body.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(description).toContain("connection timed out");
  });

  it("does not re-announce when the overlay re-renders unchanged", async () => {
    await renderWith(failed("connection timed out"), true);
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((recs) => mutations.push(...recs));
    observer.observe(liveRegion() as HTMLElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    for (let i = 0; i < 3; i++) {
      act(() => {
        root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} isActive />));
      });
    }
    await flushSessionRegion();
    observer.disconnect();
    expect(mutations).toHaveLength(0);
  });
});

describe("TerminalDisconnectOverlay focus (#4331)", () => {
  it("moves focus to Try Again on a failed reconnect in the active tab", async () => {
    await renderWith(failed("boom"), true);
    expect(document.activeElement).toBe(byTestId("terminal-disconnect-reconnect-btn"));
  });

  it("moves focus to Start New Shell when the session is lost in the active tab", async () => {
    await renderWith(sessionLost("gone"), true);
    expect(document.activeElement).toBe(byTestId("terminal-session-lost-new-shell-btn"));
  });

  it("moves focus to Reconnect on a disconnect in the active tab", async () => {
    await renderWith(disconnected("unexpected"), true);
    expect(document.activeElement).toBe(byTestId("terminal-disconnect-reconnect-btn"));
  });

  it("leaves focus alone in an inactive tab", async () => {
    await renderWith(failed("boom"), false);
    expect(document.activeElement).toBe(document.body);
  });
});
