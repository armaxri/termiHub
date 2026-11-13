import {
  setupSettingsRegion,
  seedSettings,
  settingsHarnessTransport,
} from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import * as api from "@/services/api";
import { CrashReportNotice } from "./CrashReportNotice";
import { useDiagnosticsDialogStore } from "./diagnosticsDialogStore";

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
    saveSettings: vi.fn(),
  };
});

const mockedApi = vi.mocked(api);
const NOTICE = { name: "crash-20260926T120102Z-1.txt", path: "/logs/crash.txt", total: 1 };

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(<CrashReportNotice />);
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

describe("CrashReportNotice", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useDiagnosticsDialogStore.setState({ exportOpen: false, viewedReport: null });
    mockedApi.getCrashReportNotice.mockResolvedValue(NOTICE);
    mockedApi.acknowledgeCrashReports.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows the notice when a crash report is pending", async () => {
    await render();
    expect(byTestId("crash-report-notice")).not.toBeNull();
  });

  it("stays hidden when nothing crashed", async () => {
    mockedApi.getCrashReportNotice.mockResolvedValue(null);
    await render();
    expect(byTestId("crash-report-notice")).toBeNull();
  });

  it("stays hidden and does not even check when the user opted out", async () => {
    seedSettings({ showCrashReportNotice: false });
    await render();
    expect(byTestId("crash-report-notice")).toBeNull();
    expect(mockedApi.getCrashReportNotice).not.toHaveBeenCalled();
  });

  it("stays hidden when the check fails (never blocks startup)", async () => {
    mockedApi.getCrashReportNotice.mockRejectedValue(new Error("io"));
    await render();
    expect(byTestId("crash-report-notice")).toBeNull();
  });

  it("dismiss hides the notice and acknowledges the report", async () => {
    await render();
    await click("crash-report-notice-dismiss");
    expect(byTestId("crash-report-notice")).toBeNull();
    expect(mockedApi.acknowledgeCrashReports).toHaveBeenCalledTimes(1);
  });

  it("view opens the report viewer on the pending report", async () => {
    await render();
    await click("crash-report-notice-view");
    expect(useDiagnosticsDialogStore.getState().viewedReport).toBe(NOTICE.name);
    expect(mockedApi.acknowledgeCrashReports).toHaveBeenCalledTimes(1);
  });

  it("offers Don't show again, Close and View report in one action row (#5558, #5638)", async () => {
    await render();
    const actions = byTestId("crash-report-notice")?.querySelector(".bottom-banner__actions");
    const labels = Array.from(actions?.querySelectorAll("button") ?? []).map((b) =>
      b.textContent?.trim()
    );
    expect(labels).toEqual(["Don't show again", "Close", "View report"]);
    // Export moved into the report viewer, where the user sees what they export.
    expect(byTestId("crash-report-notice-export")).toBeNull();
  });

  it("uses no filled primary, so the view keeps a single primary (#5549)", async () => {
    await render();
    const notice = byTestId("crash-report-notice");
    expect(notice?.querySelector(".ui-btn--primary")).toBeNull();
    expect(byTestId("crash-report-notice-view")?.className).toContain("ui-btn--secondary");
  });

  it("renders Close and Don't show again as ghost Button primitives (#5638)", async () => {
    await render();
    for (const id of ["crash-report-notice-dismiss", "crash-report-notice-never"]) {
      const cls = byTestId(id)?.className ?? "";
      expect(cls).toContain("ui-btn");
      expect(cls).toContain("ui-btn--ghost");
      expect(cls).toContain("ui-btn--sm");
      expect(cls).toContain("bottom-banner__action");
    }
    // Same size as View report, so all three share one height and hit area.
    expect(byTestId("crash-report-notice-view")?.className).toContain("ui-btn--sm");
  });

  it("uses the warning banner surface (#5638)", async () => {
    await render();
    const notice = byTestId("crash-report-notice");
    expect(notice?.className).toContain("bottom-banner");
    expect(notice?.className).toContain("bottom-banner--warning");
  });

  it("don't show again persists showCrashReportNotice: false", async () => {
    await render();
    await click("crash-report-notice-never");
    expect(byTestId("crash-report-notice")).toBeNull();
    const intents = settingsHarnessTransport().dispatched;
    const persisted = JSON.stringify(intents.map((i) => i.payload));
    expect(persisted).toContain('"showCrashReportNotice":false');
  });
});
