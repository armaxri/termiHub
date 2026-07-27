import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { PanelErrorBoundary } from "./PanelErrorBoundary";

let container: HTMLDivElement;
let root: Root;
let errorSpy: ReturnType<typeof vi.spyOn>;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

/** Throws during render when `shouldThrow` is set — simulates a panel crash. */
function Boom({ shouldThrow }: { shouldThrow: boolean }): React.ReactElement {
  if (shouldThrow) throw new Error("panel boom");
  return <div data-testid="boom-recovered">recovered</div>;
}

describe("PanelErrorBoundary", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // React logs caught render errors to console.error; silence to keep output clean.
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    errorSpy.mockRestore();
  });

  it("renders the fallback for a throwing child without unmounting a sibling panel", () => {
    const siblingUnmount = vi.fn();
    function Sibling(): React.ReactElement {
      React.useEffect(() => siblingUnmount, []);
      return <div data-testid="sibling">alive</div>;
    }

    render(
      <>
        <PanelErrorBoundary label="panel-a">
          <Boom shouldThrow />
        </PanelErrorBoundary>
        <PanelErrorBoundary label="panel-b">
          <Sibling />
        </PanelErrorBoundary>
      </>
    );

    // The crashing panel shows its localized fallback...
    expect(byTestId("panel-error-boundary")).not.toBeNull();
    expect(byTestId("boom-recovered")).toBeNull();

    // ...while the sibling panel stays mounted and is never torn down.
    expect(byTestId("sibling")).not.toBeNull();
    expect(siblingUnmount).not.toHaveBeenCalled();
  });

  it("re-mounts the panel subtree when the localized retry is clicked", () => {
    let throwNow = true;
    function Maybe(): React.ReactElement {
      if (throwNow) throw new Error("panel boom");
      return <div data-testid="panel-content">ok</div>;
    }

    render(
      <PanelErrorBoundary>
        <Maybe />
      </PanelErrorBoundary>
    );

    expect(byTestId("panel-error-boundary")).not.toBeNull();
    expect(byTestId("panel-content")).toBeNull();

    // Underlying cause cleared; retry should re-render the children successfully.
    throwNow = false;
    act(() => {
      (byTestId("panel-error-retry") as HTMLButtonElement).click();
    });

    expect(byTestId("panel-content")).not.toBeNull();
    expect(byTestId("panel-error-boundary")).toBeNull();
  });
});
