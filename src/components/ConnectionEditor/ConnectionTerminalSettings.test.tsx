import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import {
  ConnectionTerminalSettings,
  applyHighlightingOverride,
  applyAdditionalRules,
} from "./ConnectionTerminalSettings";
import { resolveHighlightingConfig } from "@/services/syntaxHighlightingConfig";
import type { TerminalOptions } from "@/types/terminal";
import type { HighlightRule } from "@/types/syntaxHighlighting";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("@/themes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/themes")>();
  return {
    ...actual,
    applyTheme: vi.fn(),
    onThemeChange: vi.fn(() => vi.fn()),
  };
});

const emptyOptions: TerminalOptions = {};

let container: HTMLDivElement;
let root: Root;

function renderWith(options: TerminalOptions, onChange = vi.fn()) {
  act(() => {
    root.render(<ConnectionTerminalSettings options={options} onChange={onChange} />);
  });
  return onChange;
}

/** Drive a controlled input the way a real keystroke would. */
function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function fieldInput(label: string): HTMLInputElement {
  const el = Array.from(container.querySelectorAll(".settings-form__label")).find(
    (l) => l.textContent === label
  );
  return el?.closest(".settings-form__field")?.querySelector("input") as HTMLInputElement;
}

setupSettingsRegion();

describe("ConnectionTerminalSettings — scrollback buffer", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the scrollback buffer input", () => {
    renderWith(emptyOptions);
    const labels = Array.from(container.querySelectorAll(".settings-form__label"));
    const label = labels.find((el) => el.textContent === "Scrollback Buffer");
    expect(label).toBeDefined();

    const field = label?.closest(".settings-form__field");
    const input = field?.querySelector("input[type='number']") as HTMLInputElement | null;
    expect(input).not.toBeNull();
  });

  it("shows empty value when no per-connection override is set", () => {
    renderWith(emptyOptions);
    const labels = Array.from(container.querySelectorAll(".settings-form__label"));
    const field = labels
      .find((el) => el.textContent === "Scrollback Buffer")
      ?.closest(".settings-form__field");
    const input = field?.querySelector("input[type='number']") as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("reflects the per-connection scrollbackBuffer value", () => {
    renderWith({ ...emptyOptions, scrollbackBuffer: 25000 });
    const labels = Array.from(container.querySelectorAll(".settings-form__label"));
    const field = labels
      .find((el) => el.textContent === "Scrollback Buffer")
      ?.closest(".settings-form__field");
    const input = field?.querySelector("input[type='number']") as HTMLInputElement;
    expect(input.value).toBe("25000");
  });

  it("placeholder shows global default of 10000 when no global setting is configured", () => {
    renderWith(emptyOptions);
    const labels = Array.from(container.querySelectorAll(".settings-form__label"));
    const field = labels
      .find((el) => el.textContent === "Scrollback Buffer")
      ?.closest(".settings-form__field");
    const input = field?.querySelector("input[type='number']") as HTMLInputElement;
    expect(input.placeholder).toContain("10000");
  });

  it("placeholder reflects a custom global scrollbackBuffer setting", () => {
    seedSettings({ scrollbackBuffer: 50000 });
    renderWith(emptyOptions);
    const labels = Array.from(container.querySelectorAll(".settings-form__label"));
    const field = labels
      .find((el) => el.textContent === "Scrollback Buffer")
      ?.closest(".settings-form__field");
    const input = field?.querySelector("input[type='number']") as HTMLInputElement;
    expect(input.placeholder).toContain("50000");
  });

  it("hint text mentions memory", () => {
    renderWith(emptyOptions);
    const labels = Array.from(container.querySelectorAll(".settings-form__label"));
    const field = labels
      .find((el) => el.textContent === "Scrollback Buffer")
      ?.closest(".settings-form__field");
    const hint = field?.querySelector(".settings-form__hint");
    expect(hint?.textContent?.toLowerCase()).toContain("memory");
  });

  it("editing the scrollback buffer emits the parsed number (#1453)", () => {
    const onChange = renderWith(emptyOptions);
    setValue(fieldInput("Scrollback Buffer"), "30000");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ scrollbackBuffer: 30000 }));
  });

  it("clearing the scrollback buffer emits undefined (#1453)", () => {
    const onChange = renderWith({ ...emptyOptions, scrollbackBuffer: 25000 });
    setValue(fieldInput("Scrollback Buffer"), "");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ scrollbackBuffer: undefined }));
  });
});

