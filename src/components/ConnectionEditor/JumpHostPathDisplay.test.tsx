import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { JumpHostPathDisplay } from "./JumpHostPathDisplay";

let container: HTMLDivElement;
let root: Root;

function nodes(): string[] {
  return Array.from(container.querySelectorAll(".jump-host__path-node")).map(
    (n) => n.textContent ?? ""
  );
}

function render(hops: string[], target: string) {
  act(() => {
    root.render(<JumpHostPathDisplay hops={hops} target={target} />);
  });
}

describe("JumpHostPathDisplay", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders You → hops → target in order", () => {
    render(["bastion"], "prod-db");
    expect(nodes()).toEqual(["You", "bastion", "prod-db"]);
    expect(container.querySelector('[data-testid="jump-host-path"]')).not.toBeNull();
  });

  it("supports multiple hops", () => {
    render(["edge", "core"], "server");
    expect(nodes()).toEqual(["You", "edge", "core", "server"]);
  });

  it("trims hop and target labels", () => {
    render(["  bastion  "], "  prod  ");
    expect(nodes()).toEqual(["You", "bastion", "prod"]);
  });

  it("falls back to placeholders for blank hop and target labels", () => {
    render([""], "");
    expect(nodes()).toEqual(["You", "jump host", "target"]);
  });

  it("marks only the last node as the target", () => {
    render(["bastion"], "prod");
    const targetNodes = container.querySelectorAll(".jump-host__path-node--target");
    expect(targetNodes).toHaveLength(1);
    expect(targetNodes[0].textContent).toBe("prod");
  });

  it("renders one arrow separator fewer than nodes", () => {
    render(["a", "b"], "c");
    // 4 nodes (You, a, b, c) → 3 arrows
    expect(container.querySelectorAll(".jump-host__path-arrow")).toHaveLength(3);
  });

  it("renders just You → target with no hops", () => {
    render([], "host");
    expect(nodes()).toEqual(["You", "host"]);
    expect(container.querySelectorAll(".jump-host__path-arrow")).toHaveLength(1);
  });
});
