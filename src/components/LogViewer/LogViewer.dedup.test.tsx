/**
 * #4327 (OBS2-004) — one frontend WARN/ERROR must produce exactly one Log Viewer row.
 *
 * `frontendWarn`/`frontendError` deliver the entry to the viewer directly AND
 * forward it to the backend's durable log, which re-emits it under the
 * `frontend` target into the ring buffer and the live `log-entry` stream. The
 * viewer must show the direct copy only, whether the entry was logged before
 * the viewer mounted, while it is live, or before a remount. The frontendLog module
 * is shared across these tests, so each test logs a unique message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, Root } from "react-dom/client";
import type { LogEntry } from "@/types/terminal";

vi.mock("@/services/api", () => ({
  getLogs: vi.fn(),
  clearLogs: vi.fn(() => Promise.resolve()),
}));

let backendListener: ((entry: LogEntry) => void) | null = null;
vi.mock("@/services/events", () => ({
  onLogEntry: vi.fn((cb: (entry: LogEntry) => void) => {
    backendListener = cb;
    return Promise.resolve(() => {
      backendListener = null;
    });
  }),
}));

import { getLogs } from "@/services/api";
import { frontendError, frontendWarn } from "@/utils/frontendLog";
import { LogViewer } from "./LogViewer";

/**
 * The backend echo `record_frontend_log` produces for a forwarded entry. It is
 * tagged with the label of the window that forwarded it (#4535); the test
 * environment's current window is `main`.
 */
function backendEcho(
  target: string,
  message: string,
  level = "WARN",
  window: string | undefined = "main"
): LogEntry {
  return {
    timestamp: "12:00:00.000",
    level,
    target: "frontend",
    message: `[${target}] ${message}`,
    window,
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function rows(): string[] {
  return Array.from(container.querySelectorAll(".log-viewer__entry")).map(
    (el) => el.textContent ?? ""
  );
}

function rowsMatching(text: string): string[] {
  return rows().filter((r) => r.includes(text));
}

describe("LogViewer frontend entry de-duplication (#4327)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(getLogs).mockReset();
    backendListener = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows a warning logged while the viewer is live exactly once", async () => {
    vi.mocked(getLogs).mockResolvedValue([]);
    await act(async () => root.render(<LogViewer isVisible={true} />));
    await flush();

    act(() => {
      frontendWarn("probe", "disk almost full");
      // The forwarded copy comes back through the live backend stream.
      backendListener?.(backendEcho("probe", "disk almost full"));
    });

    expect(rowsMatching("disk almost full")).toHaveLength(1);
    expect(rowsMatching("disk almost full")[0]).toContain("frontend::probe");
  });

  it("shows a warning logged before the viewer mounted exactly once", async () => {
    frontendError("probe", "startup failure");
    // The ring buffer already holds the forwarded copy when the viewer mounts.
    vi.mocked(getLogs).mockResolvedValue([backendEcho("probe", "startup failure", "ERROR")]);

    await act(async () => root.render(<LogViewer isVisible={true} />));
    await flush();

    expect(rowsMatching("startup failure")).toHaveLength(1);
  });

  it("shows each entry once under StrictMode's double effect run", async () => {
    vi.mocked(getLogs).mockResolvedValue([backendEcho("probe", "strict warn")]);
    frontendWarn("probe", "strict warn");

    await act(async () =>
      root.render(
        <StrictMode>
          <LogViewer isVisible={true} />
        </StrictMode>
      )
    );
    await flush();

    expect(rowsMatching("strict warn")).toHaveLength(1);
  });

  it("keeps an entry logged during an earlier mount after the viewer remounts", async () => {
    vi.mocked(getLogs).mockResolvedValue([]);
    await act(async () => root.render(<LogViewer isVisible={true} />));
    await flush();
    act(() => frontendWarn("probe", "seen before close"));

    act(() => root.unmount());
    root = createRoot(container);
    vi.mocked(getLogs).mockResolvedValue([backendEcho("probe", "seen before close")]);
    await act(async () => root.render(<LogViewer isVisible={true} />));
    await flush();

    expect(rowsMatching("seen before close")).toHaveLength(1);
  });

  it("does not bring cleared frontend entries back on remount", async () => {
    vi.mocked(getLogs).mockResolvedValue([]);
    frontendWarn("probe", "cleared warning");
    await act(async () => root.render(<LogViewer isVisible={true} />));
    await flush();
    expect(rowsMatching("cleared warning")).toHaveLength(1);

    const clear = container.querySelector<HTMLButtonElement>('button[title="Clear logs"]');
    await act(async () => clear?.click());
    await flush();
    expect(rowsMatching("cleared warning")).toHaveLength(0);

    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<LogViewer isVisible={true} />));
    await flush();

    expect(rowsMatching("cleared warning")).toHaveLength(0);
  });

  it("still shows ordinary backend entries", async () => {
    vi.mocked(getLogs).mockResolvedValue([
      { timestamp: "12:00:00.000", level: "INFO", target: "termihub::ssh", message: "connected" },
    ]);
    await act(async () => root.render(<LogViewer isVisible={true} />));
    await flush();
    act(() => {
      backendListener?.({
        timestamp: "12:00:01.000",
        level: "WARN",
        target: "termihub::frontend_bridge",
        message: "live backend warning",
      });
    });

    expect(rowsMatching("connected")).toHaveLength(1);
    expect(rowsMatching("live backend warning")).toHaveLength(1);
  });

  it("shows a warning forwarded from another window exactly once (#4535)", async () => {
    vi.mocked(getLogs).mockResolvedValue([
      backendEcho("probe", "other window backlog", "ERROR", "win-2"),
    ]);
    await act(async () => root.render(<LogViewer isVisible={true} />));
    await flush();
    act(() => {
      backendListener?.(backendEcho("probe", "other window live", "WARN", "win-2"));
    });

    expect(rowsMatching("other window backlog")).toHaveLength(1);
    expect(rowsMatching("other window live")).toHaveLength(1);
    // The row says which window raised it.
    expect(rowsMatching("other window live")[0]).toContain("win-2");
  });

  it("shows this window's own forwarded warning once, not twice (#4535)", async () => {
    vi.mocked(getLogs).mockResolvedValue([]);
    await act(async () => root.render(<LogViewer isVisible={true} />));
    await flush();

    act(() => {
      frontendWarn("probe", "own window warn");
      backendListener?.(backendEcho("probe", "own window warn", "WARN", "main"));
    });

    expect(rowsMatching("own window warn")).toHaveLength(1);
    expect(rowsMatching("own window warn")[0]).toContain("frontend::probe");
  });

  it("drops an unattributed echo rather than risk a duplicate", async () => {
    vi.mocked(getLogs).mockResolvedValue([]);
    await act(async () => root.render(<LogViewer isVisible={true} />));
    await flush();

    act(() => {
      frontendWarn("probe", "unattributed warn");
      backendListener?.(backendEcho("probe", "unattributed warn", "WARN", undefined));
    });

    expect(rowsMatching("unattributed warn")).toHaveLength(1);
  });

  it("shows another window's echo once under StrictMode (#4535)", async () => {
    vi.mocked(getLogs).mockResolvedValue([
      backendEcho("probe", "strict other window", "WARN", "win-3"),
    ]);
    await act(async () =>
      root.render(
        <StrictMode>
          <LogViewer isVisible={true} />
        </StrictMode>
      )
    );
    await flush();

    expect(rowsMatching("strict other window")).toHaveLength(1);
  });
});
