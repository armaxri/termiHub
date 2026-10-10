/**
 * #4536 — the Log Viewer shows frontend and backend rows in one timestamp format
 * and merges the backend backlog with the frontend history chronologically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { LogEntry } from "@/types/terminal";

vi.mock("@/services/api", () => ({
  getLogs: vi.fn(),
  clearLogs: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/events", () => ({
  onLogEntry: vi.fn(() => Promise.resolve(() => {})),
}));

import { getLogs } from "@/services/api";
import { clearFrontendLogHistory, frontendInfo } from "@/utils/frontendLog";
import { formatLogTime } from "@/utils/formatters";
import { LogViewer } from "./LogViewer";

const T0 = Date.UTC(2026, 9, 10, 8, 0, 0, 0);

function backend(message: string, ms: number): LogEntry {
  return {
    timestamp: new Date(ms).toISOString(),
    timestampMs: ms,
    level: "INFO",
    target: "termihub::probe",
    message,
  };
}

/** Log a frontend entry stamped at `ms`. */
function frontendAt(message: string, ms: number): void {
  const spy = vi.spyOn(Date, "now").mockReturnValue(ms);
  try {
    frontendInfo("probe", message);
  } finally {
    spy.mockRestore();
  }
}

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function rowMessages(): string[] {
  return Array.from(container.querySelectorAll(".log-viewer__message")).map(
    (el) => el.textContent ?? ""
  );
}

function rowTimestamps(): string[] {
  return Array.from(container.querySelectorAll(".log-viewer__timestamp")).map(
    (el) => el.textContent ?? ""
  );
}

describe("LogViewer timestamps and ordering (#4536)", () => {
  beforeEach(() => {
    clearFrontendLogHistory();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(getLogs).mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    clearFrontendLogHistory();
  });

  it("merges the backend backlog with the frontend history by time on mount", async () => {
    frontendAt("front-1", T0 + 100);
    frontendAt("front-2", T0 + 300);
    vi.mocked(getLogs).mockResolvedValue([backend("back-1", T0 + 50), backend("back-2", T0 + 200)]);

    await act(async () => root.render(<LogViewer isVisible={true} />));
    await flush();

    expect(rowMessages()).toEqual(["back-1", "front-1", "back-2", "front-2"]);
  });

  it("formats frontend and backend rows identically", async () => {
    frontendAt("front", T0 + 123);
    vi.mocked(getLogs).mockResolvedValue([backend("back", T0 + 123)]);

    await act(async () => root.render(<LogViewer isVisible={true} />));
    await flush();

    const [first, second] = rowTimestamps();
    expect(first).toBe(formatLogTime(T0 + 123));
    expect(second).toBe(first);
  });
});
