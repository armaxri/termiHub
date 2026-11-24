import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ConnectionErrorDialog } from "./ConnectionErrorDialog";
import type { ClassifiedAgentError } from "@/utils/classifyAgentError";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

function makeError(
  category: ClassifiedAgentError["category"],
  overrides: Partial<ClassifiedAgentError> = {}
): ClassifiedAgentError {
  return {
    category,
    title: "Test Title",
    message: "Test message",
    rawError: "raw error",
    ...overrides,
  };
}

describe("ConnectionErrorDialog", () => {
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

  describe("Force Reconnect button", () => {
    it("shows Force Reconnect button for already-connected category", () => {
      render(
        <ConnectionErrorDialog
          open={true}
          onOpenChange={vi.fn()}
          error={makeError("already-connected")}
          onForceReconnect={vi.fn()}
        />
      );

      expect(
        document.querySelector('[data-testid="connection-error-force-reconnect"]')
      ).not.toBeNull();
    });

    it("does not show Force Reconnect for unknown category", () => {
      render(
        <ConnectionErrorDialog
          open={true}
          onOpenChange={vi.fn()}
          error={makeError("unknown")}
          onForceReconnect={vi.fn()}
        />
      );

      expect(document.querySelector('[data-testid="connection-error-force-reconnect"]')).toBeNull();
    });

    it("does not show Force Reconnect for agent-missing category", () => {
      render(
        <ConnectionErrorDialog
          open={true}
          onOpenChange={vi.fn()}
          error={makeError("agent-missing")}
          onForceReconnect={vi.fn()}
        />
      );

      expect(document.querySelector('[data-testid="connection-error-force-reconnect"]')).toBeNull();
    });

    it("does not show Force Reconnect when onForceReconnect is not provided", () => {
      render(
        <ConnectionErrorDialog
          open={true}
          onOpenChange={vi.fn()}
          error={makeError("already-connected")}
        />
      );

      expect(document.querySelector('[data-testid="connection-error-force-reconnect"]')).toBeNull();
    });

    it("calls onForceReconnect when button is clicked", () => {
      const onForceReconnect = vi.fn();
      render(
        <ConnectionErrorDialog
          open={true}
          onOpenChange={vi.fn()}
          error={makeError("already-connected")}
          onForceReconnect={onForceReconnect}
        />
      );

      act(() => {
        (
          document.querySelector('[data-testid="connection-error-force-reconnect"]') as HTMLElement
        ).click();
      });

      expect(onForceReconnect).toHaveBeenCalledOnce();
    });

    it("closes dialog when Force Reconnect is clicked", () => {
      const onOpenChange = vi.fn();
      render(
        <ConnectionErrorDialog
          open={true}
          onOpenChange={onOpenChange}
          error={makeError("already-connected")}
          onForceReconnect={vi.fn()}
        />
      );

      act(() => {
        (
          document.querySelector('[data-testid="connection-error-force-reconnect"]') as HTMLElement
        ).click();
      });

      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("does not call onForceReconnect when Close is clicked", () => {
      const onForceReconnect = vi.fn();
      render(
        <ConnectionErrorDialog
          open={true}
          onOpenChange={vi.fn()}
          error={makeError("already-connected")}
          onForceReconnect={onForceReconnect}
        />
      );

      act(() => {
        (document.querySelector('[data-testid="connection-error-close"]') as HTMLElement).click();
      });

      expect(onForceReconnect).not.toHaveBeenCalled();
    });
  });

  describe("error content", () => {
    it("displays the error title and message", () => {
      render(
        <ConnectionErrorDialog
          open={true}
          onOpenChange={vi.fn()}
          error={makeError("already-connected", {
            title: "Already connected",
            message: "This agent is already connected.",
          })}
          onForceReconnect={vi.fn()}
        />
      );

      expect(document.querySelector('[data-testid="connection-error-title"]')?.textContent).toBe(
        "Already connected"
      );
      expect(document.querySelector('[data-testid="connection-error-message"]')?.textContent).toBe(
        "This agent is already connected."
      );
    });

    it("does not render when error is null", () => {
      render(<ConnectionErrorDialog open={true} onOpenChange={vi.fn()} error={null} />);

      expect(document.querySelector('[data-testid="connection-error-title"]')).toBeNull();
    });
  });

  describe("Setup Agent button (existing behavior)", () => {
    it("shows Setup Agent button for agent-missing when onSetupAgent provided", () => {
      render(
        <ConnectionErrorDialog
          open={true}
          onOpenChange={vi.fn()}
          error={makeError("agent-missing")}
          onSetupAgent={vi.fn()}
        />
      );

      expect(document.querySelector('[data-testid="connection-error-setup-agent"]')).not.toBeNull();
    });

    it("shows Setup Agent button for agent-outdated when onSetupAgent provided", () => {
      render(
        <ConnectionErrorDialog
          open={true}
          onOpenChange={vi.fn()}
          error={makeError("agent-outdated")}
          onSetupAgent={vi.fn()}
        />
      );

      expect(document.querySelector('[data-testid="connection-error-setup-agent"]')).not.toBeNull();
    });

    it("does not show Force Reconnect alongside Setup Agent for agent-missing", () => {
      render(
        <ConnectionErrorDialog
          open={true}
          onOpenChange={vi.fn()}
          error={makeError("agent-missing")}
          onSetupAgent={vi.fn()}
          onForceReconnect={vi.fn()}
        />
      );

      expect(document.querySelector('[data-testid="connection-error-setup-agent"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="connection-error-force-reconnect"]')).toBeNull();
    });
  });

  // R-094 / R-095 (#5851): a host without the agent is a next step, not an error.
  describe("agent not installed", () => {
    const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

    async function renderMissing(host?: string) {
      render(
        <ConnectionErrorDialog
          open={true}
          onOpenChange={vi.fn()}
          error={makeError("agent-missing", { title: "Agent not installed" })}
          onSetupAgent={vi.fn()}
          host={host}
        />
      );
      // The modal moves focus once its focus scope mounts.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }

    it("names the host in the title and the message", async () => {
      await renderMissing("build-01");
      expect(q("connection-error-title")?.textContent).toBe("Agent not installed on build-01");
      expect(q("connection-error-message")?.textContent).toContain("SSH reached build-01");
    });

    it("shows a neutral info icon, not the warning triangle", async () => {
      await renderMissing("build-01");
      const icon = q("connection-error-icon");
      expect(icon?.getAttribute("data-icon")).toBe("info");
      expect(icon?.getAttribute("class")).toContain("connection-error-dialog__icon--info");
    });

    it("starts focused on Set up agent", async () => {
      await renderMissing("build-01");
      expect(document.activeElement).toBe(q("connection-error-setup-agent"));
    });

    it("keeps the warning triangle for a real failure", async () => {
      render(
        <ConnectionErrorDialog
          open={true}
          onOpenChange={vi.fn()}
          error={makeError("unreachable")}
          host="build-01"
        />
      );
      expect(q("connection-error-icon")?.getAttribute("data-icon")).toBe("alert");
      expect(q("connection-error-title")?.textContent).toBe("Test Title");
    });
  });
});
