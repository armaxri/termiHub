/**
 * Screen-reader announcement and focus handling of the "Connection failed"
 * overlay (#4331 / A11Y2-002): the failure must land in an assertive live
 * region with its error, and focus moves to Retry only in the visible tab.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: () => Promise.resolve(),
}));

import { TerminalConnectionOverlay } from "./TerminalConnectionOverlay";
import { useAppStore } from "@/store/appStore";

const TAB_ID = "tab-a11y";
const PANEL_ID = "panel-a11y";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useAppStore.setState({
    terminalSpawnErrors: { [TAB_ID]: "Connection refused" },
    terminalSpawnErrorKinds: { [TAB_ID]: "other" },
    terminalAutoRetryCount: {},
    terminalWaitingForAgent: {},
    terminalRetryCounters: {},
    terminalReattaching: {},
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(isVisible: boolean): void {
  act(() => {
    root.render(
      <TerminalConnectionOverlay
        tabId={TAB_ID}
        panelId={PANEL_ID}
        tabTitle="build-host"
        isVisible={isVisible}
        sessionType="ssh"
      />
    );
  });
}

function liveRegion(): HTMLElement | null {
  return container.querySelector("[data-testid='content-overlay-live']");
}

function retryButton(): HTMLElement | null {
  return container.querySelector("[data-testid='terminal-connection-retry-btn']");
}

describe("TerminalConnectionOverlay — failed state a11y (#4331)", () => {
  it("announces the failure assertively with its error", () => {
    render(true);
    expect(liveRegion()?.getAttribute("role")).toBe("alert");
    expect(liveRegion()?.textContent).toBe("Connection failed. build-host: Connection refused");
  });

  it("describes the overlay body by its error message", () => {
    render(true);
    const body = container.querySelector(".ui-content-overlay") as HTMLElement;
    const description = (body.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(description).toContain("Connection refused");
  });

  it("moves focus to Retry when the overlay is in the visible tab", () => {
    render(true);
    expect(document.activeElement).toBe(retryButton());
  });

  it("leaves focus alone in a background tab, then focuses Retry once it is shown", () => {
    render(false);
    expect(document.activeElement).toBe(document.body);
    render(true);
    expect(document.activeElement).toBe(retryButton());
  });

  it("does not re-announce when re-rendered unchanged", async () => {
    render(true);
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((recs) => mutations.push(...recs));
    observer.observe(liveRegion() as HTMLElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    render(true);
    render(true);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    observer.disconnect();
    expect(mutations).toHaveLength(0);
  });
});
