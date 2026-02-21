import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { LayoutPreview } from "./LayoutPreview";
import { LayoutConfig } from "@/types/connection";

let container: HTMLDivElement;
let root: Root;

function render(layout: LayoutConfig) {
  act(() => {
    root.render(<LayoutPreview layout={layout} />);
  });
}

function query(testId: string): Element | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function queryAll(testId: string): NodeListOf<Element> {
  return container.querySelectorAll(`[data-testid="${testId}"]`);
}

describe("LayoutPreview", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders all sections in default layout", () => {
    render({
      activityBarPosition: "left",
      sidebarPosition: "left",
      sidebarVisible: true,
      statusBarVisible: true,
    });

    expect(query("layout-preview")).not.toBeNull();
    expect(query("preview-ab")).not.toBeNull();
    expect(query("preview-sidebar")).not.toBeNull();
    expect(query("preview-terminal")).not.toBeNull();
    expect(query("preview-statusbar")).not.toBeNull();
    expect(query("preview-ab-top")).toBeNull();
  });

  it("hides activity bar when position is hidden", () => {
    render({
      activityBarPosition: "hidden",
      sidebarPosition: "left",
      sidebarVisible: true,
      statusBarVisible: true,
    });

    expect(query("preview-ab")).toBeNull();
    expect(query("preview-ab-top")).toBeNull();
    expect(query("preview-sidebar")).not.toBeNull();
    expect(query("preview-terminal")).not.toBeNull();
  });

  it("renders top activity bar when position is top", () => {
    render({
      activityBarPosition: "top",
      sidebarPosition: "left",
      sidebarVisible: true,
      statusBarVisible: true,
    });

    expect(query("preview-ab-top")).not.toBeNull();
    expect(query("preview-ab")).toBeNull();
    expect(query("preview-content")).not.toBeNull();
    expect(query("preview-main")).toBeNull();
  });

  it("renders activity bar on right side", () => {
    render({
      activityBarPosition: "right",
      sidebarPosition: "left",
      sidebarVisible: true,
      statusBarVisible: true,
    });

    const main = query("preview-main");
    expect(main).not.toBeNull();

    const children = Array.from(main!.children);
    const abIndex = children.findIndex((el) => el.getAttribute("data-testid") === "preview-ab");
    const terminalIndex = children.findIndex(
      (el) => el.getAttribute("data-testid") === "preview-terminal"
    );

    expect(abIndex).toBeGreaterThan(terminalIndex);
  });

  it("hides sidebar when sidebarVisible is false", () => {
    render({
      activityBarPosition: "left",
      sidebarPosition: "left",
      sidebarVisible: false,
      statusBarVisible: true,
    });

    expect(query("preview-sidebar")).toBeNull();
    expect(query("preview-ab")).not.toBeNull();
    expect(query("preview-terminal")).not.toBeNull();
  });

  it("renders sidebar on right side of terminal", () => {
    render({
      activityBarPosition: "left",
      sidebarPosition: "right",
      sidebarVisible: true,
      statusBarVisible: true,
    });

    const main = query("preview-main");
    expect(main).not.toBeNull();

    const children = Array.from(main!.children);
    const sidebarIndex = children.findIndex(
      (el) => el.getAttribute("data-testid") === "preview-sidebar"
    );
    const terminalIndex = children.findIndex(
      (el) => el.getAttribute("data-testid") === "preview-terminal"
    );

    expect(sidebarIndex).toBeGreaterThan(terminalIndex);
  });

  it("hides status bar when statusBarVisible is false", () => {
    render({
      activityBarPosition: "left",
      sidebarPosition: "left",
      sidebarVisible: true,
      statusBarVisible: false,
    });

    expect(query("preview-statusbar")).toBeNull();
  });

  it("renders zen layout (no AB, no sidebar, no status bar)", () => {
    render({
      activityBarPosition: "hidden",
      sidebarPosition: "left",
      sidebarVisible: false,
      statusBarVisible: false,
    });

    expect(query("preview-ab")).toBeNull();
    expect(query("preview-ab-top")).toBeNull();
    expect(query("preview-sidebar")).toBeNull();
    expect(query("preview-statusbar")).toBeNull();
    expect(query("preview-terminal")).not.toBeNull();
  });

  it("renders labels inside sections", () => {
    render({
      activityBarPosition: "left",
      sidebarPosition: "left",
      sidebarVisible: true,
      statusBarVisible: true,
    });

    expect(query("preview-ab")?.textContent).toBe("AB");
    expect(query("preview-sidebar")?.textContent).toBe("Sidebar");
    expect(query("preview-terminal")?.textContent).toBe("Terminal");
    expect(query("preview-statusbar")?.textContent).toBe("Status Bar");
  });

  it("renders Activity Bar label when position is top", () => {
    render({
      activityBarPosition: "top",
      sidebarPosition: "left",
      sidebarVisible: true,
      statusBarVisible: true,
    });

    expect(query("preview-ab-top")?.textContent).toBe("Activity Bar");
  });

  it("does not duplicate sidebar when visible", () => {
    render({
      activityBarPosition: "left",
      sidebarPosition: "left",
      sidebarVisible: true,
      statusBarVisible: true,
    });

    expect(queryAll("preview-sidebar").length).toBe(1);
  });
});
