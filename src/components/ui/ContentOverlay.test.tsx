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
});
