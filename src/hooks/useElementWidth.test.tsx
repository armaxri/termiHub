import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useElementWidth } from "./useElementWidth";
import { installResizeObserverMock, type ResizeObserverMock } from "@/test/resizeObserver";

function Probe() {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  return (
    <div ref={ref} data-testid="probe">
      {width === null ? "unmeasured" : String(width)}
    </div>
  );
}

describe("useElementWidth (#4736)", () => {
  let ro: ResizeObserverMock;
  let container: HTMLDivElement;
  let root: Root;

  const mount = (node: ReactNode) => {
    act(() => root.render(node));
  };
  const probeText = () => container.querySelector('[data-testid="probe"]')?.textContent;

  beforeEach(() => {
    ro = installResizeObserverMock();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    ro.restore();
  });

  it("keeps exactly one live observer after StrictMode's double mount", () => {
    mount(
      <StrictMode>
        <Probe />
      </StrictMode>
    );
    expect(ro.liveObservers()).toBe(1);
    expect(probeText()).toBe("unmeasured");

    ro.resize(184);
    expect(probeText()).toBe("184");

    ro.resize(320);
    expect(probeText()).toBe("320");
  });

  it("reacts to width changes without StrictMode", () => {
    mount(<Probe />);
    expect(ro.liveObservers()).toBe(1);
    ro.resize(96);
    expect(probeText()).toBe("96");
  });

  it("disconnects its observer on unmount", () => {
    mount(
      <StrictMode>
        <Probe />
      </StrictMode>
    );
    expect(ro.liveObservers()).toBe(1);
    act(() => root.render(null));
    expect(ro.liveObservers()).toBe(0);
  });
});
