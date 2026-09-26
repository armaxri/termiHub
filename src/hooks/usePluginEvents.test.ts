/**
 * Tests for {@link usePluginEvents} (#3344): a backend `plugin-changed` event
 * (e.g. a native-plugin trust change in Settings) re-fetches the plugin list and
 * the connection-type registry, so the sidebar's missing-plugin marker updates
 * live.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { usePluginEvents } from "./usePluginEvents";
import { onPluginsChanged } from "@/services/events";

vi.mock("@/services/events", () => ({ onPluginsChanged: vi.fn() }));

const mockedOnPluginsChanged = vi.mocked(onPluginsChanged);

describe("usePluginEvents", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fire: (() => void) | null;
  const unlisten = vi.fn();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    fire = null;
    unlisten.mockReset();
    mockedOnPluginsChanged.mockImplementation(async (cb) => {
      fire = cb;
      return unlisten;
    });
  });

  afterEach(() => {
    container.remove();
  });

  it("reloads plugins and connection types on plugin-changed, and unsubscribes", async () => {
    const loadPlugins = vi.fn(() => Promise.resolve());
    const refreshConnectionTypes = vi.fn(() => Promise.resolve());
    useAppStore.setState({ loadPlugins, refreshConnectionTypes });
    function Harness() {
      usePluginEvents();
      return null;
    }
    await act(async () => {
      root.render(createElement(Harness));
    });
    expect(mockedOnPluginsChanged).toHaveBeenCalledOnce();

    act(() => fire!());
    expect(loadPlugins).toHaveBeenCalledOnce();
    expect(refreshConnectionTypes).toHaveBeenCalledOnce();

    act(() => root.unmount());
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
