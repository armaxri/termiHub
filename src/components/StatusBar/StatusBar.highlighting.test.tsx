/**
 * Tests for the terminal syntax-highlighting status-bar indicator + quick
 * toggle (#1704).
 *
 * For the active terminal session the status bar shows "Highlighting: ON/OFF"
 * reflecting the resolved state (global config folded with the per-connection
 * override) plus the runtime per-session toggle. Clicking flips the
 * non-persisted per-session toggle (`setSessionHighlighting`). The indicator
 * stays hidden until the feature is globally enabled or already effectively on
 * for the session.
 */
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import { StatusBar } from "./StatusBar";
import type { ConnectionConfig, TerminalOptions, TerminalTab } from "@/types/terminal";
import type { SyntaxHighlightingConfig } from "@/types/syntaxHighlighting";
import { layoutState, seedLayoutState } from "@/test/layoutState";
import { flushAsync } from "@/test/flushAsync";

function setActiveTab(tab: Partial<TerminalTab> & { config: ConnectionConfig }) {
  const leafId = layoutState().rootPanel.id;
  const fullTab: TerminalTab = {
    id: "tab-1",
    sessionId: "s1",
    title: "target",
    connectionType: "ssh",
    contentType: "terminal",
    panelId: leafId,
    isActive: true,
    ...tab,
  };
  seedLayoutState({
    rootPanel: { type: "leaf", id: leafId, tabs: [fullTab], activeTabId: fullTab.id },
    activePanelId: leafId,
  });
}

function setGlobalHighlighting(config: Partial<SyntaxHighlightingConfig>) {
  seedSettings({
    syntaxHighlighting: { enabled: false, builtinRules: {}, customRules: [], ...config },
  });
}

function setPerConnection(tabId: string, options: TerminalOptions) {
  useAppStore.setState({
    tabTerminalOptions: { ...useAppStore.getState().tabTerminalOptions, [tabId]: options },
  });
}

setupSettingsRegion();

describe("StatusBar — syntax-highlighting indicator", () => {
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

  const query = () => container.querySelector('[data-testid="status-bar-highlighting"]');
  const render = async () => {
    await act(async () => {
      root.render(React.createElement(TooltipProvider, null, React.createElement(StatusBar)));
    });
    await flushAsync();
  };

  const sshConfig: ConnectionConfig = { type: "ssh", config: { host: "app", username: "deploy" } };

  it("is hidden while the feature is globally disabled and no override applies", async () => {
    setActiveTab({ config: sshConfig });
    await render();
    expect(query()).toBeNull();
  });

  it("shows 'Highlighting: ON' for an active terminal session when the feature is on", async () => {
    setActiveTab({ config: sshConfig });
    setGlobalHighlighting({ enabled: true });
    await render();
    const item = query();
    expect(item).not.toBeNull();
    expect(item!.textContent).toContain("Highlighting: ON");
  });

  it("shows 'Highlighting: OFF' when a per-connection override forces it off (global on)", async () => {
    setActiveTab({ config: sshConfig });
    setGlobalHighlighting({ enabled: true });
    setPerConnection("tab-1", {
      syntaxHighlighting: { override: "always-off", additionalRules: [] },
    });
    await render();
    const item = query();
    expect(item).not.toBeNull();
    expect(item!.textContent).toContain("Highlighting: OFF");
  });

  it("shows the indicator when a per-connection override forces it on while global is off", async () => {
    setActiveTab({ config: sshConfig });
    setPerConnection("tab-1", {
      syntaxHighlighting: { override: "always-on", additionalRules: [] },
    });
    await render();
    const item = query();
    expect(item).not.toBeNull();
    expect(item!.textContent).toContain("Highlighting: ON");
  });

  it("clicking flips the per-session toggle without persisting", async () => {
    setActiveTab({ config: sshConfig });
    setGlobalHighlighting({ enabled: true });
    await render();

    act(() => {
      (query() as HTMLButtonElement).click();
    });

    expect(useAppStore.getState().sessionHighlighting["s1"]).toBe(false);
    expect(query()!.textContent).toContain("Highlighting: OFF");

    act(() => {
      (query() as HTMLButtonElement).click();
    });
    expect(useAppStore.getState().sessionHighlighting["s1"]).toBe(true);
    expect(query()!.textContent).toContain("Highlighting: ON");
  });

  it("is hidden for a non-terminal (editor) tab", async () => {
    setActiveTab({ contentType: "editor", config: sshConfig });
    setGlobalHighlighting({ enabled: true });
    await render();
    expect(query()).toBeNull();
  });

  it("is hidden when the active terminal tab has no live session", async () => {
    setActiveTab({ sessionId: null, config: sshConfig });
    setGlobalHighlighting({ enabled: true });
    await render();
    expect(query()).toBeNull();
  });
});
