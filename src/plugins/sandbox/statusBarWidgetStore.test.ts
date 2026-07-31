/**
 * Tests for the main-thread status-bar widget snapshot store (#2136): per-side
 * projection, stable references for `useSyncExternalStore`, upsert/remove, and
 * subscriber notification.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  upsertStatusBarWidget,
  removeStatusBarWidget,
  clearStatusBarWidgets,
  getStatusBarWidgets,
  subscribeStatusBarWidgets,
} from "./statusBarWidgetStore";

beforeEach(() => clearStatusBarWidgets());

describe("statusBarWidgetStore", () => {
  it("projects widgets to their side with their key and id", () => {
    upsertStatusBarWidget("p1:clock", "left", "clock", { tag: "span", text: "L" });
    upsertStatusBarWidget("p2:cpu", "right", "cpu", { tag: "span", text: "R" });
    expect(getStatusBarWidgets("left").map((e) => e.key)).toEqual(["p1:clock"]);
    expect(getStatusBarWidgets("right").map((e) => e.widgetId)).toEqual(["cpu"]);
  });

  it("returns a stable reference until the registry changes", () => {
    const before = getStatusBarWidgets("left");
    expect(getStatusBarWidgets("left")).toBe(before);
    upsertStatusBarWidget("p1:clock", "left", "clock", { tag: "span" });
    expect(getStatusBarWidgets("left")).not.toBe(before);
  });

  it("replaces a widget in place by key (upsert), preserving order", () => {
    upsertStatusBarWidget("p:a", "left", "a", { tag: "span", text: "1" });
    upsertStatusBarWidget("p:b", "left", "b", { tag: "span", text: "2" });
    upsertStatusBarWidget("p:a", "left", "a", { tag: "span", text: "3" });
    const left = getStatusBarWidgets("left");
    expect(left.map((e) => e.key)).toEqual(["p:a", "p:b"]);
    expect(left[0].node).toEqual({ tag: "span", text: "3" });
  });

  it("notifies subscribers on upsert and remove", () => {
    const listener = vi.fn();
    const unsub = subscribeStatusBarWidgets(listener);
    upsertStatusBarWidget("p:a", "left", "a", { tag: "span" });
    expect(listener).toHaveBeenCalledTimes(1);
    removeStatusBarWidget("p:a");
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
    upsertStatusBarWidget("p:b", "left", "b", { tag: "span" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("remove is a no-op for an unknown key", () => {
    const listener = vi.fn();
    subscribeStatusBarWidgets(listener);
    removeStatusBarWidget("nope");
    expect(listener).not.toHaveBeenCalled();
  });
});
