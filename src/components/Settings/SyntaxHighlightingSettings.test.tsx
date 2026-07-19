import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AppSettings } from "@/types/connection";
import { BUILTIN_RULES } from "@/services/syntaxHighlightingRules";
import { defaultHighlightingConfig } from "@/services/syntaxHighlightingConfig";
import { createCustomRule } from "@/services/customHighlightRules";
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

function byTestId(id: string): HTMLElement {
  return container.querySelector(`[data-testid="${id}"]`) as HTMLElement;
}

function setInput(el: HTMLElement, value: string) {
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  act(() => input.dispatchEvent(new Event("input", { bubbles: true })));
}

function withCustomRules(...rules: ReturnType<typeof createCustomRule>[]): AppSettings {
  return {
    ...defaultSettings,
    syntaxHighlighting: { ...defaultHighlightingConfig(), enabled: true, customRules: rules },
  };
}

describe("SyntaxHighlightingSettings custom rules", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderWith(settings: AppSettings, onChange = vi.fn()) {
    act(() => {
      root.render(<SyntaxHighlightingSettings settings={settings} onChange={onChange} />);
    });
    return onChange;
  }

  it("shows the empty state when there are no custom rules", () => {
    renderWith(defaultSettings);
    expect(byTestId("syntax-custom-rules-empty")).not.toBeNull();
  });

  it("opens the inline editor when Add Rule is clicked", () => {
    renderWith(defaultSettings);
    expect(byTestId("custom-rule-editor")).toBeNull();
    act(() => byTestId("syntax-custom-rule-add").click());
    expect(byTestId("custom-rule-editor")).not.toBeNull();
  });

  it("persists a new custom rule to customRules on save", () => {
    const onChange = renderWith(defaultSettings);
    act(() => byTestId("syntax-custom-rule-add").click());
    setInput(byTestId("custom-rule-name"), "TODO");
    setInput(byTestId("custom-rule-pattern"), "TODO");
    act(() => byTestId("custom-rule-save").click());

    const call = onChange.mock.calls[0][0] as AppSettings;
    expect(call.syntaxHighlighting?.customRules).toHaveLength(1);
    expect(call.syntaxHighlighting?.customRules[0].name).toBe("TODO");
    expect(call.syntaxHighlighting?.customRules[0].builtin).toBe(false);
  });

  it("renders existing custom rules with their pattern", () => {
    const rule = createCustomRule({ name: "Ports", pattern: ":\\d+" });
    renderWith(withCustomRules(rule));
    expect(byTestId(`syntax-custom-rule-${rule.id}`)).not.toBeNull();
    expect(container.textContent).toContain("Ports");
    expect(container.textContent).toContain(":\\d+");
  });

  it("toggling a custom rule's enabled flag writes the update", () => {
    const rule = createCustomRule({ name: "Ports", pattern: ":\\d+" });
    const onChange = renderWith(withCustomRules(rule));
    act(() => byTestId(`syntax-custom-rule-enabled-${rule.id}`).click());
    const call = onChange.mock.calls[0][0] as AppSettings;
    expect(call.syntaxHighlighting?.customRules[0].enabled).toBe(false);
  });

  it("deletes a custom rule", () => {
    const rule = createCustomRule({ name: "Ports", pattern: ":\\d+" });
    const onChange = renderWith(withCustomRules(rule));
    act(() => byTestId(`syntax-custom-rule-delete-${rule.id}`).click());
    const call = onChange.mock.calls[0][0] as AppSettings;
    expect(call.syntaxHighlighting?.customRules).toHaveLength(0);
  });

  it("reorders a custom rule down", () => {
    const a = createCustomRule({ name: "A", pattern: "a" });
    const b = createCustomRule({ name: "B", pattern: "b" });
    const onChange = renderWith(withCustomRules(a, b));
    act(() => byTestId(`syntax-custom-rule-down-${a.id}`).click());
    const call = onChange.mock.calls[0][0] as AppSettings;
    expect(call.syntaxHighlighting?.customRules.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it("edits an existing rule through the inline editor", () => {
    const rule = createCustomRule({ name: "Ports", pattern: ":\\d+" });
    const onChange = renderWith(withCustomRules(rule));
    act(() => byTestId(`syntax-custom-rule-edit-${rule.id}`).click());
    setInput(byTestId("custom-rule-name"), "Renamed");
    act(() => byTestId("custom-rule-save").click());
    const call = onChange.mock.calls[0][0] as AppSettings;
    expect(call.syntaxHighlighting?.customRules).toHaveLength(1);
    expect(call.syntaxHighlighting?.customRules[0].name).toBe("Renamed");
    expect(call.syntaxHighlighting?.customRules[0].id).toBe(rule.id);
  });
});
