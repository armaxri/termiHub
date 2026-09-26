import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import * as api from "@/services/api";
import { CrashReportViewer } from "./CrashReportViewer";
import { useDiagnosticsDialogStore } from "./diagnosticsDialogStore";

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return { ...actual, readCrashReport: vi.fn(), readAgentCrashReport: vi.fn() };
});

const mockedApi = vi.mocked(api);

let container: HTMLDivElement;
let root: Root;

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

describe("CrashReportViewer", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useDiagnosticsDialogStore.setState({
      exportOpen: false,
      viewedReport: null,
      viewedAgentReport: null,
    });
    mockedApi.readCrashReport.mockResolvedValue("termiHub crash report\nmessage: boom");
    mockedApi.readAgentCrashReport.mockResolvedValue("termihub-agent crash report\nmessage: oops");
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows the selected report's text", async () => {
    await act(async () => {
      root.render(<CrashReportViewer />);
    });
    await act(async () => {
      useDiagnosticsDialogStore.getState().setViewedReport("crash-1.txt");
    });
    expect(mockedApi.readCrashReport).toHaveBeenCalledWith("crash-1.txt");
    expect(byTestId("crash-report-viewer-text")?.textContent).toContain("message: boom");
  });

  it("hands off to the export dialog", async () => {
    await act(async () => {
      root.render(<CrashReportViewer />);
    });
    await act(async () => {
      useDiagnosticsDialogStore.getState().setViewedReport("crash-1.txt");
    });
    await act(async () => {
      byTestId("crash-report-viewer-export")?.click();
    });
    const state = useDiagnosticsDialogStore.getState();
    expect(state.viewedReport).toBeNull();
    expect(state.exportOpen).toBe(true);
  });

  it("reads a remote agent's report over the agent connection (#3593)", async () => {
    await act(async () => {
      root.render(<CrashReportViewer />);
    });
    await act(async () => {
      useDiagnosticsDialogStore
        .getState()
        .setViewedAgentReport({ agentId: "agent-a", name: "crash-2.txt" });
    });
    expect(mockedApi.readAgentCrashReport).toHaveBeenCalledWith("agent-a", "crash-2.txt");
    expect(mockedApi.readCrashReport).not.toHaveBeenCalled();
    expect(byTestId("crash-report-viewer-text")?.textContent).toContain("message: oops");
  });

  it("shows why an agent report could not be read", async () => {
    mockedApi.readAgentCrashReport.mockRejectedValue("agent is not connected");
    await act(async () => {
      root.render(<CrashReportViewer />);
    });
    await act(async () => {
      useDiagnosticsDialogStore
        .getState()
        .setViewedAgentReport({ agentId: "agent-a", name: "crash-2.txt" });
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "agent is not connected"
    );
  });
});
