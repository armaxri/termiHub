import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { Automation } from "@/types/generated/Automation";
import type { LocalProcessSwitches } from "@/utils/localProcessGate";

let switches: LocalProcessSwitches = { experimental: true, localPrograms: true };
vi.mock("@/hooks/useExperimentalFeatures", () => ({
  useLocalProcessSwitches: () => switches,
}));
vi.mock("@/store/useProjectedConnections", () => ({
  useProjectedConnections: () => ({ connections: [] }),
}));
vi.mock("@/store/broadcastGroups", () => ({ useBroadcastGroups: () => [] }));

import { useAppStore } from "@/store/appStore";
import { useScheduleLabels } from "./useScheduleLabels";

const build: Automation = {
  id: "build",
  name: "Build",
  tags: [],
  steps: [{ kind: "run-local-process", program: "make", args: [] }],
  triggers: [],
  createdAt: "",
  updatedAt: "",
};
const schedule = {
  action: { kind: "automation" as const, automationId: "build" },
  targets: { kind: "connections" as const, connectionIds: [] },
};

let container: HTMLDivElement;
let root: Root;
let short: string | null = null;

function Probe() {
  short = useScheduleLabels().blockedShort(schedule as never);
  return null;
}

describe("useScheduleLabels — the short reason names the switch that is off (#6178)", () => {
  beforeEach(() => {
    useAppStore.setState({ automations: [build] });
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => act(() => root.unmount()));

  it.each([
    [{ experimental: false, localPrograms: true }, "it needs experimental features"],
    [{ experimental: true, localPrograms: false }, "local programs are off in Security"],
  ])("%o → %s", (next, expected) => {
    switches = next;
    act(() => root.render(<Probe />));
    expect(short).toBe(expected);
  });
});