describe("ConnectionTerminalSettings — font size", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the font size through the shared NumberInput primitive (#1453)", () => {
    renderWith(emptyOptions);
    expect(fieldInput("Font Size").classList.contains("ui-input")).toBe(true);
    expect(fieldInput("Font Size").type).toBe("number");
  });

  it("shows a blank field when no per-connection override is set", () => {
    renderWith(emptyOptions);
    expect(fieldInput("Font Size").value).toBe("");
  });

  it("reflects the per-connection font size", () => {
    renderWith({ ...emptyOptions, fontSize: 18 });
    expect(fieldInput("Font Size").value).toBe("18");
  });

  it("editing the font size emits the parsed number (#1453)", () => {
    const onChange = renderWith(emptyOptions);
    setValue(fieldInput("Font Size"), "20");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 20 }));
  });

  it("clearing the font size emits undefined (#1453)", () => {
    const onChange = renderWith({ ...emptyOptions, fontSize: 16 });
    setValue(fieldInput("Font Size"), "");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ fontSize: undefined }));
  });
});

describe("ConnectionTerminalSettings — syntax highlighting override", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  const trigger = () =>
    container.querySelector('[data-testid="connection-syntax-highlighting"]') as HTMLElement;

  it("renders the syntax-highlighting override select", () => {
    renderWith(emptyOptions);
    expect(trigger()).not.toBeNull();
  });

  it("defaults to 'global' when no per-connection override is set", () => {
    renderWith(emptyOptions);
    expect(trigger().getAttribute("data-value")).toBe("global");
  });

  it("reflects a stored 'always-off' override", () => {
    renderWith({
      ...emptyOptions,
      syntaxHighlighting: { override: "always-off", additionalRules: [] },
    });
    expect(trigger().getAttribute("data-value")).toBe("always-off");
  });

  it("reflects a stored 'always-on' override", () => {
    renderWith({
      ...emptyOptions,
      syntaxHighlighting: { override: "always-on", additionalRules: [] },
    });
    expect(trigger().getAttribute("data-value")).toBe("always-on");
  });

  it("global-default hint reflects the global on/off state", () => {
    seedSettings({ syntaxHighlighting: { enabled: true, builtinRules: {}, customRules: [] } });
    renderWith(emptyOptions);
    const label = Array.from(container.querySelectorAll(".settings-form__label")).find(
      (l) => l.textContent === "Syntax Highlighting"
    );
    const field = label?.closest(".settings-form__field");
    expect(field?.textContent?.toLowerCase()).toContain("on");
  });
});

describe("applyHighlightingOverride", () => {
  const rule: HighlightRule = {
    id: "custom-1",
    name: "custom",
    pattern: "foo",
    style: { color: "#ff0000" },
    enabled: true,
    priority: 5,
    builtin: false,
  };

  it("clears the override entirely when 'global' is chosen with no additional rules", () => {
    const next = applyHighlightingOverride(
      { fontSize: 14, syntaxHighlighting: { override: "always-on", additionalRules: [] } },
      "global"
    );
    expect(next.syntaxHighlighting).toBeUndefined();
    expect(next.fontSize).toBe(14);
  });

  it("stores 'always-on' with an empty additional-rules list", () => {
    const next = applyHighlightingOverride({}, "always-on");
    expect(next.syntaxHighlighting).toEqual({ override: "always-on", additionalRules: [] });
  });

  it("stores 'always-off'", () => {
    const next = applyHighlightingOverride({}, "always-off");
    expect(next.syntaxHighlighting).toEqual({ override: "always-off", additionalRules: [] });
  });

  it("preserves connection-specific additional rules when changing the override", () => {
    const next = applyHighlightingOverride(
      { syntaxHighlighting: { override: "global", additionalRules: [rule] } },
      "always-on"
    );
    expect(next.syntaxHighlighting).toEqual({ override: "always-on", additionalRules: [rule] });
  });

  it("keeps the override object when 'global' is chosen but additional rules exist", () => {
    const next = applyHighlightingOverride(
      { syntaxHighlighting: { override: "always-off", additionalRules: [rule] } },
      "global"
    );
    expect(next.syntaxHighlighting).toEqual({ override: "global", additionalRules: [rule] });
  });
});

