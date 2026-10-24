/**
 * A monitor row's URL is cut to fit the sidebar; the cut URL must still be
 * readable in full from a tooltip (#4954, MT-UI-53). It used to be sliced to
 * 24 characters in JS with the full URL only in the button's accessible name,
 * so a sighted user had no way to see it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkHttpMonitorList } from "@/services/networkApi";
import type { HttpMonitorState } from "@/types/network";
import { useAppStore } from "@/store/appStore";
import { withTooltip } from "@/test/tooltip";
import { NetworkToolsSidebar } from "./NetworkToolsSidebar";

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
  onHttpMonitorCheck: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

const URL = "https://api.staging.example.com/v2/health/readiness";

const MONITOR: HttpMonitorState = {
  config: {
    id: "m1",
    url: URL,
    intervalMs: 30_000,
    method: "GET",
    expectedStatus: 200,
    timeoutMs: 10_000,
  },
  running: true,
  paused: false,
};

let container: HTMLDivElement;
let root: Root;

async function render() {
  vi.mocked(networkHttpMonitorList).mockResolvedValue([MONITOR]);
  await act(async () => {
    root.render(withTooltip(<NetworkToolsSidebar />));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function urlEl(): HTMLElement {
  return container.querySelector(".network-sidebar__monitor-url") as HTMLElement;
}

/** Give the URL a fake layout: `scroll` px of content in a `client` px box. */
function clip(el: HTMLElement) {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: 300 });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: 80 });
}

describe("NetworkToolsSidebar — a cut monitor URL keeps a tooltip (#4954)", () => {
  beforeEach(() => {
    useAppStore.setState({ httpMonitors: [] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    useAppStore.setState({ httpMonitors: [] });
  });

  it("renders the whole URL (without the scheme) and lets CSS cut it", async () => {
    await render();
    expect(urlEl().textContent).toBe("api.staging.example.com/v2/health/readiness");
  });

  it("shows the full URL in a tooltip when the URL is cut", async () => {
    await render();
    clip(urlEl());
    act(() => {
      urlEl().dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    });
    // The tooltip root mounts on the first clipped hover; re-query the span.
    clip(urlEl());
    act(() => {
      urlEl().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(URL);
  });
});
