import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import * as api from "@/services/api";
import * as events from "@/services/events";
import type { AgentCrashNotice } from "@/types/diagnostics";
import { AgentCrashReportNotice } from "./AgentCrashReportNotice";
import { useDiagnosticsDialogStore } from "./diagnosticsDialogStore";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    getAgentCrashNotices: vi.fn(),
    acknowledgeAgentCrashNotice: vi.fn(),
    saveSettings: vi.fn(),
  };
});

vi.mock("@/services/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/events")>();
  return { ...actual, onAgentCrashNoticesChanged: vi.fn() };
});

vi.mock("@/store/useProjectedAgents", () => ({
  useProjectedAgents: () => ({ remoteAgents: [{ id: "agent-a", name: "Build Box" }] }),
}));

const mockedApi = vi.mocked(api);
const mockedEvents = vi.mocked(events);
const NOTICE: AgentCrashNotice = {
  agentId: "agent-a",
  name: "crash-20260926T120102Z-7.txt",
  newCount: 1,
};

let container: HTMLDivElement;
let root: Root;
let pushNotices: ((n: AgentCrashNotice[]) => void) | null;
const unlisten = vi.fn();

async function render() {
  await act(async () => {
    root.render(<AgentCrashReportNotice />);
  });
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

async function click(id: string) {
  await act(async () => {
    byTestId(id)?.click();
  });
}

setupSettingsRegion();

describe("AgentCrashReportNotice", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    pushNotices = null;
    useAppStore.setState(useAppStore.getInitialState());
    useDiagnosticsDialogStore.setState({
      exportOpen: false,
      viewedReport: null,
      viewedAgentReport: null,
    });
    mockedApi.getAgentCrashNotices.mockResolvedValue([NOTICE]);
    mockedApi.acknowledgeAgentCrashNotice.mockResolvedValue(undefined);
    mockedEvents.onAgentCrashNoticesChanged.mockImplementation(async (cb) => {
      pushNotices = cb;
      return unlisten;
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows one notice per agent with its display name", async () => {
    await render();
    const notice = byTestId("agent-crash-notice-agent-a");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("Build Box");
  });

  it("stays hidden when no agent crashed", async () => {
    mockedApi.getAgentCrashNotices.mockResolvedValue([]);
    await render();
    expect(byTestId("agent-crash-notice-agent-a")).toBeNull();
  });

  it("appears when a (re)connect check pushes a new notice", async () => {
    mockedApi.getAgentCrashNotices.mockResolvedValue([]);
    await render();
    await act(async () => pushNotices?.([{ ...NOTICE, newCount: 3 }]));
    expect(byTestId("agent-crash-notice-agent-a")?.textContent).toContain("3 new crash reports");
  });

  it("stays hidden and never checks when the user opted out", async () => {
    seedSettings({ showCrashReportNotice: false });
    await render();
    expect(byTestId("agent-crash-notice-agent-a")).toBeNull();
    expect(mockedApi.getAgentCrashNotices).not.toHaveBeenCalled();
    expect(mockedEvents.onAgentCrashNoticesChanged).not.toHaveBeenCalled();
  });

  it("stays hidden when the check fails", async () => {
    mockedApi.getAgentCrashNotices.mockRejectedValue(new Error("io"));
    await render();
    expect(byTestId("agent-crash-notice-agent-a")).toBeNull();
  });

  it("dismiss hides the notice and acknowledges exactly that report", async () => {
    await render();
    await click("agent-crash-notice-dismiss-agent-a");
    expect(byTestId("agent-crash-notice-agent-a")).toBeNull();
    expect(mockedApi.acknowledgeAgentCrashNotice).toHaveBeenCalledWith("agent-a", NOTICE.name);
  });

  it("view opens the viewer on the agent's report and acknowledges it", async () => {
    await render();
    await click("agent-crash-notice-view-agent-a");
    expect(useDiagnosticsDialogStore.getState().viewedAgentReport).toEqual({
      agentId: "agent-a",
      name: NOTICE.name,
    });
    expect(mockedApi.acknowledgeAgentCrashNotice).toHaveBeenCalledTimes(1);
  });

  it("export opens the diagnostics export dialog", async () => {
    await render();
    await click("agent-crash-notice-export-agent-a");
    expect(useDiagnosticsDialogStore.getState().exportOpen).toBe(true);
    expect(mockedApi.acknowledgeAgentCrashNotice).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes on unmount", async () => {
    await render();
    act(() => root.unmount());
    root = createRoot(container);
    expect(unlisten).toHaveBeenCalled();
  });
});
