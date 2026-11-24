import { describe, it, expect } from "vitest";
import type { TerminalTab } from "@/types/terminal";
import { countAgentSessionTabs } from "./agentSessionTabs";

function tab(id: string, config: Record<string, unknown>, contentType = "terminal"): TerminalTab {
  return {
    id,
    sessionId: null,
    title: id,
    connectionType: "remote-session",
    contentType,
    config: { type: "remote-session", config },
    panelId: "p",
    isActive: false,
  } as unknown as TerminalTab;
}

describe("countAgentSessionTabs", () => {
  it("counts the terminal tabs on the given agent only", () => {
    const tabs = [
      tab("a", { agentId: "agent-1", sessionType: "shell" }),
      tab("b", { agentId: "agent-1", sessionType: "ssh" }),
      tab("c", { agentId: "agent-2" }),
      tab("d", {}),
    ];
    expect(countAgentSessionTabs(tabs, "agent-1")).toBe(2);
    expect(countAgentSessionTabs(tabs, "agent-2")).toBe(1);
    expect(countAgentSessionTabs(tabs, "agent-3")).toBe(0);
  });

  it("ignores non-terminal tabs that carry the agent's config", () => {
    expect(
      countAgentSessionTabs([tab("f", { agentId: "agent-1" }, "file-browser")], "agent-1")
    ).toBe(0);
  });
});
