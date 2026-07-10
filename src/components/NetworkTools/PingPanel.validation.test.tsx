/**
 * Tests for PingPanel numeric field validation (#1357).
 *
 * A blank or out-of-range interval must be flagged inline and must block Start
 * rather than being silently coerced and failing at run time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { PingPanel } from "./PingPanel";

vi.mock("@/services/networkApi", () => ({
  networkPingStart: vi.fn(() => Promise.resolve("task-1")),
  networkPingStop: vi.fn(() => Promise.resolve()),
  onPingResult: vi.fn(() => Promise.resolve(() => {})),
  onPingComplete: vi.fn(() => Promise.resolve(() => {})),
  onPingError: vi.fn(() => Promise.resolve(() => {})),
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

function startButton(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-testid="ping-start"]')!;
}

function intervalInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('[data-testid="ping-interval"]')!;
}

describe("PingPanel — interval validation", () => {
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

  it("enables Start with a valid host and default interval", async () => {
    await act(async () => {
      root.render(<PingPanel prefillHost="example.com" />);
    });
    expect(startButton().disabled).toBe(false);
  });

  it("blocks Start and flags the field when the interval is cleared", async () => {
    await act(async () => {
      root.render(<PingPanel prefillHost="example.com" />);
    });
    await act(async () => setInputValue(intervalInput(), ""));
    expect(startButton().disabled).toBe(true);
    expect(container.textContent).toContain("Interval is required");
  });

  it("blocks Start when the interval is out of range", async () => {
    await act(async () => {
      root.render(<PingPanel prefillHost="example.com" />);
    });
    await act(async () => setInputValue(intervalInput(), "0"));
    expect(startButton().disabled).toBe(true);
    expect(container.textContent).toContain("Interval must be between");
  });
});
