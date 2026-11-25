import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { AccessLogEntry, ServerActivity } from "@/types/embeddedServer";

const getActivity = vi.fn();
const clearActivity = vi.fn();
const toastSuccess = vi.fn();
const writeText = vi.fn(() => Promise.resolve());

vi.mock("@/services/embeddedServerApi", () => ({
  getEmbeddedServerActivity: (...args: unknown[]) => getActivity(...args),
  clearEmbeddedServerActivity: (...args: unknown[]) => clearActivity(...args),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (...args: unknown[]) => writeText(...(args as [])),
}));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: {
      error: vi.fn(),
      success: (...args: unknown[]) => toastSuccess(...args),
      info: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
    },
  };
});

import {
  EmbeddedServerActivityPanel,
  entryMatches,
  entryToTsv,
  type ActivityHostAgent,
} from "./EmbeddedServerActivityPanel";
import { TooltipProvider } from "@/components/ui";

let container: HTMLDivElement;
let root: Root;

const entries: AccessLogEntry[] = [
  {
    seq: 1,
    timestamp: "2026-09-26T10:00:00.000Z",
    client: "10.0.0.5",
    method: "RRQ",
    path: "firmware.bin",
    status: "ok",
    success: true,
    bytes: 2048,
    durationMs: 12,
  },
  {
    seq: 2,
    timestamp: "2026-09-26T10:00:01.000Z",
    client: "10.0.0.6",
    user: "alice",
    method: "LOGIN",
    status: "denied",
    success: false,
    bytes: 0,
    detail: "bad username or password",
  },
];

function activity(overrides: Partial<ServerActivity> = {}): ServerActivity {
  return {
    entries,
    latestSeq: 2,
    epoch: 0,
    dropped: 3,
    capacity: 1000,
    stats: {
      activeConnections: 1,
      totalConnections: 4,
      bytesSent: 2048,
      bytesReceived: 0,
      totalRequests: 5,
      errors: 1,
      topPaths: [{ key: "firmware.bin", count: 4 }],
      topClients: [{ key: "10.0.0.5", count: 4 }],
      currentTransfers: [
        {
          id: 1,
          method: "WRQ",
          client: "10.0.0.7",
          path: "up.bin",
          bytes: 512,
          startedAt: "2026-09-26T10:00:02.000Z",
        },
      ],
    },
    ...overrides,
  };
}

const onClose = vi.fn();

async function renderPanel(live = false, hostAgent?: ActivityHostAgent) {
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <EmbeddedServerActivityPanel
          serverId="srv-1"
          live={live}
          hostAgent={hostAgent}
          onClose={onClose}
        />
      </TooltipProvider>
    );
  });
}

