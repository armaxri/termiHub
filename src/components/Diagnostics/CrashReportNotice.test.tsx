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

  it("export opens the diagnostics export dialog", async () => {
    await render();
    await click("crash-report-notice-export");
    expect(useDiagnosticsDialogStore.getState().exportOpen).toBe(true);
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
