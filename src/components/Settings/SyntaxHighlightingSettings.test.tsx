import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AppSettings } from "@/types/connection";
import { BUILTIN_RULES } from "@/services/syntaxHighlightingRules";
import { defaultHighlightingConfig } from "@/services/syntaxHighlightingConfig";
import { SyntaxHighlightingSettings } from "./SyntaxHighlightingSettings";

let container: HTMLDivElement;
let root: Root;

const defaultSettings: AppSettings = {
  version: "1",
  externalConnectionFiles: [],
  powerMonitoringEnabled: true,
  fileBrowserEnabled: true,
};

function renderWith(settings: AppSettings, onChange = vi.fn()) {
  act(() => {
    root.render(<SyntaxHighlightingSettings settings={settings} onChange={onChange} />);
  });
  return onChange;
}

function masterToggle(): HTMLElement {
  return container.querySelector(
    '[data-testid="settings-syntax-highlighting-enabled"]'
  ) as HTMLElement;
}

function ruleCheckbox(id: string): HTMLElement {
  return container.querySelector(`[data-testid="syntax-rule-${id}"]`) as HTMLElement;
}

describe("SyntaxHighlightingSettings", () => {
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

  it("renders the master toggle as a shared Toggle primitive", () => {
    renderWith(defaultSettings);
    const toggle = masterToggle();
    expect(toggle).not.toBeNull();
    expect(toggle.classList.contains("ui-toggle")).toBe(true);
  });

  it("reflects the shipped-default disabled master state when no config is persisted", () => {
    renderWith(defaultSettings);
    // defaultHighlightingConfig() ships the feature off.
    expect(masterToggle().getAttribute("aria-checked")).toBe("false");
  });

  it("reflects a persisted enabled master state", () => {
    renderWith({
      ...defaultSettings,
      syntaxHighlighting: { ...defaultHighlightingConfig(), enabled: true },
    });
    expect(masterToggle().getAttribute("aria-checked")).toBe("true");
  });

  it("toggling the master switch writes syntaxHighlighting.enabled to the store", () => {
    const onChange = renderWith(defaultSettings);
    act(() => masterToggle().click());
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        syntaxHighlighting: expect.objectContaining({ enabled: true }),
      })
    );
  });

  it("renders a checkbox row for every built-in rule with its name", () => {
    renderWith(defaultSettings);
    for (const rule of BUILTIN_RULES) {
      expect(ruleCheckbox(rule.id)).not.toBeNull();
    }
    expect(container.textContent).toContain("Error keywords");
    expect(container.textContent).toContain("URLs");
  });

  it("renders each rule checkbox as a shared Checkbox primitive", () => {
    renderWith(defaultSettings);
    expect(ruleCheckbox("error-keywords").classList.contains("ui-checkbox")).toBe(true);
  });

  it("reflects the shipped per-rule default enabled flags", () => {
    renderWith(defaultSettings);
    // error-keywords ships enabled (P0); quoted-strings ships disabled (P2).
    expect(ruleCheckbox("error-keywords").getAttribute("aria-checked")).toBe("true");
    expect(ruleCheckbox("quoted-strings").getAttribute("aria-checked")).toBe("false");
  });

  it("reflects a persisted per-rule override", () => {
    renderWith({
      ...defaultSettings,
      syntaxHighlighting: {
        ...defaultHighlightingConfig(),
        enabled: true,
        builtinRules: { ...defaultHighlightingConfig().builtinRules, "error-keywords": false },
      },
    });
    expect(ruleCheckbox("error-keywords").getAttribute("aria-checked")).toBe("false");
  });

  it("toggling a built-in rule writes the updated flag to the store", () => {
    const onChange = renderWith({
      ...defaultSettings,
      syntaxHighlighting: { ...defaultHighlightingConfig(), enabled: true },
    });
    act(() => ruleCheckbox("error-keywords").click());
    const call = onChange.mock.calls[0][0] as AppSettings;
    expect(call.syntaxHighlighting?.builtinRules["error-keywords"]).toBe(false);
    // Other rule flags are preserved.
    expect(call.syntaxHighlighting?.builtinRules["warning-keywords"]).toBe(true);
  });

  it("enabling a shipped-off rule writes true", () => {
    const onChange = renderWith({
      ...defaultSettings,
      syntaxHighlighting: { ...defaultHighlightingConfig(), enabled: true },
    });
    act(() => ruleCheckbox("quoted-strings").click());
    const call = onChange.mock.calls[0][0] as AppSettings;
    expect(call.syntaxHighlighting?.builtinRules["quoted-strings"]).toBe(true);
  });

  it("renders a color swatch and example for each rule", () => {
    renderWith(defaultSettings);
    const rows = container.querySelectorAll(".syntax-rule");
    expect(rows.length).toBe(BUILTIN_RULES.length);
    const firstSwatch = rows[0].querySelector(".syntax-rule__swatch") as HTMLElement;
    expect(firstSwatch).not.toBeNull();
    // A non-empty example is shown so the user can preview the rule.
    const firstExample = rows[0].querySelector(".syntax-rule__example");
    expect(firstExample?.textContent?.trim().length).toBeGreaterThan(0);
  });

  it("disables per-rule checkboxes while the master switch is off", () => {
    renderWith(defaultSettings);
    // Master ships off, so individual rules cannot be toggled until it is on.
    expect(ruleCheckbox("error-keywords").hasAttribute("disabled")).toBe(true);
  });

  it("hides the whole section when visibleFields excludes syntaxHighlighting", () => {
    act(() => {
      root.render(
        <SyntaxHighlightingSettings
          settings={defaultSettings}
          onChange={vi.fn()}
          visibleFields={new Set(["cursorStyle"])}
        />
      );
    });
    expect(masterToggle()).toBeNull();
    expect(container.querySelector(".syntax-rule")).toBeNull();
  });

  it("shows the section when visibleFields includes syntaxHighlighting", () => {
    act(() => {
      root.render(
        <SyntaxHighlightingSettings
          settings={defaultSettings}
          onChange={vi.fn()}
          visibleFields={new Set(["syntaxHighlighting"])}
        />
      );
    });
    expect(masterToggle()).not.toBeNull();
  });
});
