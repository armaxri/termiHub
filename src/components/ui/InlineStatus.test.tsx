import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { InlineStatus } from "./InlineStatus";

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

function line(): HTMLElement {
  return container.querySelector<HTMLElement>('[data-testid="status"]')!;
}

describe("InlineStatus (#5859)", () => {
  it("is a polite live region even while empty, so a later message is announced", () => {
    act(() => root.render(<InlineStatus kind="info" message={null} testId="status" />));
    expect(line().getAttribute("role")).toBe("status");
    expect(line().getAttribute("aria-live")).toBe("polite");
    expect(line().textContent).toBe("");
  });

  it("shows the message with its quieter detail and kind", () => {
    act(() =>
      root.render(
        <InlineStatus
          kind="success"
          message="Reached web"
          detail="Nothing was saved."
          testId="status"
        />
      )
    );
    expect(line().getAttribute("data-kind")).toBe("success");
    expect(line().textContent).toBe("Reached web Nothing was saved.");
    expect(line().querySelector(".ui-inline-status__detail")?.textContent).toBe(
      " Nothing was saved."
    );
    expect(line().querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("omits the detail when none is given", () => {
    act(() => root.render(<InlineStatus kind="info" message="Test canceled" testId="status" />));
    expect(line().textContent).toBe("Test canceled");
    expect(line().querySelector(".ui-inline-status__detail")).toBeNull();
  });
});
