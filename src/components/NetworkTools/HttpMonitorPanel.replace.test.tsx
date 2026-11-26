/**
 * "Save and start" on a monitor set up again replaces the broken one (F-009
 * round 2).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkHttpMonitorList } from "@/services/networkApi";
import type { HttpMonitorState } from "@/types/network";
import { withTooltip } from "@/test/tooltip";
import { HttpMonitorPanel } from "./HttpMonitorPanel";

const { start, remove } = vi.hoisted(() => ({
  start: vi.fn(() => Promise.resolve("new-1")),
  remove: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorStart: start,
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
  networkHttpMonitorRemove: remove,
  networkHttpMonitorPause: vi.fn(() => Promise.resolve()),
  networkHttpMonitorResume: vi.fn(() => Promise.resolve()),
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
  onHttpMonitorCheck: vi.fn(() => Promise.resolve(() => {})),
  onHttpMonitorChanged: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
vi.mock("./LatencyChart", () => ({ LatencyChart: () => null }));
vi.mock("@/components/RunLocationSelect", () => ({
  RunLocationSelect: (props: { onChange: (v: object) => void; "data-testid"?: string }) => (
    <button
      type="button"
      data-testid={props["data-testid"]}
      onClick={() => props.onChange({ kind: "thisComputer" })}
    />
  ),
}));

const ODD: HttpMonitorState = {
  config: {
    id: "odd",
    url: "https://status.cloud/",
    intervalMs: 45_000,
    method: "HEAD",
    expectedStatus: 204,
    timeoutMs: 7_000,
    name: "Cloud status",
    description: "The provider's page",
    host: { kind: "cloud" } as never,
  },
  running: false,
  paused: false,
  status: "error",
  reason: "Not started: termiHub cannot read where it runs.",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("save and start (F-009 round 2)", () => {
  it("starts the new one where chosen and removes the broken one", async () => {
    vi.mocked(networkHttpMonitorList).mockResolvedValue([ODD]);
    await act(async () => root.render(withTooltip(<HttpMonitorPanel />)));
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => q("monitor-step-setUpAgain-odd")!.click());
    await act(async () => q("http-monitor-run-location")!.click());
    await act(async () => q("http-monitor-start")!.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(start).toHaveBeenCalledWith(
      "https://status.cloud/",
      45_000,
      "HEAD",
      204,
      7_000,
      { kind: "thisComputer" },
      false,
      "Cloud status",
      "The provider's page"
    );
    expect(remove).toHaveBeenCalledWith("odd");
    expect(q("http-monitor-title")?.textContent).toBe("HTTP Monitor");
  });
});
