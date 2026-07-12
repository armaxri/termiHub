/**
 * Tests for PingPanel host-field validation (#1381).
 *
 * The Host field is composed from the shared ui {@link Field} + {@link Input}
 * primitives, so a cleared host surfaces the inline `ui-field__msg` affordance
 * and blocks Start rather than only greying the button.
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

function hostInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('[data-testid="ping-host"]')!;
}

function fieldError(): Element | null {
  return container.querySelector(".ui-field__msg");
}

describe("PingPanel — host validation", () => {
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

  it("blocks Start when the host is empty", async () => {
    await act(async () => {
      root.render(<PingPanel />);
    });
    expect(startButton().disabled).toBe(true);
  });

  it("renders the host through the shared field and flags it inline once cleared", async () => {
    await act(async () => {
      root.render(<PingPanel prefillHost="example.com" />);
    });
    await act(async () => setInputValue(hostInput(), ""));
    expect(startButton().disabled).toBe(true);
    expect(fieldError()?.textContent).toContain("Host is required");
  });

  it("enables Start and shows no host error for a valid host", async () => {
    await act(async () => {
      root.render(<PingPanel prefillHost="example.com" />);
    });
    expect(startButton().disabled).toBe(false);
    expect(container.textContent).not.toContain("Host is required");
  });
});
