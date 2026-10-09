import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { LogViewer } from "./LogViewer";
import { toast } from "@/components/ui";

vi.mock("@/services/api", () => ({
  getLogs: vi.fn(),
  clearLogs: vi.fn(),
}));

vi.mock("@/services/events", () => ({
  onLogEntry: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({
  onFrontendLog: vi.fn(() => () => {}),
  fireAndForget: vi.fn(),
  frontendWarn: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: vi.fn(),
}));

import { getLogs, clearLogs } from "@/services/api";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { frontendWarn } from "@/utils/frontendLog";

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderViewer(): Promise<void> {
  await act(async () => {
    root.render(<LogViewer isVisible={true} />);
  });
  await flush();
}

async function click(title: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
  expect(button).not.toBeNull();
  await act(async () => {
    button?.click();
  });
  await flush();
}

// #4333: Log Viewer actions used to swallow their failures in empty catches.
describe("LogViewer failure feedback", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    vi.mocked(getLogs).mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("shows an error toast when clearing the logs fails", async () => {
    const errorSpy = vi.spyOn(toast, "error");
    vi.mocked(clearLogs).mockRejectedValue({ code: "io", message: "backend gone" });
    await renderViewer();

    await click("Clear logs");

    expect(errorSpy).toHaveBeenCalledWith("Could not clear logs", {
      description: "backend gone",
    });
  });

  it("shows an error toast when writing the saved log file fails", async () => {
    const errorSpy = vi.spyOn(toast, "error");
    vi.mocked(save).mockResolvedValue("/tmp/logs.txt");
    vi.mocked(writeTextFile).mockRejectedValue(new Error("disk full"));
    await renderViewer();

    await click("Save logs to file");

    expect(errorSpy).toHaveBeenCalledWith("Could not save logs", { description: "disk full" });
  });

  it("confirms a successful save and stays quiet on a cancelled dialog", async () => {
    const successSpy = vi.spyOn(toast, "success");
    const errorSpy = vi.spyOn(toast, "error");
    vi.mocked(save).mockResolvedValueOnce(null).mockResolvedValueOnce("/tmp/logs.txt");
    vi.mocked(writeTextFile).mockResolvedValue(undefined);
    await renderViewer();

    await click("Save logs to file");
    expect(successSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    await click("Save logs to file");
    expect(successSpy).toHaveBeenCalledWith("Logs saved", { description: "/tmp/logs.txt" });
  });

  it("logs a warning when the buffered backend logs cannot be loaded", async () => {
    vi.mocked(getLogs).mockRejectedValue(new Error("ipc down"));
    await renderViewer();

    expect(frontendWarn).toHaveBeenCalledWith("log_viewer", expect.stringContaining("ipc down"));
  });
});
