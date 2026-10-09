import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ContentOverlay } from "./ContentOverlay";
import { checkA11y } from "@/test/axe";

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
});

describe("ContentOverlay", () => {
  it("renders the icon, heading, subheading, children, and actions in order", () => {
    act(() => {
      root.render(
        <ContentOverlay
          icon={<span data-testid="the-icon" />}
          heading="Connecting…"
          subheading="my-server"
          actions={<button data-testid="the-action">Cancel</button>}
        >
          <div data-testid="the-extra">extra body</div>
        </ContentOverlay>
      );
    });

    const body = container.querySelector(".ui-content-overlay") as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.querySelector("[data-testid='the-icon']")).not.toBeNull();
    expect(body.querySelector(".ui-content-overlay__heading")?.textContent).toBe("Connecting…");
    expect(body.querySelector(".ui-content-overlay__subheading")?.textContent).toBe("my-server");
    expect(body.querySelector("[data-testid='the-extra']")).not.toBeNull();
    expect(body.querySelector("[data-testid='the-action']")).not.toBeNull();

    // Source order is preserved: icon, heading, subheading, children, actions.
    const testids = Array.from(body.querySelectorAll("[data-testid]")).map((el) =>
      el.getAttribute("data-testid")
    );
    expect(testids).toEqual(["the-icon", "the-extra", "the-action"]);
  });

  it("omits the subheading and actions slots when not provided", () => {
    act(() => {
      root.render(<ContentOverlay icon={<span />} heading="Session ended" />);
    });
    const body = container.querySelector(".ui-content-overlay") as HTMLElement;
    expect(body.querySelector(".ui-content-overlay__subheading")).toBeNull();
    expect(body.querySelector(".ui-content-overlay__actions")).toBeNull();
  });

  it("forwards data-testid and an extra className to the body wrapper", () => {
    act(() => {
      root.render(
        <ContentOverlay
          icon={<span />}
          heading="Failed"
          className="custom-body"
          data-testid="my-overlay-body"
        />
      );
    });
    const body = container.querySelector("[data-testid='my-overlay-body']") as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.className).toContain("ui-content-overlay");
    expect(body.className).toContain("custom-body");
  });

  it("has no accessibility violations", async () => {
    act(() => {
      root.render(
        <ContentOverlay
          icon={<span aria-hidden />}
          heading="Connection failed"
          subheading="my-server"
          actions={<button type="button">Retry</button>}
        />
      );
    });
    expect(await checkA11y()).toHaveNoViolations();
  });

  describe("announcement + focus (#4331)", () => {
    function liveRegion(): HTMLElement | null {
      return container.querySelector("[data-testid='content-overlay-live']");
    }

    it("renders no live region unless asked to announce", () => {
      act(() => root.render(<ContentOverlay icon={<span />} heading="Session ended" />));
      expect(liveRegion()).toBeNull();
    });

    it("announces assertive overlays in an alert region with heading and description", () => {
      act(() =>
        root.render(
          <ContentOverlay
            icon={<span />}
            heading="Connection failed"
            subheading="my-server"
            announce="assertive"
            announcement="Connection failed. Host unreachable"
          />
        )
      );
      expect(liveRegion()?.getAttribute("role")).toBe("alert");
      expect(liveRegion()?.textContent).toBe("Connection failed. Host unreachable");
    });

    it("defaults the announcement to the heading plus a string subheading", () => {
      act(() =>
        root.render(
          <ContentOverlay
            icon={<span />}
            heading="Session disconnected"
            subheading="The connection was lost."
            announce="polite"
          />
        )
      );
      expect(liveRegion()?.getAttribute("role")).toBe("status");
      expect(liveRegion()?.textContent).toBe("Session disconnected. The connection was lost.");
    });

    it("labels the body by its heading and describes it by the message", () => {
      act(() =>
        root.render(
          <ContentOverlay
            icon={<span />}
            heading="Reconnect failed"
            subheading="All attempts exhausted."
            describedBy="extra-message"
          >
            <span id="extra-message">timeout</span>
          </ContentOverlay>
        )
      );
      const body = container.querySelector(".ui-content-overlay") as HTMLElement;
      expect(body.getAttribute("role")).toBe("group");
      const labelId = body.getAttribute("aria-labelledby") ?? "";
      expect(document.getElementById(labelId)?.textContent).toBe("Reconnect failed");
      const describedIds = (body.getAttribute("aria-describedby") ?? "").split(" ");
      const description = describedIds
        .map((id) => document.getElementById(id)?.textContent)
        .join(" ");
      expect(description).toBe("All attempts exhausted. timeout");
    });

    function renderFocusable(autoFocus: boolean, heading = "Connection failed") {
      act(() =>
        root.render(
          <ContentOverlay
            icon={<span />}
            heading={heading}
            announce="assertive"
            autoFocusPrimaryAction={autoFocus}
            actions={
              <>
                <button type="button" data-testid="primary">
                  Retry
                </button>
                <button type="button" data-testid="secondary">
                  Cancel
                </button>
              </>
            }
          />
        )
      );
    }

    it("moves focus to the first action when autoFocusPrimaryAction is set", () => {
      renderFocusable(true);
      expect(document.activeElement).toBe(container.querySelector("[data-testid='primary']"));
    });

    it("leaves focus alone when autoFocusPrimaryAction is not set", () => {
      renderFocusable(false);
      expect(document.activeElement).toBe(document.body);
    });

    it("moves focus once the overlay becomes active", () => {
      renderFocusable(false);
      expect(document.activeElement).toBe(document.body);
      renderFocusable(true);
      expect(document.activeElement).toBe(container.querySelector("[data-testid='primary']"));
    });

    it("does not steal focus from a control outside the overlay's host", () => {
      const outside = document.createElement("input");
      document.body.appendChild(outside);
      outside.focus();
      try {
        renderFocusable(true);
        expect(document.activeElement).toBe(outside);
      } finally {
        outside.remove();
      }
    });

    it("does not re-focus on a re-render with the same content", () => {
      renderFocusable(true);
      const secondary = container.querySelector("[data-testid='secondary']") as HTMLElement;
      secondary.focus();
      renderFocusable(true);
      expect(document.activeElement).toBe(secondary);
    });

    it("has no accessibility violations when announcing", async () => {
      renderFocusable(true);
      expect(await checkA11y()).toHaveNoViolations();
    });
  });
});
