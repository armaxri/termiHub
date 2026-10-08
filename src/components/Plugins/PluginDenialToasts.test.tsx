import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { PluginSandboxView } from "@/store/pluginSandboxBridge";
import { EMPTY_SANDBOX_VIEW } from "@/store/pluginSandboxBridge";

const info = vi.fn();
vi.mock("@/components/ui", () => ({ toast: { info: (...args: unknown[]) => info(...args) } }));

let mockView: PluginSandboxView = EMPTY_SANDBOX_VIEW;
vi.mock("@/store/usePluginSandbox", () => ({ usePluginSandbox: () => mockView }));

vi.mock("@/store/appStore", () => ({
  useAppStore: <T,>(selector: (s: { plugins: unknown[] }) => T): T =>
    selector({ plugins: [{ manifest: { id: "sniffer", name: "Serial Sniffer" } }] }),
}));

import { PluginDenialToasts } from "./PluginDenialToasts";

function withDenials(atMs: number[]): PluginSandboxView {
  return {
    outOfProcess: true,
    plugins: {
      sniffer: {
        isolation: "full",
        enforced: [],
        missing: [],
        denials: atMs.map((at) => ({
          operation: "open_connection",
          target: "10.0.0.12:502",
          reason: "permission",
          atMs: at,
        })),
      },
    },
  };
}

describe("PluginDenialToasts (#4188)", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(): void {
    act(() => root.render(<PluginDenialToasts />));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    info.mockReset();
    mockView = EMPTY_SANDBOX_VIEW;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("toasts a new denial once, rate-limited, and summarises the rest later", () => {
    render();
    mockView = withDenials([]);
    render();
    expect(info).not.toHaveBeenCalled();

    mockView = withDenials([1]);
    render();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toBe("Blocked a plugin request");
    expect(info.mock.calls[0][1].description).toContain('"Serial Sniffer" tried to connect');
    expect(info.mock.calls[0][1].testId).toBe("plugin-denial-toast-sniffer");

    mockView = withDenials([1, 2, 3]);
    render();
    expect(info).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(30_000));
    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[1][1].description).toContain("blocked 2 more requests");
  });

  it("does not replay denials that existed before it subscribed", () => {
    mockView = withDenials([1, 2]);
    render();
    expect(info).not.toHaveBeenCalled();
  });
});
