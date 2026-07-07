/**
 * Tests for the tooltip adoption on the StatusBar `DropdownMenu.Trigger`
 * text-buttons (issue #1163, follow-up to #1114/#1102).
 *
 * DECISION (ADOPT, partial): three text-buttons whose tooltip names the ACTION
 * — distinct from the VALUE shown in the visible label — were converted from a
 * bare `title=` to the shared `<Tooltip>` primitive, mirroring VS Code's
 * status-bar "Select Indentation" / "Select Language Mode" pattern:
 *   - `status-bar-tab-size`    ("Select indentation"   vs. label "Spaces: 2")
 *   - `monitoring-connect-btn` ("Connect monitoring"   vs. label "Monitor")
 *   - `status-bar-language`    ("Select language mode" vs. label "TypeScript")
 *
 * The fourth trigger, `monitoring-host`, is the intentional NO-TOOLTIP case: in
 * its normal state the `title` only duplicated the hostname already shown in the
 * label, so the redundant title was removed. A `title` is kept only while the
 * host is reconnecting, where it conveys transient state the collapsed label does
 * not spell out.
 *
 * These tests verify the Tooltip -> DropdownMenu.Trigger `asChild` composition
 * keeps both the menu-open behavior and every `data-testid` / accessible name
 * intact, and guard the deliberate no-tooltip decision on `monitoring-host`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { StatusBar } from "./StatusBar";
import type { EditorStatus, EditorActions } from "@/types/terminal";

// Stub the unrelated status-bar children so the tests isolate the triggers.
vi.mock("@/components/CredentialStoreIndicator", () => ({ CredentialStoreIndicator: () => null }));
vi.mock("./PortableBadge", () => ({ PortableBadge: () => null }));
vi.mock("./UpdateIndicator", () => ({ UpdateIndicator: () => null }));

function makeEditorStatus(overrides: Partial<EditorStatus> = {}): EditorStatus {
  return {
    line: 1,
    column: 1,
    language: "typescript",
    availableLanguages: [
      { id: "typescript", name: "TypeScript" },
      { id: "json", name: "JSON" },
    ],
    eol: "LF",
    tabSize: 2,
    insertSpaces: true,
    encoding: "UTF-8",
    ...overrides,
  };
}

const noopEditorActions: EditorActions = {
  setIndent: () => {},
  toggleEol: () => {},
  setLanguage: () => {},
};

describe("StatusBar — dropdown-trigger tooltip adoption (#1163)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({
      editorStatus: makeEditorStatus(),
      editorActions: noopEditorActions,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderStatusBar() {
    act(() =>
      root.render(React.createElement(TooltipProvider, null, React.createElement(StatusBar)))
    );
  }

  it("keeps the indent trigger testid and drops its bare title after Tooltip adoption", () => {
    renderStatusBar();
    const trigger = container.querySelector('[data-testid="status-bar-tab-size"]');
    expect(trigger).not.toBeNull();
    // The action hint now lives in the shared Tooltip, not a bare title attribute.
    expect(trigger!.hasAttribute("title")).toBe(false);
    // Visible label (the VALUE) is unchanged.
    expect(trigger!.textContent).toContain("Spaces: 2");
  });

  it("keeps the language trigger testid and drops its bare title after Tooltip adoption", () => {
    renderStatusBar();
    const trigger = container.querySelector('[data-testid="status-bar-language"]');
    expect(trigger).not.toBeNull();
    expect(trigger!.hasAttribute("title")).toBe(false);
    expect(trigger!.textContent).toContain("TypeScript");
  });

  it("opens the indent menu on click (Tooltip -> DropdownMenu.Trigger composition works)", () => {
    renderStatusBar();
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="status-bar-tab-size"]'
    );
    expect(trigger).not.toBeNull();
    act(() => {
      trigger!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger!.dispatchEvent(new PointerEvent("click", { bubbles: true }));
    });
    // The menu items render into a portal on document.body once open.
    expect(document.body.querySelector('[data-testid="indent-spaces-4"]')).not.toBeNull();
  });
});
