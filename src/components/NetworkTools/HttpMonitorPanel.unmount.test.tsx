/**
 * Unmount during a monitor start (#4576, follow-up of #4375).
 *
 * Start registers the check listener behind an await. If the panel unmounts
 * while that registration is pending, the listener that registers afterwards
 * must be unlistened at once, and no monitor is started for the gone panel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkHttpMonitorStart, onHttpMonitorCheck } from "@/services/networkApi";
import { HttpMonitorPanel } from "./HttpMonitorPanel";
import { withTooltip } from "@/test/tooltip";

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorStart: vi.fn(() => Promise.resolve("mon-1")),
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
  onHttpMonitorCheck: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
vi.mock("./LatencyChart", () => ({ LatencyChart: () => null }));

let container: HTMLDivElement;
let root: Root;
let mounted = false;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function flush(times = 5) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function renderAndStart() {
  await act(async () => {
    root.render(withTooltip(<HttpMonitorPanel />));
  });
  mounted = true;
  await act(async () => {
    setInputValue(
      container.querySelector<HTMLInputElement>('[data-testid="http-monitor-url"]')!,
      "https://example.com"
    );
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="http-monitor-start"]')!.click();
  });
}

function unmount() {
  act(() => root.unmount());
  mounted = false;
}

describe("HttpMonitorPanel — unmount during start (#4576)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (mounted) unmount();
    container.remove();
  });

  it("unlistens a check listener whose registration resolves after unmount", async () => {
    const pending = deferred<() => void>();
    const unlisten = vi.fn();
    vi.mocked(onHttpMonitorCheck).mockReturnValueOnce(pending.promise);

    await renderAndStart();
    expect(onHttpMonitorCheck).toHaveBeenCalledTimes(1);
    unmount();

    await act(async () => {
      pending.resolve(unlisten);
    });
    await flush();

    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(networkHttpMonitorStart).not.toHaveBeenCalled();
  });

  it("unlistens a registered check listener on unmount", async () => {
    const unlisten = vi.fn();
    vi.mocked(onHttpMonitorCheck).mockResolvedValueOnce(unlisten);

    await renderAndStart();
    await flush();
    unmount();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
