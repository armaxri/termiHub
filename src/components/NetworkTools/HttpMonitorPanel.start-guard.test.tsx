/**
 * Regression test for the HTTP monitor Start double-fire guard (GAP #7, #1147).
 *
 * The Start button had no pending guard — it was only disabled when the URL was
 * empty. A rapid double-click (or a second click while a previous start promise
 * was still in flight) fired `handleStart` twice, spawning two independent
 * backend monitors for the same URL. The panel attaches to the *last* returned
 * id; the first monitor becomes an untracked background poller only killable via
 * the sidebar.
 *
 * The fix relies on the shared Button's async lifecycle: because `handleStart`
 * returns a promise, the Button enters its `pending` state on the first click,
 * disables itself, and ignores further clicks until the promise resolves. This
 * test pins that a second click while the first start is in flight results in
 * exactly ONE start call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkHttpMonitorStart } from "@/services/networkApi";
import { HttpMonitorPanel } from "./HttpMonitorPanel";
import { withTooltip } from "@/test/tooltip";

// A deferred start: the promise stays pending until we resolve it, letting us
// fire a second click while the first start is genuinely in flight.
let resolveStart: ((id: string) => void) | null = null;

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorStart: vi.fn(
    () =>
      new Promise<string>((resolve) => {
        resolveStart = resolve;
      })
  ),
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
  onHttpMonitorCheck: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

// LatencyChart draws to a canvas jsdom can't back; stub it.
vi.mock("./LatencyChart", () => ({ LatencyChart: () => null }));

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Set a React-controlled input's value via the native setter so onChange fires. */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function startButton(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-testid="http-monitor-start"]')!;
}

describe("HttpMonitorPanel — Start double-fire guard", () => {
  beforeEach(() => {
    resolveStart = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("fires only one start when Start is double-clicked with the first start in flight", async () => {
    await act(async () => {
      root.render(withTooltip(<HttpMonitorPanel />));
    });
    await flush();

    await act(async () => {
      setInputValue(
        container.querySelector<HTMLInputElement>('[data-testid="http-monitor-url"]')!,
        "https://example.com"
      );
    });

    // Two clicks in the SAME tick, before React can re-render the disabled
    // state — the worst case of a rapid double-click. Without an in-handler
    // guard this fires two duplicate starts.
    await act(async () => {
      startButton().click();
      startButton().click();
    });
    await flush();

    expect(vi.mocked(networkHttpMonitorStart)).toHaveBeenCalledTimes(1);

    // A further click while the first start is still in flight is also rejected
    // by the in-flight guard — still exactly one start.
    await act(async () => {
      startButton().click();
    });
    await flush();
    expect(vi.mocked(networkHttpMonitorStart)).toHaveBeenCalledTimes(1);

    // Resolve the first start so the pending state can settle cleanly.
    await act(async () => {
      resolveStart?.("mon-1");
    });
    await flush();
  });
});
