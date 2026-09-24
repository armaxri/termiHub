/**
 * Component test for the process table panel (PROD-0028).
 *
 * The destructive path is what matters: a kill must never fire until the user
 * confirms, the confirmation must name the exact pid + process, and confirming
 * must call `killProcess` with that pid and the chosen signal. The Tauri API is
 * mocked so the assertions are about the confirm-gate, not the backend.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ProcessTablePanel } from "./ProcessTablePanel";
import type { ProcessInfo } from "@/types/monitoring";

const listProcesses = vi.fn();
const killProcess = vi.fn();

vi.mock("@/services/api", () => ({
  listProcesses: (...args: unknown[]) => listProcesses(...args),
  killProcess: (...args: unknown[]) => killProcess(...args),
}));

vi.mock("@/components/ui/Toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const SAMPLE: ProcessInfo[] = [
  {
    pid: 4321,
    name: "firefox",
    user: "alice",
    cpuPercent: 12.5,
    memoryPercent: 3.4,
    memoryKb: null,
  },
  { pid: 1, name: "systemd", user: "root", cpuPercent: 0.1, memoryPercent: 0.2, memoryKb: null },
];

let container: HTMLDivElement;
let root: Root;

/** Flush pending microtasks (the panel's async fetch) inside an `act`. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

describe("ProcessTablePanel (PROD-0028)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    listProcesses.mockResolvedValue(SAMPLE);
    killProcess.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    await act(async () => {
      root.render(
        <ProcessTablePanel open host="myhost" sessionId="sess-1" onOpenChange={() => {}} />
      );
    });
    await flush();
  }

  it("renders a row per process with its pid and name", async () => {
    await render();
    const row = byTestId("process-row-4321");
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("4321");
    expect(row?.textContent).toContain("firefox");
    expect(byTestId("process-row-1")).not.toBeNull();
  });

  it("does not kill until the confirmation is confirmed, and names the exact target", async () => {
    await render();

    // Clicking Kill opens the confirm dialog — but must NOT call killProcess yet.
    await act(async () => {
      byTestId("process-kill-4321")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(killProcess).not.toHaveBeenCalled();

    // The confirmation names the exact pid AND process name.
    const confirmBtn = byTestId("confirm-kill-process-confirm");
    expect(confirmBtn).not.toBeNull();
    expect(document.body.textContent).toContain("firefox");
    expect(document.body.textContent).toContain("pid 4321");

    // Confirming fires the kill for the exact pid with the default signal (term).
    await act(async () => {
      confirmBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(killProcess).toHaveBeenCalledTimes(1);
    expect(killProcess).toHaveBeenCalledWith("sess-1", 4321, "term");
  });

  it("cancelling the confirmation never kills", async () => {
    await render();
    await act(async () => {
      byTestId("process-kill-1")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const cancelBtn = byTestId("confirm-kill-process-cancel");
    expect(cancelBtn).not.toBeNull();
    await act(async () => {
      cancelBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(killProcess).not.toHaveBeenCalled();
  });
});
