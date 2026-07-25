/**
 * Tests for {@link useWindowInfo} (#1902) — the hook that sources the current
 * window's identity and the live count of open windows from the backend window
 * registry (#1900), since stores are not shared across native windows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useWindowInfo, type WindowInfoState } from "./useWindowInfo";

const listWindows = vi.fn();
vi.mock("@/services/api", () => ({
  listWindows: (...args: unknown[]) => listWindows(...args),
}));

// getCurrentWindow / listen are stubbed globally in src/test/setup.ts.

function Probe({ onState }: { onState: (s: WindowInfoState) => void }) {
  onState(useWindowInfo());
  return null;
}

describe("useWindowInfo", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: WindowInfoState;

  beforeEach(() => {
    listWindows.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("reports the current window name and a count of one before the registry resolves", async () => {
    listWindows.mockResolvedValue([{ label: "main" }]);
    await act(async () => {
      root.render(<Probe onState={(s) => (latest = s)} />);
    });
    expect(latest.label).toBe("main");
    expect(latest.name).toBe("Main Window");
    expect(latest.count).toBe(1);
  });

  it("reflects the number of open windows from the registry", async () => {
    listWindows.mockResolvedValue([{ label: "main" }, { label: "win-1" }, { label: "win-2" }]);
    await act(async () => {
      root.render(<Probe onState={(s) => (latest = s)} />);
    });
    // Flush the async refresh microtask.
    await act(async () => {});
    expect(latest.count).toBe(3);
  });

  it("leaves the count at one when the registry read fails", async () => {
    listWindows.mockRejectedValue(new Error("no backend"));
    await act(async () => {
      root.render(<Probe onState={(s) => (latest = s)} />);
    });
    await act(async () => {});
    expect(latest.count).toBe(1);
  });
});
