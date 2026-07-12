/**
 * Tests for TraceroutePanel host-field validation (#1381).
 *
 * The Host field is composed from the shared ui {@link Field} + {@link Input}
 * primitives; a cleared host surfaces the inline error affordance and blocks
 * Start.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TraceroutePanel } from "./TraceroutePanel";

vi.mock("@/services/networkApi", () => ({
  networkTraceroute: vi.fn(() => Promise.resolve("task-1")),
  networkTracerouteCancel: vi.fn(() => Promise.resolve()),
  onTracerouteHop: vi.fn(() => Promise.resolve(() => {})),
  onTracerouteComplete: vi.fn(() => Promise.resolve(() => {})),
  onTracerouteError: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

let container: HTMLDivElement;
let root: Root;

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function runButton(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-testid="traceroute-run"]')!;
}

function hostInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('[data-testid="traceroute-host"]')!;
}

function fieldError(): Element | null {
  return container.querySelector(".ui-field__msg");
}

describe("TraceroutePanel — host validation", () => {
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
      root.render(<TraceroutePanel />);
    });
    expect(runButton().disabled).toBe(true);
  });

  it("renders the host through the shared field and flags it inline once cleared", async () => {
    await act(async () => {
      root.render(<TraceroutePanel prefillHost="example.com" />);
    });
    await act(async () => setInputValue(hostInput(), ""));
    expect(runButton().disabled).toBe(true);
    expect(fieldError()?.textContent).toContain("Host is required");
  });

  it("enables Start for a valid host", async () => {
    await act(async () => {
      root.render(<TraceroutePanel prefillHost="example.com" />);
    });
    expect(runButton().disabled).toBe(false);
  });
});
