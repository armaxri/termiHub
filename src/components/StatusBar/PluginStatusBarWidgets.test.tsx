/**
 * Tests for the plugin status-bar widget host (#1998): a registered widget's
 * `render()` DOM mounts into the correct side, disabling the plugin unmounts it
 * and calls `dispose()` exactly once, and a widget whose `render()` throws is
 * isolated without breaking the status bar.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { PluginStatusBarWidgets } from "./PluginStatusBarWidgets";
import {
  ensureTermiHubApi,
  setLoadingPlugin,
  unregisterPlugin,
  clearRegistry,
  type StatusBarWidget,
} from "@/plugins/pluginRuntime";

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

let container: HTMLDivElement;
let root: Root;

function registerWidgetAs(pluginId: string, widget: StatusBarWidget): void {
  setLoadingPlugin(pluginId);
  window.termihub.registerStatusBarWidget(widget);
  setLoadingPlugin(null);
}

beforeEach(() => {
  clearRegistry();
  ensureTermiHubApi();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PluginStatusBarWidgets", () => {
  it("mounts a registered widget's DOM into the matching side", () => {
    const el = document.createElement("span");
    el.textContent = "42%";
    el.setAttribute("data-plugin-el", "cpu");
    registerWidgetAs("p", {
      id: "cpu",
      position: "left",
      render: () => el,
      dispose: () => {},
    });

    act(() => root.render(<PluginStatusBarWidgets position="left" />));

    const host = container.querySelector('[data-testid="plugin-widget-cpu"]');
    expect(host).not.toBeNull();
    expect(host?.querySelector('[data-plugin-el="cpu"]')?.textContent).toBe("42%");
  });

  it("does not render a widget registered for the other side", () => {
    registerWidgetAs("p", {
      id: "cpu",
      position: "right",
      render: () => document.createElement("span"),
      dispose: () => {},
    });
    act(() => root.render(<PluginStatusBarWidgets position="left" />));
    expect(container.querySelector('[data-testid="plugin-widget-cpu"]')).toBeNull();
  });

  it("disposes the widget exactly once when its plugin is disabled", () => {
    const dispose = vi.fn();
    registerWidgetAs("p", {
      id: "cpu",
      position: "left",
      render: () => document.createElement("span"),
      dispose,
    });
    act(() => root.render(<PluginStatusBarWidgets position="left" />));
    expect(container.querySelector('[data-testid="plugin-widget-cpu"]')).not.toBeNull();

    // Disabling the plugin drops it from the registry; the host unmounts.
    act(() => unregisterPlugin("p"));

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="plugin-widget-cpu"]')).toBeNull();
  });

  it("isolates a widget whose render() throws without breaking the bar", () => {
    registerWidgetAs("bad", {
      id: "bad",
      position: "left",
      render: () => {
        throw new Error("boom");
      },
      dispose: () => {},
    });
    const good = document.createElement("span");
    good.setAttribute("data-plugin-el", "good");
    registerWidgetAs("good", {
      id: "good",
      position: "left",
      render: () => good,
      dispose: () => {},
    });

    expect(() => act(() => root.render(<PluginStatusBarWidgets position="left" />))).not.toThrow();

    // The good widget still mounts alongside the broken one's (empty) host.
    expect(container.querySelector('[data-plugin-el="good"]')).not.toBeNull();
  });
});
