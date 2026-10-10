/**
 * Screen-reader announcement and focus handling of the agent error tab (#4514,
 * follow-up to #4331): the failure is announced assertively exactly once with
 * its reason, the body is described by the detail rows, Reconnect takes focus
 * only in the visible tab, a failed manual reconnect is announced, and the tab
 * passes axe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { checkA11y } from "@/test/axe";
import { AgentErrorTab } from "./AgentErrorTab";
import type { AgentErrorMeta } from "@/types/terminal";

vi.mock("@/store/agentsBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/agentsBridge")>()),
  currentAgentsView: () => ({ remoteAgents: [] }),
}));

const META = {
  agentId: "agent-1",
  agentName: "Build box",
  definitionName: "shell",
  error: "connection refused",
} as AgentErrorMeta;

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

async function render(isVisible: boolean): Promise<void> {
  await act(async () => {
    root.render(<AgentErrorTab tabId="tab-1" isVisible={isVisible} meta={META} />);
  });
}

function announcers(): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[role='status'], [role='alert'], [aria-live]")
  );
}

function reconnectButton(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-testid="agent-error-reconnect-btn"]')!;
}

describe("AgentErrorTab announcement (#4514)", () => {
  it("announces the failure assertively with its reason, exactly once", async () => {
    await render(true);
    const regions = announcers();
    expect(regions).toHaveLength(1);
    expect(regions[0].getAttribute("role")).toBe("alert");
    expect(regions[0].textContent).toBe(
      "Agent connection unavailable. Build box, shell: connection refused"
    );
  });

  it("is described by its detail rows", async () => {
    await render(true);
    const body = container.querySelector(".ui-content-overlay") as HTMLElement;
    const description = (body.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(description).toContain("connection refused");
  });

  it("focuses Reconnect only when the tab is visible", async () => {
    await render(true);
    expect(document.activeElement).toBe(reconnectButton());
    act(() => root.unmount());
    root = createRoot(container);
    (document.activeElement as HTMLElement | null)?.blur();
    await render(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("announces a failed manual reconnect", async () => {
    useAppStore.setState({
      connectRemoteAgent: vi.fn(() => Promise.reject(new Error("host unreachable"))),
    } as never);
    await render(true);
    await act(async () => {
      reconnectButton().click();
    });
    const regions = announcers();
    expect(regions).toHaveLength(1);
    expect(regions[0].getAttribute("role")).toBe("alert");
    expect(regions[0].textContent).toBe("Reconnect failed. host unreachable");
  });

  it("has no axe violations", async () => {
    await render(true);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
