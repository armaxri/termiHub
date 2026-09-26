/**
 * Run-history helpers (PROD-032): record building (row cap, run location),
 * CSV/JSON export, and the record-on-finish / re-run hooks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, useState } from "react";
import { createRoot, Root } from "react-dom/client";
import type { DiagnosticStatus, NetworkToolRun } from "@/types/network";
import { useRunLocationStore } from "@/store/runLocationStore";

const record = vi.fn((run: NetworkToolRun) => {
  void run;
  return Promise.resolve();
});
vi.mock("@/store/networkToolHistoryStore", () => ({
  useNetworkToolHistoryStore: { getState: () => ({ record }) },
}));

import {
  MAX_HISTORY_ROWS,
  buildRunRecord,
  runToCsv,
  runsToJson,
  useRecordRunOnFinish,
  useRerunAfterUpdate,
  type RunSnapshot,
} from "./runHistory";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  record.mockClear();
  useRunLocationStore.setState({ networkToolLocations: {} });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("buildRunRecord", () => {
  it("stamps id/endedAt, keeps params, and caps rows while counting all of them", () => {
    const rows = Array.from({ length: MAX_HISTORY_ROWS + 5 }, (_, i) => [i]);
    const rec = buildRunRecord(
      {
        tool: "port-scanner",
        status: "completed",
        startedAt: "2026-09-26T10:00:00.000Z",
        params: { host: "10.0.0.1", ports: "22" },
        summary: "1 open",
        table: { columns: ["n"], rows },
      },
      new Date("2026-09-26T10:00:05.000Z")
    );
    expect(rec.id).toMatch(/[0-9a-f-]{36}/);
    expect(rec.endedAt).toBe("2026-09-26T10:00:05.000Z");
    expect(rec.params).toEqual({ host: "10.0.0.1", ports: "22" });
    expect(rec.result!.rows).toHaveLength(MAX_HISTORY_ROWS);
    expect(rec.result!.totalRows).toBe(MAX_HISTORY_ROWS + 5);
    expect(rec.runLocation).toEqual({ kind: "thisComputer" });
    expect(rec.error).toBeUndefined();
  });

  it("records the tool's current agent run location", () => {
    useRunLocationStore.getState().setNetworkToolLocation("ping", {
      kind: "agent",
      agentId: "agent-1",
    });
    const rec = buildRunRecord({
      tool: "ping",
      status: "error",
      startedAt: "t",
      params: {},
      summary: "",
      error: "boom",
    });
    expect(rec.runLocation).toEqual({ kind: "agent", agentId: "agent-1" });
    expect(rec.error).toBe("boom");
    expect(rec.result).toBeUndefined();
  });
});

describe("export helpers", () => {
  const run: NetworkToolRun = {
    id: "r1",
    tool: "dns-lookup",
    params: { hostname: "example.com" },
    runLocation: { kind: "thisComputer" },
    startedAt: "2026-09-26T10:00:00Z",
    endedAt: "2026-09-26T10:00:01Z",
    status: "completed",
    summary: "1 A record(s)",
    result: { columns: ["type", "value"], rows: [["A", "1.2.3.4"]], totalRows: 1 },
  };

  it("exports a run's table as CSV", () => {
    expect(runToCsv(run)).toBe("type,value\nA,1.2.3.4\n");
  });

  it("exports runs as JSON that round-trips", () => {
    expect(JSON.parse(runsToJson([run]))).toEqual([run]);
  });
});

interface HarnessProps {
  status: DiagnosticStatus;
  snapshot: () => RunSnapshot;
}

function RecorderHarness({ status, snapshot }: HarnessProps) {
  useRecordRunOnFinish("traceroute", status, snapshot);
  return null;
}

describe("useRecordRunOnFinish", () => {
  function render(status: DiagnosticStatus, host: string, summary = "") {
    act(() => {
      root.render(
        <RecorderHarness
          status={status}
          snapshot={() => ({ params: { host }, summary, table: { columns: [], rows: [] } })}
        />
      );
    });
  }

  it("records once when a run finishes, with the params captured at start", () => {
    render("idle", "a.example");
    render("running", "a.example");
    render("running", "edited-while-running.example");
    expect(record).not.toHaveBeenCalled();
    render("completed", "edited-while-running.example", "3 hops");

    expect(record).toHaveBeenCalledTimes(1);
    const rec = record.mock.calls[0][0];
    expect(rec.tool).toBe("traceroute");
    expect(rec.status).toBe("completed");
    expect(rec.params).toEqual({ host: "a.example" });
    expect(rec.summary).toBe("3 hops");

    // Re-rendering in a terminal state does not record again.
    render("completed", "a.example");
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("records canceled and errored runs with their status", () => {
    render("running", "h");
    render("canceled", "h");
    render("running", "h");
    render("error", "h");
    expect(record.mock.calls.map((c) => c[0].status)).toEqual(["canceled", "error"]);
  });

  it("records the agent location selected when the run started", () => {
    useRunLocationStore.getState().setNetworkToolLocation("traceroute", {
      kind: "agent",
      agentId: "edge-1",
    });
    render("running", "h");
    useRunLocationStore.setState({ networkToolLocations: {} });
    render("completed", "h");
    expect(record.mock.calls[0][0].runLocation).toEqual({ kind: "agent", agentId: "edge-1" });
  });

  it("does not record an idle → terminal change without a run", () => {
    render("idle", "h");
    render("completed", "h");
    expect(record).not.toHaveBeenCalled();
  });
});

describe("useRerunAfterUpdate", () => {
  it("starts on the render after the request, seeing the updated state", () => {
    const seen: string[] = [];
    let request: () => void = () => {};
    let setValue: (v: string) => void = () => {};

    function RerunHarness() {
      const [value, set] = useState("old");
      setValue = set;
      request = useRerunAfterUpdate(() => {
        seen.push(value);
      });
      return null;
    }

    act(() => root.render(<RerunHarness />));
    act(() => {
      setValue("new");
      request();
    });
    expect(seen).toEqual(["new"]);
  });
});
