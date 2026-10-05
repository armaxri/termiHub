/**
 * Regression test for #4104: a Tauri command rejects with a structured
 * `{ code, message }` envelope, not an `Error`. The panel used to render it via
 * `String(err)`, which showed "[object Object]" instead of the real failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { HttpMonitorPanel } from "./HttpMonitorPanel";
import { withTooltip } from "@/test/tooltip";

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorStart: vi.fn(() =>
    Promise.reject({ code: "network_error", message: "connection refused by host" })
  ),
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
  onHttpMonitorCheck: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
vi.mock("./LatencyChart", () => ({ LatencyChart: () => null }));

let container: HTMLDivElement;
let root: Root;

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("HttpMonitorPanel — structured IPC error (#4104)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the envelope's message when Start rejects, not [object Object]", async () => {
    await act(async () => {
      root.render(withTooltip(<HttpMonitorPanel />));
    });
    await act(async () => {
      setInputValue(
        container.querySelector<HTMLInputElement>('[data-testid="http-monitor-url"]')!,
        "https://example.com"
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="http-monitor-start"]')!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const error = container.querySelector(".network-panel__error");
    expect(error?.textContent).toBe("connection refused by host");
    expect(container.textContent).not.toContain("[object Object]");
  });
});
