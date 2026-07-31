/**
 * Tests for the plugin status-bar widget host (#1998, sandboxed #2136): a widget
 * descriptor pushed into the store materialises into DOM on the matching side,
 * removing it unmounts the host, and the descriptor is rebuilt through the
 * allowlist (never innerHTML).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { PluginStatusBarWidgets } from "./PluginStatusBarWidgets";
import {
  upsertStatusBarWidget,
  removeStatusBarWidget,
  clearStatusBarWidgets,
} from "@/plugins/sandbox/statusBarWidgetStore";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  clearStatusBarWidgets();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PluginStatusBarWidgets", () => {
  it("materialises a widget descriptor into the matching side", () => {
    upsertStatusBarWidget("p:cpu", "left", "cpu", { tag: "span", text: "42%" });
    act(() => root.render(<PluginStatusBarWidgets position="left" />));

    const host = container.querySelector('[data-testid="plugin-widget-cpu"]');
    expect(host).not.toBeNull();
    expect(host?.textContent).toBe("42%");
  });

  it("does not render a widget registered for the other side", () => {
    upsertStatusBarWidget("p:cpu", "right", "cpu", { tag: "span" });
    act(() => root.render(<PluginStatusBarWidgets position="left" />));
    expect(container.querySelector('[data-testid="plugin-widget-cpu"]')).toBeNull();
  });

  it("unmounts the host when the widget is removed", () => {
    upsertStatusBarWidget("p:cpu", "left", "cpu", { tag: "span", text: "x" });
    act(() => root.render(<PluginStatusBarWidgets position="left" />));
    expect(container.querySelector('[data-testid="plugin-widget-cpu"]')).not.toBeNull();

    act(() => removeStatusBarWidget("p:cpu"));
    expect(container.querySelector('[data-testid="plugin-widget-cpu"]')).toBeNull();
  });

  it("never injects descriptor text as HTML", () => {
    upsertStatusBarWidget("p:x", "left", "x", {
      tag: "span",
      text: "<img src=x onerror=alert(1)>",
    });
    act(() => root.render(<PluginStatusBarWidgets position="left" />));
    const host = container.querySelector('[data-testid="plugin-widget-x"]');
    expect(host?.querySelector("img")).toBeNull();
    expect(host?.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});
