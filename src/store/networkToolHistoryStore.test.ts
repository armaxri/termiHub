/**
 * Network-tool run-history UI store (PROD-032): recording honours the
 * `networkToolHistoryEnabled` setting and never throws, and delete/clear keep
 * the cached list in step with the backend.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NetworkToolRun } from "@/types/network";

const api = vi.hoisted(() => ({
  listNetworkToolRuns: vi.fn(),
  recordNetworkToolRun: vi.fn(),
  deleteNetworkToolRun: vi.fn(),
  clearNetworkToolHistory: vi.fn(),
}));
vi.mock("@/services/networkHistoryApi", () => api);

const settings = vi.hoisted(() => ({ view: {} as Record<string, unknown> }));
vi.mock("@/store/settingsBridge", () => ({ currentSettingsView: () => settings.view }));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

import { useNetworkToolHistoryStore } from "./networkToolHistoryStore";

function run(id: string, tool: NetworkToolRun["tool"] = "ping"): NetworkToolRun {
  return {
    id,
    tool,
    params: {},
    runLocation: { kind: "thisComputer" },
    startedAt: "2026-09-26T10:00:00Z",
    endedAt: "2026-09-26T10:00:01Z",
    status: "completed",
    summary: "",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  settings.view = {};
  useNetworkToolHistoryStore.setState({ runs: [], loaded: false });
});

describe("networkToolHistoryStore", () => {
  it("loads the backend list", async () => {
    api.listNetworkToolRuns.mockResolvedValue([run("a"), run("b")]);
    await useNetworkToolHistoryStore.getState().load();
    const state = useNetworkToolHistoryStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.runs.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("records a run and prepends the stored (backend-bounded) copy", async () => {
    useNetworkToolHistoryStore.setState({ runs: [run("old")] });
    api.recordNetworkToolRun.mockResolvedValue({ ...run("new"), summary: "trimmed" });
    await useNetworkToolHistoryStore.getState().record(run("new"));
    const runs = useNetworkToolHistoryStore.getState().runs;
    expect(runs.map((r) => r.id)).toEqual(["new", "old"]);
    expect(runs[0].summary).toBe("trimmed");
  });

  it("skips recording while history is disabled in settings", async () => {
    settings.view = { networkToolHistoryEnabled: false };
    await useNetworkToolHistoryStore.getState().record(run("x"));
    expect(api.recordNetworkToolRun).not.toHaveBeenCalled();
    expect(useNetworkToolHistoryStore.getState().runs).toEqual([]);
  });

  it("swallows a failed record (logged, never breaks the tool)", async () => {
    api.recordNetworkToolRun.mockRejectedValue(new Error("disk full"));
    await expect(useNetworkToolHistoryStore.getState().record(run("x"))).resolves.toBeUndefined();
    expect(useNetworkToolHistoryStore.getState().runs).toEqual([]);
  });

  it("removes one run and clears per tool or entirely", async () => {
    api.deleteNetworkToolRun.mockResolvedValue(undefined);
    api.clearNetworkToolHistory.mockResolvedValue(undefined);
    useNetworkToolHistoryStore.setState({
      runs: [run("p1"), run("d1", "dns-lookup"), run("p2")],
    });

    await useNetworkToolHistoryStore.getState().remove("p1");
    expect(api.deleteNetworkToolRun).toHaveBeenCalledWith("p1");
    expect(useNetworkToolHistoryStore.getState().runs.map((r) => r.id)).toEqual(["d1", "p2"]);

    await useNetworkToolHistoryStore.getState().clear("ping");
    expect(api.clearNetworkToolHistory).toHaveBeenCalledWith("ping");
    expect(useNetworkToolHistoryStore.getState().runs.map((r) => r.id)).toEqual(["d1"]);

    await useNetworkToolHistoryStore.getState().clear();
    expect(useNetworkToolHistoryStore.getState().runs).toEqual([]);
  });

  it("keeps the list when a delete fails", async () => {
    api.deleteNetworkToolRun.mockRejectedValue(new Error("nope"));
    useNetworkToolHistoryStore.setState({ runs: [run("p1")] });
    await expect(useNetworkToolHistoryStore.getState().remove("p1")).rejects.toThrow("nope");
    expect(useNetworkToolHistoryStore.getState().runs).toHaveLength(1);
  });
});
