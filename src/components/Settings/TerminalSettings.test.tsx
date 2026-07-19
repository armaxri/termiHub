import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AppSettings } from "@/types/connection";
import { TerminalSettings } from "./TerminalSettings";

vi.mock("@/themes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/themes")>();
  return {
    ...actual,
    applyTheme: vi.fn(),
    onThemeChange: vi.fn(() => vi.fn()),
  };
});

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
    root.render(<TerminalSettings settings={settings} onChange={onChange} />);
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

function scrollbackInput(): HTMLInputElement {
  const label = Array.from(container.querySelectorAll(".settings-form__label")).find(
    (el) => el.textContent === "Scrollback Buffer"
  );
  return label?.closest(".settings-form__field")?.querySelector("input") as HTMLInputElement;
}

describe("TerminalSettings", () => {
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

  function rightClickTrigger(): HTMLButtonElement {
    return container.querySelector(
      '[data-testid="settings-right-click-behavior"]'
    ) as HTMLButtonElement;
  }

  it("renders the right-click behavior dropdown as a shared Select primitive", () => {
    renderWith(defaultSettings);
    const trigger = rightClickTrigger();
    expect(trigger).not.toBeNull();
    expect(trigger.classList.contains("ui-select__trigger")).toBe(true);
  });

  it("shows Platform Default when rightClickBehavior is undefined", () => {
    renderWith(defaultSettings);
    // Radix renders the selected option's label into the trigger.
    expect(rightClickTrigger().textContent).toContain("Platform Default");
  });

  it("reflects contextMenu setting value", () => {
    renderWith({ ...defaultSettings, rightClickBehavior: "contextMenu" });
    expect(rightClickTrigger().textContent).toContain("Context Menu");
  });

  it("reflects quickAction setting value", () => {
    renderWith({ ...defaultSettings, rightClickBehavior: "quickAction" });
    expect(rightClickTrigger().textContent).toContain("Quick Copy/Paste");
  });

  it("lists every right-click option when opened", () => {
    renderWith(defaultSettings);
    const trigger = rightClickTrigger();
    act(() => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const labels = Array.from(document.querySelectorAll('[role="option"]')).map(
      (o) => o.textContent
    );
    expect(labels.join(" ")).toContain("Platform Default");
    expect(labels.join(" ")).toContain("Context Menu");
    expect(labels.join(" ")).toContain("Quick Copy/Paste");
  });

  it("hides right-click behavior when visibleFields excludes it", () => {
    act(() => {
      root.render(
        <TerminalSettings
          settings={defaultSettings}
          onChange={vi.fn()}
          visibleFields={new Set(["cursorStyle"])}
        />
      );
    });

    const labels = Array.from(container.querySelectorAll(".settings-form__label"));
    const rightClickLabel = labels.find((el) => el.textContent === "Right-Click Behavior");
    expect(rightClickLabel).toBeUndefined();
  });

  it("renders the scrollback buffer input", () => {
    renderWith(defaultSettings);
    const labels = Array.from(container.querySelectorAll(".settings-form__label"));
    const label = labels.find((el) => el.textContent === "Scrollback Buffer");
    expect(label).toBeDefined();

    const field = label?.closest(".settings-form__field");
    const input = field?.querySelector("input[type='number']") as HTMLInputElement | null;
    expect(input).not.toBeNull();
  });

  it("shows a blank field when scrollbackBuffer is undefined (#1453)", () => {
    renderWith(defaultSettings);
    // An unset value now reads blank instead of coercing to the built-in default.
    expect(scrollbackInput().value).toBe("");
  });

  it("renders the scrollback buffer through the shared NumberInput primitive (#1453)", () => {
    renderWith(defaultSettings);
    expect(scrollbackInput().classList.contains("ui-input")).toBe(true);
  });

  it("editing the scrollback buffer emits the parsed number (#1453)", () => {
    const onChange = renderWith(defaultSettings);
    setValue(scrollbackInput(), "50000");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ scrollbackBuffer: 50000 }));
  });

  it("clearing the scrollback buffer emits undefined instead of coercing (#1453)", () => {
    const onChange = renderWith({ ...defaultSettings, scrollbackBuffer: 25000 });
    setValue(scrollbackInput(), "");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ scrollbackBuffer: undefined }));
  });

  it("reflects a custom scrollbackBuffer value", () => {
    renderWith({ ...defaultSettings, scrollbackBuffer: 25000 });
    const labels = Array.from(container.querySelectorAll(".settings-form__label"));
    const field = labels
      .find((el) => el.textContent === "Scrollback Buffer")
      ?.closest(".settings-form__field");
    const input = field?.querySelector("input[type='number']") as HTMLInputElement;
    expect(input.value).toBe("25000");
  });

  it("renders the cursor style as a shared Select reflecting the value", () => {
    renderWith({ ...defaultSettings, cursorStyle: "underline" });
    const trigger = container.querySelector(
      '[data-testid="settings-cursor-style"]'
    ) as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    expect(trigger.classList.contains("ui-select__trigger")).toBe(true);
    expect(trigger.textContent).toContain("Underline");
  });

  it("renders the cursor blink control as a shared Toggle and flips onChange", () => {
    const onChange = renderWith({ ...defaultSettings, cursorBlink: true });
    const label = Array.from(container.querySelectorAll(".settings-form__label")).find(
      (el) => el.textContent === "Cursor Blink"
    );
    const toggle = label?.closest(".settings-form__field")?.querySelector('[role="switch"]') as
      | HTMLElement
      | undefined;
    expect(toggle).toBeTruthy();
    expect(toggle!.getAttribute("aria-checked")).toBe("true");
    act(() => toggle!.click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ cursorBlink: false }));
  });

  it("hint text mentions memory", () => {
    renderWith(defaultSettings);
    const labels = Array.from(container.querySelectorAll(".settings-form__label"));
    const field = labels
      .find((el) => el.textContent === "Scrollback Buffer")
      ?.closest(".settings-form__field");
    const hint = field?.querySelector(".settings-form__hint");
    expect(hint?.textContent?.toLowerCase()).toContain("memory");
  });

  it("hides scrollback buffer when visibleFields excludes it", () => {
    act(() => {
      root.render(
        <TerminalSettings
          settings={defaultSettings}
          onChange={vi.fn()}
          visibleFields={new Set(["cursorStyle"])}
        />
      );
    });

    const labels = Array.from(container.querySelectorAll(".settings-form__label"));
    const label = labels.find((el) => el.textContent === "Scrollback Buffer");
    expect(label).toBeUndefined();
  });
});
