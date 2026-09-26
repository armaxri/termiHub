/**
 * History section of a network-tool panel (PROD-032): lists only this tool's
 * recorded runs, opens one read-only, re-runs, deletes, exports and clears.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { NetworkToolRun } from "@/types/network";

const api = vi.hoisted(() => ({
  listNetworkToolRuns: vi.fn(),
  recordNetworkToolRun: vi.fn(),
  deleteNetworkToolRun: vi.fn(() => Promise.resolve()),
  clearNetworkToolHistory: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/services/networkHistoryApi", () => api);

const settings = vi.hoisted(() => ({ view: {} as Record<string, unknown> }));
vi.mock("@/store/useProjectedSettings", () => ({ useProjectedSettings: () => settings.view }));
vi.mock("@/store/useProjectedAgents", () => ({
  useProjectedAgents: () => ({ remoteAgents: [{ id: "agent-1", name: "Edge box" }] }),
}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: vi.fn() }));

import { useNetworkToolHistoryStore } from "@/store/networkToolHistoryStore";
import { NetworkToolHistory } from "./NetworkToolHistory";

const pingRun: NetworkToolRun = {
  id: "ping-1",
  tool: "ping",
  params: { host: "example.com", intervalMs: 1000, count: 4 },
  runLocation: { kind: "agent", agentId: "agent-1" },
  startedAt: "2026-09-26T10:00:00Z",
  endedAt: "2026-09-26T10:00:04Z",
  status: "completed",
  summary: "4/4 received, 0.0% loss, avg 12ms",
  result: {
    columns: ["seq", "latency_ms"],
    rows: [
      [1, 11],
      [2, 13],
    ],
    totalRows: 10,
  },
};

const dnsRun: NetworkToolRun = { ...pingRun, id: "dns-1", tool: "dns-lookup", summary: "dns" };

let container: HTMLDivElement;
let root: Root;
const onRerun = vi.fn();

function q(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${testId}"]`);
}

function qa(testId: string): HTMLElement[] {
  return Array.from(document.body.querySelectorAll(`[data-testid="${testId}"]`));
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function renderExpanded() {
  await act(async () => {
    root.render(<NetworkToolHistory tool="ping" onRerun={onRerun} />);
  });
  await flush();
  await act(async () => q("network-history-toggle")!.click());
}

beforeEach(() => {
  vi.clearAllMocks();
  settings.view = {};
  api.listNetworkToolRuns.mockResolvedValue([pingRun, dnsRun]);
  useNetworkToolHistoryStore.setState({ runs: [], loaded: false });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("NetworkToolHistory", () => {
  it("loads the history and lists only this tool's runs once expanded", async () => {
    await act(async () => {
      root.render(<NetworkToolHistory tool="ping" onRerun={onRerun} />);
    });
    await flush();
    expect(api.listNetworkToolRuns).toHaveBeenCalledTimes(1);
    expect(q("network-history-toggle")!.textContent).toContain("History (1)");
    expect(qa("network-history-row")).toHaveLength(0);

    await act(async () => q("network-history-toggle")!.click());
    const rows = qa("network-history-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("4/4 received");
    expect(rows[0].textContent).toContain("Agent · Edge box");
  });

  it("opens a run read-only with params, summary, rows and the trimmed note", async () => {
    await renderExpanded();
    await act(async () => q("network-history-view")!.click());

    const dialog = q("network-run-detail")!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("example.com");
    expect(q("network-run-detail-status")!.textContent).toBe("Completed");
    expect(q("network-run-detail-summary")!.textContent).toContain("avg 12ms");
    expect(qa("network-run-detail-row-0")).toHaveLength(1);
    expect(dialog.textContent).toContain("first 2 of 10 rows");
    // Read-only: no editable inputs in the detail view.
    expect(dialog.querySelectorAll("input")).toHaveLength(0);
  });

  it("re-runs a past run with its params from the list and from the detail view", async () => {
    await renderExpanded();
    await act(async () => q("network-history-rerun")!.click());
    expect(onRerun).toHaveBeenCalledWith(pingRun);

    await act(async () => q("network-history-view")!.click());
    await act(async () => q("network-run-detail-rerun")!.click());
    expect(onRerun).toHaveBeenCalledTimes(2);
    expect(q("network-run-detail")).toBeNull();
  });

  it("deletes one run", async () => {
    await renderExpanded();
    await act(async () => q("network-history-delete")!.click());
    await flush();
    expect(api.deleteNetworkToolRun).toHaveBeenCalledWith("ping-1");
    expect(qa("network-history-row")).toHaveLength(0);
    expect(q("network-history-empty")).not.toBeNull();
  });

  it("clears this tool's history after confirmation", async () => {
    await renderExpanded();
    await act(async () => q("network-history-clear")!.click());
    await act(async () => q("network-history-clear-confirm")!.click());
    await flush();
    expect(api.clearNetworkToolHistory).toHaveBeenCalledWith("ping");
    expect(useNetworkToolHistoryStore.getState().runs.map((r) => r.id)).toEqual(["dns-1"]);
  });

  it("exports the tool's runs as JSON and a single run as CSV", async () => {
    vi.mocked(save).mockResolvedValue("/tmp/out");
    await renderExpanded();

    await act(async () => q("network-history-export")!.click());
    await flush();
    const json = vi.mocked(writeTextFile).mock.calls[0][1] as string;
    expect(JSON.parse(json)).toEqual([pingRun]);

    await act(async () => q("network-history-view")!.click());
    await act(async () => q("network-run-detail-export-csv")!.click());
    await flush();
    expect(vi.mocked(writeTextFile).mock.calls[1][1]).toBe("seq,latency_ms\n1,11\n2,13\n");
  });

  it("says when recording is turned off", async () => {
    settings.view = { networkToolHistoryEnabled: false };
    await renderExpanded();
    expect(q("network-history-disabled")).not.toBeNull();
  });
});
