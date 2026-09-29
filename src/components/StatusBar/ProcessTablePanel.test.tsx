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
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { KillSignal, ProcessInfo } from "@/types/monitoring";

const listProcesses = vi.fn();
const killProcess = vi.fn();

vi.mock("@/services/api", () => ({
  listProcesses: (...args: unknown[]) => listProcesses(...args),
  killProcess: (...args: unknown[]) => killProcess(...args),
}));

const platformMock = vi.hoisted(() => ({ value: "linux" as "linux" | "macos" | "windows" }));
vi.mock("@/utils/platform", () => ({
  getPlatform: () => platformMock.value,
}));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/components/ui/Toast", () => ({
  toast: toastMock,
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
    platformMock.value = "linux";
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(connectionType: string | null = "ssh") {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <ProcessTablePanel
            open
            host="myhost"
            sessionId="sess-1"
            connectionType={connectionType}
            onOpenChange={() => {}}
          />
        </TooltipProvider>
      );
    });
    await flush();
  }

  async function openKillConfirm(pid = 4321) {
    await act(async () => {
      byTestId(`process-kill-${pid}`)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
  }

  /** Open the signal picker and return its options. */
  function openSignalMenu(): HTMLElement[] {
    const trigger = byTestId("confirm-kill-process-signal") as HTMLButtonElement;
    act(() => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
  }

  function chooseSignal(signal: KillSignal) {
    const option = openSignalMenu().find((o) => o.dataset.value === signal);
    expect(option, `option ${signal}`).toBeDefined();
    act(() => {
      option?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      option?.click();
    });
  }

  async function confirm() {
    await act(async () => {
      byTestId("confirm-kill-process-confirm")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
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

  it("offers every common signal on a POSIX host", async () => {
    await render("ssh");
    await openKillConfirm();
    const options = openSignalMenu();
    expect(options.map((o) => o.dataset.value)).toEqual([
      "term",
      "kill",
      "int",
      "hup",
      "quit",
      "stop",
      "cont",
      "usr1",
      "usr2",
    ]);
    expect(options.every((o) => !o.hasAttribute("data-disabled"))).toBe(true);
  });

  it("offers every signal for a local session on a non-Windows desktop", async () => {
    platformMock.value = "macos";
    await render("local");
    await openKillConfirm();
    const options = openSignalMenu();
    expect(options).toHaveLength(9);
    expect(options.every((o) => !o.hasAttribute("data-disabled"))).toBe(true);
    expect(byTestId("confirm-kill-process-windows-hint")).toBeNull();
  });

  it("limits a Windows local session to TERM and KILL, explaining why", async () => {
    platformMock.value = "windows";
    await render("local");
    await openKillConfirm();
    expect(byTestId("confirm-kill-process-windows-hint")?.textContent).toContain("Windows");
    const options = openSignalMenu();
    const enabled = options.filter((o) => !o.hasAttribute("data-disabled"));
    expect(enabled.map((o) => o.dataset.value)).toEqual(["term", "kill"]);
    expect(options).toHaveLength(9);
  });

  it("keeps the full menu for a remote session even on a Windows desktop", async () => {
    platformMock.value = "windows";
    await render("ssh");
    await openKillConfirm();
    const options = openSignalMenu();
    expect(options.every((o) => !o.hasAttribute("data-disabled"))).toBe(true);
    expect(byTestId("confirm-kill-process-windows-hint")).toBeNull();
  });

  it.each(["kill", "stop"] as const)(
    "warns that %s is destructive and still waits for confirmation",
    async (signal) => {
      await render();
      await openKillConfirm();
      expect(byTestId("confirm-kill-process-destructive")).toBeNull();
      chooseSignal(signal);
      await flush();
      const warning = byTestId("confirm-kill-process-destructive");
      expect(warning).not.toBeNull();
      expect(warning?.textContent).toContain(signal === "kill" ? "SIGKILL" : "SIGSTOP");
      expect(killProcess).not.toHaveBeenCalled();
      await confirm();
      expect(killProcess).toHaveBeenCalledWith("sess-1", 4321, signal);
    }
  );

  it.each(["term", "kill", "int", "hup", "quit", "stop", "cont", "usr1", "usr2"] as const)(
    "dispatches %s as the chosen signal value",
    async (signal) => {
      await render();
      await openKillConfirm();
      chooseSignal(signal);
      await flush();
      expect(byTestId("confirm-kill-process-confirm")?.textContent).toContain(
        `SIG${signal.toUpperCase()}`
      );
      await confirm();
      expect(killProcess).toHaveBeenCalledTimes(1);
      expect(killProcess).toHaveBeenCalledWith("sess-1", 4321, signal);
    }
  );

  it("resets to TERM each time the kill action is opened", async () => {
    await render();
    await openKillConfirm();
    chooseSignal("usr1");
    await flush();
    await act(async () => {
      byTestId("confirm-kill-process-cancel")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );
    });
    await flush();
    await openKillConfirm(1);
    await confirm();
    expect(killProcess).toHaveBeenCalledWith("sess-1", 1, "term");
  });

  describe("agent-hosted sessions (#3210)", () => {
    it("lists and kills in an agent-hosted session with the full signal menu", async () => {
      platformMock.value = "windows";
      await render("remote-session");
      expect(listProcesses).toHaveBeenCalledWith("sess-1");
      expect(byTestId("process-row-4321")).not.toBeNull();
      await openKillConfirm();
      const options = openSignalMenu();
      expect(options.every((o) => !o.hasAttribute("data-disabled"))).toBe(true);
      chooseSignal("hup");
      await flush();
      await confirm();
      expect(killProcess).toHaveBeenCalledWith("sess-1", 4321, "hup");
    });

    it("tells the user to update an outdated agent, without a retry or an error toast", async () => {
      listProcesses.mockRejectedValue({
        code: "process_agent_outdated",
        message: "the agent must be updated",
        details: null,
      });
      await render("remote-session");
      const notice = byTestId("monitoring-processes-agent-outdated");
      expect(notice).not.toBeNull();
      expect(notice?.textContent).toContain("Update the agent");
      expect(byTestId("monitoring-processes-retry")).toBeNull();
      expect(byTestId("monitoring-processes-error")).toBeNull();
      expect(toastMock.error).not.toHaveBeenCalled();
    });

    it("shows a structured backend error's message", async () => {
      listProcesses.mockRejectedValue({
        code: "process_list_failed",
        message: "failed to list processes: ps missing",
        details: null,
      });
      await render("remote-session");
      const error = byTestId("monitoring-processes-error");
      expect(error?.textContent).toContain("ps missing");
      expect(byTestId("monitoring-processes-agent-outdated")).toBeNull();
    });
  });
});
