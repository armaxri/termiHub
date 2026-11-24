/**
 * The terminal slot shows an agent setup tab's finished strip in place of the
 * plain session-end strip (#5865): one strip per pane, never two stacked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TerminalSlot } from "./SplitView";
import { useAgentSetupStatus } from "@/store/agentSetupStatus";
import type { TerminalExitInfo } from "@/types/terminal";

vi.mock("@/components/Terminal/TerminalRegistry", () => ({
  useTerminalRegistry: () => ({
    getElement: () => null,
    onRegister: () => () => {},
    focusTerminal: vi.fn(),
    fitTerminal: vi.fn(),
    parkingRef: { current: null },
    clearTerminal: vi.fn(),
  }),
}));

let lifecycle: { reconnecting: boolean; exited: boolean; exitInfo?: TerminalExitInfo } = {
  reconnecting: false,
  exited: false,
};
vi.mock("@/store/useSessionLifecycle", () => ({
  useProjectedSessionLifecycle: () => lifecycle,
  useProjectedSessionLifecycleMaps: () => ({ terminalConnecting: {} }),
  useSessionAutoReconnect: () => undefined,
}));

vi.mock("@/components/Terminal/TerminalDisconnectOverlay", () => ({
  TerminalDisconnectOverlay: () => <div data-testid="stub-session-end-strip" />,
  sessionEndNoticeForTab: () => ({}),
}));
vi.mock("@/components/Terminal/AgentSetupTabStrip", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/Terminal/AgentSetupTabStrip")>()),
  AgentSetupTabStrip: ({ notice }: { notice: { kind: string } }) => (
    <div data-testid="stub-setup-strip" data-kind={notice.kind} />
  ),
}));

const TAB = "tab-setup";
let container: HTMLDivElement;
let root: Root;

function render(): void {
  act(() => root.render(<TerminalSlot tabId={TAB} isVisible />));
}
const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid='${id}']`);

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  useAgentSetupStatus.setState({ phases: {}, tabs: {} });
  useAgentSetupStatus
    .getState()
    .registerSetupTab(TAB, { agentId: "a", agentName: "box", reportsExit: true });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("TerminalSlot — agent setup tab (#5865)", () => {
  it("shows no strip while the setup runs", () => {
    lifecycle = { reconnecting: false, exited: false };
    render();
    expect(q("stub-setup-strip")).toBeNull();
    expect(q("stub-session-end-strip")).toBeNull();
  });

  it("an exit 0 shows the installed strip instead of the session-end strip", () => {
    lifecycle = { reconnecting: false, exited: true, exitInfo: { code: 0, reason: "clean" } };
    render();
    expect(q("stub-setup-strip")?.dataset.kind).toBe("installed");
    expect(q("stub-session-end-strip")).toBeNull();
  });

  it("a Windows exit 0 shows the check, then its outcome, never installed by itself (#5992)", () => {
    useAgentSetupStatus
      .getState()
      .registerSetupTab(TAB, { agentId: "a", agentName: "box", reportsExit: false });
    lifecycle = { reconnecting: false, exited: true, exitInfo: { code: 0, reason: "clean" } };
    render();
    expect(q("stub-setup-strip")?.dataset.kind).toBe("checking");
    expect(q("stub-session-end-strip")).toBeNull();
    act(() => useAgentSetupStatus.getState().applyProgress("a", "failed", "no agent"));
    expect(q("stub-setup-strip")?.dataset.kind).toBe("failed");
  });

  it("a failure before the script shows on the live shell", () => {
    lifecycle = { reconnecting: false, exited: false };
    useAgentSetupStatus.getState().applyProgress("a", "error", "SFTP connection failed");
    render();
    expect(q("stub-setup-strip")?.dataset.kind).toBe("failed");
  });

  it("once dismissed, the ended tab falls back to the plain session-end handling", () => {
    lifecycle = { reconnecting: false, exited: true, exitInfo: { code: 0, reason: "clean" } };
    useAgentSetupStatus.getState().dismissSetupTab(TAB);
    render();
    expect(q("stub-setup-strip")).toBeNull();
    expect(q("stub-session-end-strip")).not.toBeNull();
  });

  it("a plain tab is untouched", () => {
    useAgentSetupStatus.setState({ tabs: {} });
    lifecycle = { reconnecting: false, exited: true, exitInfo: { code: 0, reason: "clean" } };
    render();
    expect(q("stub-setup-strip")).toBeNull();
    expect(q("stub-session-end-strip")).not.toBeNull();
  });
});
