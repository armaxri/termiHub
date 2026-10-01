import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import { mockReducedMotion, type ReducedMotionMock } from "@/test/reducedMotion";

function Probe() {
  return <span data-testid="probe">{usePrefersReducedMotion() ? "reduced" : "full"}</span>;
}

describe("usePrefersReducedMotion", () => {
  let container: HTMLDivElement;
  let root: Root;
  let motion: ReducedMotionMock | undefined;

  function render() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Probe />));
    return () => container.querySelector("[data-testid='probe']")?.textContent;
  }

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    motion?.restore();
    motion = undefined;
  });

  it("reports false when the OS allows full motion", () => {
    motion = mockReducedMotion(false);
    expect(render()()).toBe("full");
  });

  it("reports true under prefers-reduced-motion: reduce", () => {
    motion = mockReducedMotion(true);
    expect(render()()).toBe("reduced");
  });

  it("re-renders live when the preference flips", () => {
    motion = mockReducedMotion(false);
    const read = render();
    expect(read()).toBe("full");
    act(() => motion!.set(true));
    expect(read()).toBe("reduced");
    act(() => motion!.set(false));
    expect(read()).toBe("full");
  });
});
