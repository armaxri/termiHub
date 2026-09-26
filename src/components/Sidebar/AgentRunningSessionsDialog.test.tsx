import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import {
  AgentRunningSessionsDialog,
  RUNNING_SESSIONS_UNSUPPORTED_REASON,
} from "./AgentRunningSessionsDialog";
import type { AgentHostSessionInfo, AgentHostSessionsResult } from "@/services/api";
import * as api from "@/services/api";

vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return {
    ...actual,
    listAgentHostSessions: vi.fn(),
    takeOverAgentSession: vi.fn(),
  };
});
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

const mockedList = vi.mocked(api.listAgentHostSessions);
const mockedTakeOver = vi.mocked(api.takeOverAgentSession);

let container: HTMLDivElement;
let root: Root;

function session(
  id: string,
  holder: AgentHostSessionInfo["holder"],
  title = `Shell ${id}`
): AgentHostSessionInfo {
  return {
    sessionId: id,
    title,
    type: "local",
    status: "running",
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    lastActivity: new Date().toISOString(),
    holder,
    definitionId: null,
  };
}

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

async function renderDialog(result: AgentHostSessionsResult | Error) {
  if (result instanceof Error) mockedList.mockRejectedValue(result);
  else mockedList.mockResolvedValue(result);
  const onOpenChange = vi.fn();
  const onOpenSession = vi.fn();
  await act(async () => {
    root.render(
      <AgentRunningSessionsDialog
        open
        onOpenChange={onOpenChange}
        agentId="agent-1"
        agentName="build-box"
        onOpenSession={onOpenSession}
      />
    );
  });
  return { onOpenChange, onOpenSession };
}

async function click(el: HTMLElement | null) {
  expect(el).not.toBeNull();
  await act(async () => {
    el!.click();
  });
}

describe("AgentRunningSessionsDialog (#3369)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("lists running sessions with who holds each", async () => {
    await renderDialog({
      supported: true,
      sessions: [session("a", "none"), session("b", "other"), session("c", "self")],
    });

    expect(mockedList).toHaveBeenCalledWith("agent-1");
    expect(q("running-session-holder-a")?.textContent).toBe("Unattached");
    expect(q("running-session-holder-b")?.textContent).toBe("Held by another desktop");
    expect(q("running-session-holder-c")?.textContent).toBe("Open on this desktop");
    // Unattached / own sessions open directly; another desktop's needs a takeover.
    expect(q("running-session-open-a")).not.toBeNull();
    expect(q("running-session-takeover-a")).toBeNull();
    expect(q("running-session-takeover-b")).not.toBeNull();
    expect(q("running-session-open-b")).toBeNull();
  });

  it("opens an unattached session without a takeover", async () => {
    const { onOpenChange, onOpenSession } = await renderDialog({
      supported: true,
      sessions: [session("a", "none")],
    });

    await click(q("running-session-open-a"));

    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "a" }));
    expect(mockedTakeOver).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("takes over a session held by another desktop only after confirming", async () => {
    mockedTakeOver.mockResolvedValue(undefined);
    const { onOpenSession } = await renderDialog({
      supported: true,
      sessions: [session("b", "other")],
    });

    await click(q("running-session-takeover-b"));
    expect(q("running-session-takeover-confirm-dialog")).not.toBeNull();
    expect(mockedTakeOver).not.toHaveBeenCalled();

    await click(q("running-session-takeover-confirm-confirm"));

    expect(mockedTakeOver).toHaveBeenCalledWith("agent-1", "b");
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "b" }));
    // The takeover happens before the tab is opened.
    expect(mockedTakeOver.mock.invocationCallOrder[0]).toBeLessThan(
      onOpenSession.mock.invocationCallOrder[0]
    );
  });

  it("does not take over when the confirm is cancelled", async () => {
    const { onOpenSession } = await renderDialog({
      supported: true,
      sessions: [session("b", "other")],
    });

    await click(q("running-session-takeover-b"));
    await click(q("running-session-takeover-confirm-cancel"));

    expect(mockedTakeOver).not.toHaveBeenCalled();
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("does not open the session when the takeover fails", async () => {
    mockedTakeOver.mockRejectedValue(new Error("Session not found"));
    const { onOpenSession } = await renderDialog({
      supported: true,
      sessions: [session("b", "other")],
    });

    await click(q("running-session-takeover-b"));
    await click(q("running-session-takeover-confirm-confirm"));

    expect(mockedTakeOver).toHaveBeenCalled();
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("explains why the list is unavailable on an older agent", async () => {
    await renderDialog({ supported: false, sessions: [] });

    const el = q("running-sessions-unsupported");
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain(RUNNING_SESSIONS_UNSUPPORTED_REASON);
    expect(q("running-sessions-list")).toBeNull();
  });

  it("shows an empty state and a listing error", async () => {
    await renderDialog({ supported: true, sessions: [] });
    expect(q("running-sessions-empty")).not.toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    await renderDialog(new Error("Agent connection lost"));
    expect(q("running-sessions-error")?.textContent).toContain("Agent connection lost");
  });
});
