/**
 * #5789: a monitor takes an optional name and one-line description, which the
 * sidebar row shows instead of the URL (docs/copy-style.md -> "List rows").
 * The panel forwards both to `networkHttpMonitorStart` (8th and 9th
 * arguments), blank as `undefined`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkHttpMonitorStart } from "@/services/networkApi";
import { ITEM_DESCRIPTION_MAX_LENGTH } from "@/utils/itemDescription";
import { HttpMonitorPanel } from "./HttpMonitorPanel";
import { withTooltip } from "@/test/tooltip";

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorStart: vi.fn(() => Promise.resolve("mon-1")),
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
  networkHttpMonitorRemove: vi.fn(() => Promise.resolve()),
  networkHttpMonitorPause: vi.fn(() => Promise.resolve()),
  networkHttpMonitorResume: vi.fn(() => Promise.resolve()),
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
  onHttpMonitorCheck: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
vi.mock("./LatencyChart", () => ({ LatencyChart: () => null }));

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const input = (testId: string) =>
  container.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!;

describe("HttpMonitorPanel — name and description (#5789)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(networkHttpMonitorStart).mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function start(fields: Record<string, string>) {
    await act(async () => {
      root.render(withTooltip(<HttpMonitorPanel />));
    });
    await flush();
    act(() => setInputValue(input("http-monitor-url"), "https://example.com/health"));
    for (const [testId, value] of Object.entries(fields)) {
      act(() => setInputValue(input(testId), value));
    }
    await flush();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="http-monitor-start"]')!.click();
    });
    await flush();
    expect(networkHttpMonitorStart).toHaveBeenCalledTimes(1);
    return vi.mocked(networkHttpMonitorStart).mock.calls[0];
  }

  it("caps the description at the shared item length", async () => {
    await act(async () => {
      root.render(withTooltip(<HttpMonitorPanel />));
    });
    expect(input("http-monitor-description").maxLength).toBe(ITEM_DESCRIPTION_MAX_LENGTH);
  });

  it("forwards the name and description, trimmed", async () => {
    const args = await start({
      "http-monitor-name": "  Shop front ",
      "http-monitor-description": "Checks the  landing page",
    });
    expect(args[7]).toBe("Shop front");
    expect(args[8]).toBe("Checks the landing page");
  });

  it("sends none when both are left blank", async () => {
    const args = await start({ "http-monitor-name": "   " });
    expect(args[7]).toBeUndefined();
    expect(args[8]).toBeUndefined();
  });
});
