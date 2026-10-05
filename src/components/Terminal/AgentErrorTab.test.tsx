/**
 * Regression test for #4104: a failed reconnect rejects with a structured
 * `{ code, message }` IPC envelope; the tab must show its message, not the
 * "[object Object]" that `String(err)` produced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AgentErrorTab } from "./AgentErrorTab";

vi.mock("@/store/agentsBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/agentsBridge")>()),
  currentAgentsView: () => ({ remoteAgents: [] }),
}));

describe("AgentErrorTab — structured IPC error (#4104)", () => {
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
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("renders the envelope's message when reconnect fails", async () => {
    useAppStore.setState({
      connectRemoteAgent: vi.fn(() =>
        Promise.reject({ code: "agent_unreachable", message: "agent host refused the connection" })
      ),
    } as never);

    await act(async () => {
      root.render(
        <AgentErrorTab
          tabId="tab-1"
          isVisible
          meta={
            {
              agentId: "agent-1",
              agentName: "Build box",
              definitionName: "shell",
              error: "initial failure",
            } as never
          }
        />
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="agent-error-reconnect-btn"]')!
        .click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const error = container.querySelector(".agent-error-tab__reconnect-error");
    expect(error?.textContent).toBe("agent host refused the connection");
    expect(container.textContent).not.toContain("[object Object]");
  });
});
