/**
 * Regression test for #3814: Refresh (and a history re-run) must not stack a
 * second open-ports listing while one is already in flight. On Windows each
 * listing used to spawn dozens of console processes, so stacked runs made the
 * app bog down and flash windows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkOpenPorts } from "@/services/networkApi";
import type { OpenPort } from "@/types/network";
import { OpenPortsPanel } from "./OpenPortsPanel";

vi.mock("@/services/networkApi", () => ({
  networkOpenPorts: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

// Stub the history list with a re-run button that ignores `rerunDisabled`, so
// the panel's own single-flight guard is exercised, and expose the flag.
vi.mock("./NetworkToolHistory", () => ({
  NetworkToolHistory: ({
    onRerun,
    rerunDisabled,
  }: {
    onRerun: () => void;
    rerunDisabled?: boolean;
  }) => (
    <button
      type="button"
      data-testid="history-rerun"
      data-rerun-disabled={String(Boolean(rerunDisabled))}
      onClick={() => onRerun()}
    />
  ),
}));

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const refreshButton = () =>
  container.querySelector<HTMLButtonElement>('[data-testid="open-ports-refresh"]')!;
const rerunButton = () =>
  container.querySelector<HTMLButtonElement>('[data-testid="history-rerun"]')!;

describe("OpenPortsPanel — one listing at a time (#3814)", () => {
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

  it("ignores Refresh and history re-run while the mount-load is in flight", async () => {
    const first = deferred<OpenPort[]>();
    vi.mocked(networkOpenPorts).mockReturnValueOnce(first.promise);

    await act(async () => {
      root.render(<OpenPortsPanel />);
    });
    expect(networkOpenPorts).toHaveBeenCalledTimes(1);

    // Pending state is visible: Refresh disabled + busy, placeholder says so,
    // and the history re-run is disabled too.
    expect(refreshButton().disabled).toBe(true);
    expect(refreshButton().getAttribute("aria-busy")).toBe("true");
    expect(refreshButton().textContent).toContain("Refreshing…");
    expect(container.textContent).toContain("Listing listening ports…");
    expect(rerunButton().dataset.rerunDisabled).toBe("true");

    // Neither path can stack a second listing.
    await act(async () => {
      refreshButton().click();
      rerunButton().click();
      rerunButton().click();
    });
    expect(networkOpenPorts).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve([{ protocol: "TCP", localAddr: "0.0.0.0:22", pid: 100, process: "sshd" }]);
    });
    await flush();

    expect(container.textContent).toContain("sshd");
    expect(refreshButton().disabled).toBe(false);
    expect(refreshButton().textContent).toContain("Refresh");
    expect(rerunButton().dataset.rerunDisabled).toBe("false");

    // Once idle, Refresh lists again.
    await act(async () => {
      refreshButton().click();
    });
    await flush();
    expect(networkOpenPorts).toHaveBeenCalledTimes(2);
  });

  it("a failed listing releases the guard so Refresh works again", async () => {
    const first = deferred<OpenPort[]>();
    vi.mocked(networkOpenPorts).mockReturnValueOnce(
      first.promise.then(() => Promise.reject(new Error("boom")))
    );

    await act(async () => {
      root.render(<OpenPortsPanel />);
    });
    await act(async () => {
      first.resolve([]);
    });
    await flush();
    expect(container.textContent).toContain("boom");
    expect(refreshButton().disabled).toBe(false);

    await act(async () => {
      rerunButton().click();
    });
    await flush();
    expect(networkOpenPorts).toHaveBeenCalledTimes(2);
  });
});