describe("applyAdditionalRules", () => {
  const rule: HighlightRule = {
    id: "custom-1",
    name: "custom",
    pattern: "foo",
    style: { color: "#ff0000" },
    enabled: true,
    priority: 5,
    builtin: false,
  };

  it("stores the rules under the current (default global) override", () => {
    const next = applyAdditionalRules({ fontSize: 14 }, [rule]);
    expect(next.syntaxHighlighting).toEqual({ override: "global", additionalRules: [rule] });
    expect(next.fontSize).toBe(14);
  });

  it("preserves a non-global override when the rules change", () => {
    const next = applyAdditionalRules(
      { syntaxHighlighting: { override: "always-on", additionalRules: [] } },
      [rule]
    );
    expect(next.syntaxHighlighting).toEqual({ override: "always-on", additionalRules: [rule] });
  });

  it("clears the whole override object when the last rule is removed under 'global'", () => {
    const next = applyAdditionalRules(
      { syntaxHighlighting: { override: "global", additionalRules: [rule] } },
      []
    );
    expect(next.syntaxHighlighting).toBeUndefined();
  });

  it("keeps a non-global override even with no additional rules", () => {
    const next = applyAdditionalRules(
      { syntaxHighlighting: { override: "always-off", additionalRules: [rule] } },
      []
    );
    expect(next.syntaxHighlighting).toEqual({ override: "always-off", additionalRules: [] });
  });

  it("produces a structure that resolves appended after the global rules", () => {
    const globalRule: HighlightRule = {
      id: "g-1",
      name: "global",
      pattern: "bar",
      style: { color: "#00ff00" },
      enabled: true,
      priority: 1,
      builtin: false,
    };
    const options = applyAdditionalRules({}, [rule]);
    const resolved = resolveHighlightingConfig(
      { enabled: true, builtinRules: {}, customRules: [globalRule] },
      options.syntaxHighlighting
    );
    expect(resolved.customRules.map((r) => r.id)).toEqual(["g-1", "custom-1"]);
  });
});

describe("ConnectionTerminalSettings — additional rules editor", () => {
  const rule: HighlightRule = {
    id: "custom-99",
    name: "todos",
    pattern: "TODO",
    style: { color: "#ffaa00" },
    enabled: true,
    priority: 1,
    builtin: false,
  };

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  const byTestId = (id: string) =>
    container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

  const click = (el: Element | null) => act(() => (el as HTMLElement).click());

  it("renders the additional-rules section with an add button and empty state", () => {
    renderWith(emptyOptions);
    expect(byTestId("connection-additional-rule-add")).not.toBeNull();
    expect(byTestId("connection-additional-rules-empty")).not.toBeNull();
  });

  it("lists an existing connection rule", () => {
    renderWith({
      ...emptyOptions,
      syntaxHighlighting: { override: "global", additionalRules: [rule] },
    });
    expect(byTestId(`connection-additional-rule-${rule.id}`)).not.toBeNull();
    expect(byTestId("connection-additional-rules-empty")).toBeNull();
  });

  it("adds a connection rule through the reused CustomRuleEditor", () => {
    const onChange = renderWith(emptyOptions);
    click(byTestId("connection-additional-rule-add"));

    setValue(byTestId("custom-rule-name") as HTMLInputElement, "My Rule");
    setValue(byTestId("custom-rule-pattern") as HTMLInputElement, "WARN");
    click(byTestId("custom-rule-save"));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        syntaxHighlighting: expect.objectContaining({
          override: "global",
          additionalRules: expect.arrayContaining([
            expect.objectContaining({ name: "My Rule", pattern: "WARN" }),
          ]),
        }),
      })
    );
  });

  it("removes a connection rule, clearing the override object when it was the last one", () => {
    const onChange = renderWith({
      ...emptyOptions,
      syntaxHighlighting: { override: "global", additionalRules: [rule] },
    });
    click(byTestId(`connection-additional-rule-delete-${rule.id}`));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ syntaxHighlighting: undefined })
    );
  });
});
