import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { LogViewer } from "./LogViewer";

vi.mock("@/services/api", () => ({
  getLogs: vi.fn(),
  clearLogs: vi.fn(),
}));

vi.mock("@/services/events", () => ({
  onLogEntry: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({
  onFrontendLog: vi.fn(() => () => {}),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: vi.fn(),
}));

import { getLogs } from "@/services/api";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";

const mockedGetLogs = vi.mocked(getLogs);
const mockedSave = vi.mocked(save);
const mockedWrite = vi.mocked(writeTextFile);

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("LogViewer secret redaction on export", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    // A buffered log line that carries a secret a user must not leak.
    mockedGetLogs.mockResolvedValue([
      {
        timestamp: "2026-09-25T06:00:00Z",
        level: "INFO",
        target: "ssh",
        message: "authenticating with password=hunter2",
      },
    ]);
    // Clipboard for the copy-path assertion.
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("redacts secrets when saving logs to a file", async () => {
    mockedSave.mockResolvedValue("/tmp/termihub-logs.txt");
    mockedWrite.mockResolvedValue(undefined);

    await act(async () => {
      root.render(<LogViewer isVisible={true} />);
    });
    await flush();

    const saveButton = container.querySelector<HTMLButtonElement>(
      'button[title="Save logs to file"]'
    );
    expect(saveButton).not.toBeNull();

    await act(async () => {
      saveButton?.click();
    });
    await flush();

    expect(mockedWrite).toHaveBeenCalledTimes(1);
    const written = mockedWrite.mock.calls[0][1] as string;
    expect(written).toContain("***redacted***");
    expect(written).not.toContain("hunter2");
  });
});
