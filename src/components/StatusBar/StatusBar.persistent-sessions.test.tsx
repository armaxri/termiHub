/**
 * Tests for the background persistent-session count segment (#1882).
 *
 * The status bar shows an infinity-icon segment with the number of persistent
 * connections whose background process is currently running (state `running`
 * or `attached`). It counts across desktop-local and agent-hosted sessions
 * (both live in the store's `persistentSessions` map), is hidden when none are
 * running, and opens the Connections sidebar when clicked.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import { StatusBar } from "./StatusBar";
import type { PersistentRunState, PersistentSessionEntry } from "@/types/connection";

function renderStatusBar(root: Root) {
  root.render(React.createElement(TooltipProvider, null, React.createElement(StatusBar)));
}

function entry(connectionId: string, state: PersistentRunState): PersistentSessionEntry {
  return { connectionId, sessionId: "s1", state, attachedTabIds: [] };
}

function setSessions(sessions: Record<string, PersistentSessionEntry>) {
  useAppStore.setState({ persistentSessions: sessions });
}

describe("StatusBar — persistent-session count segment", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const query = () => container.querySelector('[data-testid="persistent-sessions-indicator"]');

  it("is hidden when no persistent sessions are running", () => {
    setSessions({
      a: entry("a", "stopped"),
      b: entry("b", "starting"),
      c: entry("c", "error"),
    });

    act(() => renderStatusBar(root));

    expect(query()).toBeNull();
  });

  it("counts only running and attached sessions", () => {
    setSessions({
      a: entry("a", "running"),
      b: entry("b", "attached"),
      c: entry("c", "starting"),
      d: entry("d", "stopping"),
      e: entry("e", "stopped"),
      f: entry("f", "error"),
    });

    act(() => renderStatusBar(root));

    const item = query();
    expect(item).not.toBeNull();
    expect(item!.textContent).toContain("2");
    expect(item!.getAttribute("aria-label")).toContain("2 background sessions running");
  });

  it("uses the singular label for a single running session", () => {
    setSessions({ a: entry("a", "running") });

    act(() => renderStatusBar(root));

    const item = query();
    expect(item).not.toBeNull();
    expect(item!.textContent).toContain("1");
    expect(item!.getAttribute("aria-label")).toContain("1 background session running");
    expect(item!.getAttribute("aria-label")).not.toContain("sessions");
  });

  it("opens the Connections sidebar when clicked", () => {
    useAppStore.setState({ sidebarView: "services" });
    setSessions({ a: entry("a", "running") });

    act(() => renderStatusBar(root));

    act(() => {
      query()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useAppStore.getState().sidebarView).toBe("connections");
  });
});
