/**
 * The New Tab Group button's hint comes from the keybinding service (#4374,
 * WA-FE2-003): it used to always read "Ctrl+Shift+T", even on macOS and after a
 * user rebinding.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import { clearOverrides, setOverride, unbindAction } from "@/services/keybindings";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { flushAsync } from "@/test/flushAsync";
import { TabGroupChips } from "./TabGroupChips";

let container: HTMLDivElement;
let root: Root;

setupSettingsRegion();

const originalUserAgent = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");

function setUserAgent(ua: string): void {
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, get: () => ua });
}

async function render() {
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <TabGroupChips />
      </TooltipProvider>
    );
  });
  await flushAsync();
}

const addButton = () => document.querySelector<HTMLElement>('[data-testid="tab-group-add"]');

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  clearOverrides();
  if (originalUserAgent) Object.defineProperty(window.navigator, "userAgent", originalUserAgent);
  else delete (window.navigator as { userAgent?: string }).userAgent;
});

describe("TabGroupChips — New Tab Group shortcut label (#4374)", () => {
  it("shows Cmd on macOS", async () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    await render();
    expect(addButton()?.getAttribute("aria-label")).toBe("New Tab Group (Shift+Cmd+t)");
  });

  it("shows the user's customised binding", async () => {
    setOverride("new-tab-group", { key: "F8", ctrl: true });
    await render();
    expect(addButton()?.getAttribute("aria-label")).toBe("New Tab Group (Ctrl+F8)");
  });

  it("drops the hint when the action is unbound", async () => {
    unbindAction("new-tab-group");
    await render();
    expect(addButton()?.getAttribute("aria-label")).toBe("New Tab Group");
  });
});
