/**
 * #4327 (LIBFE2-004) — Log Viewer copies go through the Tauri clipboard plugin.
 *
 * `navigator.clipboard.writeText` rejects on macOS/WKWebView when the document
 * is not focused (see TerminalRegistry), so the viewer must use the plugin's
 * `writeText` and confirm or report every copy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "@/components/ui";
import { onFrontendLog } from "@/utils/frontendLog";
import type { LogEntry } from "@/types/terminal";
import { LogViewer } from "./LogViewer";

vi.mock("@/services/api", () => ({
  getLogs: vi.fn(() =>
    Promise.resolve([
      {
        timestamp: "12:00:00.000",
        level: "INFO",
        target: "termihub::ssh",
        message: "login with password=hunter2",
      },
    ])
  ),
  clearLogs: vi.fn(),
}));

vi.mock("@/services/events", () => ({
  onLogEntry: vi.fn(() => Promise.resolve(() => {})),
}));

let container: HTMLDivElement;
let root: Root;
let browserWriteText: ReturnType<typeof vi.fn>;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function copyVia(label: "Copy Entry" | "Copy All Logs"): Promise<void> {
  const row = container.querySelector(".log-viewer__entry");
  expect(row).not.toBeNull();
  act(() => {
    row!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  });
  await flush();
  const item = Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem']")).find((el) =>
    el.textContent?.includes(label)
  );
  expect(item).toBeDefined();
  await act(async () => item!.click());
  await flush();
}

describe("LogViewer copy via the Tauri clipboard (#4327)", () => {
  beforeEach(async () => {
    vi.mocked(writeText).mockReset().mockResolvedValue(undefined);
    browserWriteText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: browserWriteText } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<LogViewer isVisible={true} />));
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("copies one entry through the plugin, redacted, and confirms it", async () => {
    const successSpy = vi.spyOn(toast, "success");

    await copyVia("Copy Entry");

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = vi.mocked(writeText).mock.calls[0][0];
    expect(copied).toContain("termihub::ssh");
    expect(copied).not.toContain("hunter2");
    expect(browserWriteText).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith("Log entry copied");
  });

  it("copies all logs through the plugin and confirms it", async () => {
    const successSpy = vi.spyOn(toast, "success");

    await copyVia("Copy All Logs");

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(browserWriteText).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith("Logs copied", { description: "1 entry" });
  });

  it("shows an error toast when the clipboard write fails", async () => {
    const errorSpy = vi.spyOn(toast, "error");
    vi.mocked(writeText).mockRejectedValue(new Error("clipboard denied"));

    await copyVia("Copy Entry");
    expect(errorSpy).toHaveBeenCalledWith("Could not copy log entry", {
      description: "clipboard denied",
    });

    await copyVia("Copy All Logs");
    expect(errorSpy).toHaveBeenCalledWith("Could not copy logs", {
      description: "clipboard denied",
    });
  });

  it("records a failed copy as an ERROR entry in the log (OBS2-006)", async () => {
    vi.mocked(writeText).mockRejectedValue(new Error("clipboard denied"));
    const logged: LogEntry[] = [];
    const unsub = onFrontendLog((entry) => logged.push(entry));

    await copyVia("Copy Entry");
    unsub();

    expect(
      logged.some(
        (e) =>
          e.level === "ERROR" &&
          e.target === "frontend::log_viewer" &&
          e.message.includes("clipboard denied")
      )
    ).toBe(true);
  });
});
