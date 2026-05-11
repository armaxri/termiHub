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
            title: "Already Connected",
            message: "This agent is already connected.",
          })}
          onForceReconnect={vi.fn()}
        />
      );

      expect(document.querySelector('[data-testid="connection-error-title"]')?.textContent).toBe(
        "Already Connected"
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
});
