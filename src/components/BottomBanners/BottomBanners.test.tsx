import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import * as api from "@/services/api";
import * as events from "@/services/events";
import { CrashReportNotice, AgentCrashReportNotice } from "@/components/Diagnostics";
import { BottomBannerRegion, BOTTOM_BANNER_INSET_VAR } from "./BottomBannerRegion";
import { measureBottomBannerInset } from "./BottomBannerRegion";
import { activeBottomBanner, useBottomBannerStore } from "./bottomBannerStore";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    getCrashReportNotice: vi.fn(),
    acknowledgeCrashReports: vi.fn(),
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

let container: HTMLDivElement;
let root: Root;

async function renderAll() {
  await act(async () => {
    root.render(
      <BottomBannerRegion>
        <CrashReportNotice />
        <AgentCrashReportNotice />
      </BottomBannerRegion>
    );
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

/** Banners currently rendered inside the region, in DOM order. */
function visibleBanners(): string[] {
  const region = byTestId("bottom-banners");
  return Array.from(region?.children ?? []).map((el) => el.getAttribute("data-testid") ?? "");
}

setupSettingsRegion();

describe("bottom banner ranking (#5548, #5549)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useBottomBannerStore.setState({
      wanting: {},
      crashNoticeThisSession: false,
      crashChecked: { local: false, agent: false },
    });
    mockedApi.getCrashReportNotice.mockResolvedValue({
      name: "crash-1.txt",
      path: "/logs/crash-1.txt",
      total: 1,
    });
    mockedApi.acknowledgeCrashReports.mockResolvedValue(undefined);
    mockedApi.getAgentCrashNotices.mockResolvedValue([
      { agentId: "agent-a", name: "crash-a.txt", newCount: 1 },
    ]);
    mockedApi.acknowledgeAgentCrashNotice.mockResolvedValue(undefined);
    mockedEvents.onAgentCrashNoticesChanged.mockResolvedValue(vi.fn());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows only the crash notice while every banner wants to show", async () => {
    await renderAll();
    expect(visibleBanners()).toEqual(["crash-report-notice"]);
  });

  it("walks down the ranking as each banner is closed", async () => {
    await renderAll();
    await click("crash-report-notice-dismiss");
    expect(visibleBanners()).toEqual(["agent-crash-notice-agent-a"]);
    await click("agent-crash-notice-dismiss-agent-a");
    expect(visibleBanners()).toEqual([]);
  });

  it("records a crash notice for the session, even after it is closed (#5753)", async () => {
    await renderAll();
    const s = useBottomBannerStore.getState();
    expect(s.crashChecked).toEqual({ local: true, agent: true });
    expect(s.crashNoticeThisSession).toBe(true);
    await click("crash-report-notice-dismiss");
    await click("agent-crash-notice-dismiss-agent-a");
    expect(useBottomBannerStore.getState().crashNoticeThisSession).toBe(true);
  });

  it("reports both checks done and no crash when nothing crashed (#5753)", async () => {
    mockedApi.getCrashReportNotice.mockResolvedValue(null);
    mockedApi.getAgentCrashNotices.mockResolvedValue([]);
    await renderAll();
    expect(visibleBanners()).toEqual([]);
    const s = useBottomBannerStore.getState();
    expect(s.crashChecked).toEqual({ local: true, agent: true });
    expect(s.crashNoticeThisSession).toBe(false);
  });

  it("reports the checks done when a check fails (#5753)", async () => {
    mockedApi.getCrashReportNotice.mockRejectedValue(new Error("io"));
    mockedApi.getAgentCrashNotices.mockRejectedValue(new Error("io"));
    await renderAll();
    expect(useBottomBannerStore.getState().crashChecked).toEqual({ local: true, agent: true });
    expect(useBottomBannerStore.getState().crashNoticeThisSession).toBe(false);
  });

  it("reports the checks done without a crash when notices are turned off (#5753)", async () => {
    seedSettings({ showCrashReportNotice: false });
    await renderAll();
    expect(mockedApi.getCrashReportNotice).not.toHaveBeenCalled();
    expect(useBottomBannerStore.getState().crashChecked).toEqual({ local: true, agent: true });
    expect(useBottomBannerStore.getState().crashNoticeThisSession).toBe(false);
  });

  it("never renders a filled primary button in any banner", async () => {
    await renderAll();
    for (const id of ["crash-report-notice-dismiss", "agent-crash-notice-dismiss-agent-a"]) {
      expect(byTestId("bottom-banners")?.querySelector(".ui-btn--primary")).toBeNull();
      await click(id);
    }
  });
});

describe("activeBottomBanner", () => {
  it("returns null when no banner wants to show", () => {
    expect(activeBottomBanner({})).toBeNull();
  });

  it("ranks the local crash notice above the agent crash notices", () => {
    expect(activeBottomBanner({ "agent-crash-report": true, "crash-report": true })).toBe(
      "crash-report"
    );
  });
});

describe("bottom banner inset for the toast stack (#5556)", () => {
  function el(top: number, height: number): HTMLElement {
    const div = document.createElement("div");
    div.getBoundingClientRect = () => ({ top, height }) as DOMRect;
    return div;
  }

  it("is the distance from the banner's top edge to the window bottom", () => {
    // 800px window, 52px banner above a 24px status bar.
    expect(measureBottomBannerInset(el(724, 52), 800)).toBe(76);
  });

  it("is zero when no banner is showing", () => {
    expect(measureBottomBannerInset(el(776, 0), 800)).toBe(0);
  });

  it("publishes the inset on <html> and clears it on unmount", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<BottomBannerRegion>{null}</BottomBannerRegion>);
    });
    expect(document.documentElement.style.getPropertyValue(BOTTOM_BANNER_INSET_VAR)).toBe("0px");
    act(() => root.unmount());
    container.remove();
    expect(document.documentElement.style.getPropertyValue(BOTTOM_BANNER_INSET_VAR)).toBe("");
  });
});
