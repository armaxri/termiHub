/**
 * Tests for HTTP monitor URL validation (#1357).
 *
 * The Start button previously used the brittle `url === "https://"` sentinel to
 * decide validity. It now runs a real scheme+host check: the default bare
 * `https://`, an empty field, and non-http garbage all keep Start disabled and
 * surface an inline error, while a real URL enables it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
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

function startButton(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-testid="http-monitor-start"]')!;
}

function urlInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('[data-testid="http-monitor-url"]')!;
}

describe("HttpMonitorPanel — URL validation", () => {
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

  async function render() {
    await act(async () => {
      root.render(withTooltip(<HttpMonitorPanel />));
    });
    await flush();
  }

  it("keeps Start disabled for the default bare 'https://'", async () => {
    await render();
    expect(startButton().disabled).toBe(true);
  });

  it("keeps Start disabled for an empty URL", async () => {
    await render();
    await act(async () => setInputValue(urlInput(), ""));
    expect(startButton().disabled).toBe(true);
  });

  it("flags invalid input inline and blocks Start", async () => {
    await render();
    await act(async () => setInputValue(urlInput(), "not-a-url"));
    expect(startButton().disabled).toBe(true);
    expect(container.textContent).toContain("Enter a valid http(s) URL");
  });

  it("enables Start for a real URL", async () => {
    await render();
    await act(async () => setInputValue(urlInput(), "https://example.com"));
    expect(startButton().disabled).toBe(false);
    expect(container.textContent).not.toContain("Enter a valid http(s) URL");
  });
});