function q(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

describe("EmbeddedServerActivityPanel", () => {
  beforeEach(() => {
    getActivity.mockReset();
    clearActivity.mockReset();
    toastSuccess.mockReset();
    writeText.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders detailed stats, transfers, top lists and the log newest-first", async () => {
    getActivity.mockResolvedValue(activity());
    await renderPanel();

    expect(getActivity).toHaveBeenCalledWith("srv-1", 0);
    expect(q("server-activity-stat-requests")?.textContent).toBe("5");
    expect(q("server-activity-stat-errors")?.textContent).toBe("1");
    expect(q("server-activity-stat-dropped")?.textContent).toBe("3");
    expect(q("server-activity-transfers-srv-1")?.textContent).toContain("up.bin");
    expect(container.textContent).toContain("Top paths");
    expect(container.textContent).toContain("Top clients");

    const rows = container.querySelectorAll("[data-testid^='server-activity-row-']");
    expect(rows).toHaveLength(2);
    // Newest first.
    expect(rows[0].getAttribute("data-testid")).toBe("server-activity-row-2");
    expect(rows[0].className).toContain("server-activity__row--error");
    expect(rows[1].textContent).toContain("firmware.bin");
    expect(rows[1].textContent).toContain("10.0.0.5");
  });

  it("filters the log", async () => {
    getActivity.mockResolvedValue(activity());
    await renderPanel();

    const input = q("server-activity-filter-srv-1") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "denied");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const rows = container.querySelectorAll("[data-testid^='server-activity-row-']");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("LOGIN");
  });

  it("clears the log through the backend and empties the view", async () => {
    getActivity.mockResolvedValueOnce(activity());
    getActivity.mockResolvedValue(activity({ entries: [], epoch: 1, dropped: 0 }));
    clearActivity.mockResolvedValue(undefined);
    await renderPanel();

    await act(async () => {
      q("server-activity-clear-srv-1")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
    });

    expect(clearActivity).toHaveBeenCalledWith("srv-1");
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(q("server-activity-empty-srv-1")?.textContent).toBe("No requests yet");
  });

  it("copies the visible log as TSV", async () => {
    getActivity.mockResolvedValue(activity());
    await renderPanel();
    await act(async () => {
      q("server-activity-copy-srv-1")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(text.split("\n")[0]).toContain("method");
    expect(text).toContain("firmware.bin");
  });

  it("has a heading and closes from it", async () => {
    getActivity.mockResolvedValue(activity());
    await renderPanel(true);
    expect(container.querySelector(".server-activity__title")?.textContent).toBe("Activity");
    act(() => q("server-activity-close-srv-1")!.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("says that nobody has connected yet to a running server", async () => {
    const none = { ...activity().stats, totalConnections: 0, totalRequests: 0 };
    getActivity.mockResolvedValue(activity({ entries: [], stats: none }));
    await renderPanel(true);
    expect(q("server-activity-empty-srv-1")?.textContent).toBe(
      "Nobody has connected yet.Requests and connected devices appear here."
    );
    expect(q("server-activity-filter-srv-1")).toBeNull();
  });

  it("does not say so once somebody has", async () => {
    const one = { ...activity().stats, totalConnections: 1, totalRequests: 0 };
    getActivity.mockResolvedValue(activity({ entries: [], stats: one }));
    await renderPanel(true);
    expect(container.textContent).not.toContain("Nobody has connected");
  });

  it("says that a running server's activity is not available, and reads it again", async () => {
    getActivity.mockResolvedValueOnce(null);
    getActivity.mockResolvedValue(activity());
    await renderPanel(true);
    expect(container.textContent).toContain("Activity is not available.");
    expect(container.textContent).not.toContain("appear here once the server runs");
    await act(async () => q("server-activity-retry-srv-1")!.click());
    expect(container.textContent).toContain("firmware.bin");
  });

  it("says why it cannot be read, and reads it again", async () => {
    getActivity.mockRejectedValueOnce(new Error("no answer"));
    getActivity.mockResolvedValue(activity());
    await renderPanel(true);
    expect(container.textContent).toContain("Activity is not available.no answer");
    await act(async () => q("server-activity-retry-srv-1")!.click());
    expect(container.textContent).toContain("firmware.bin");
  });

  it("has nothing to retry on a server that does not run", async () => {
    getActivity.mockResolvedValue(null);
    await renderPanel(false);
    expect(container.textContent).toContain("appear here once the server runs");
    expect(q("server-activity-retry-srv-1")).toBeNull();
  });

  it("says the agent is too old when it lacks the capability", async () => {
    getActivity.mockResolvedValue(null);
    await renderPanel(true, { name: "Lab Pi", supportsActivity: false });
    expect(container.textContent).toContain("Update agent Lab Pi");
    expect(q("server-activity-retry-srv-1")).toBeNull();
  });

  it("shows an agent-hosted server's log read from the agent", async () => {
    getActivity.mockResolvedValue(activity());
    await renderPanel(true, { name: "Lab Pi", supportsActivity: true });
    expect(container.textContent).toContain("firmware.bin");
    expect(container.textContent).not.toContain("not available");
  });

  it("polls incrementally from the last cursor while live", async () => {
    vi.useFakeTimers();
    try {
      getActivity.mockResolvedValue(activity());
      await renderPanel(true);
      await act(async () => {
        vi.advanceTimersByTime(1500);
      });
      expect(getActivity).toHaveBeenLastCalledWith("srv-1", 2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("entryMatches / entryToTsv", () => {
  it("matches any visible field case-insensitively", () => {
    expect(entryMatches(entries[1], "ALICE")).toBe(true);
    expect(entryMatches(entries[0], "firmware")).toBe(true);
    expect(entryMatches(entries[0], "nomatch")).toBe(false);
    expect(entryMatches(entries[0], "  ")).toBe(true);
  });

  it("matches diacritic-insensitively (#4582)", () => {
    const entry = { ...entries[1], user: "Müller" };
    expect(entryMatches(entry, "muller")).toBe(true);
    expect(entryMatches(entry, "MÜLL")).toBe(true);
    expect(entryMatches(entry, "meier")).toBe(false);
  });

  it("renders one tab-separated line per entry", () => {
    const line = entryToTsv(entries[0]);
    expect(line.split("\t")).toHaveLength(9);
    expect(line).toContain("RRQ\tfirmware.bin\tok\t2048\t12");
  });
});
