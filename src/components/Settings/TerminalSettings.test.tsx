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
    (el) => el.textContent === "Scrollback buffer"
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

  it("shows Platform default when rightClickBehavior is undefined", () => {
    renderWith(defaultSettings);
    // Radix renders the selected option's label into the trigger.
    expect(rightClickTrigger().textContent).toContain("Platform default");
  });

  it("reflects contextMenu setting value", () => {
    renderWith({ ...defaultSettings, rightClickBehavior: "contextMenu" });
    expect(rightClickTrigger().textContent).toContain("Context menu");
  });

  it("reflects quickAction setting value", () => {
    renderWith({ ...defaultSettings, rightClickBehavior: "quickAction" });
    expect(rightClickTrigger().textContent).toContain("Quick copy/paste");
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
    expect(labels.join(" ")).toContain("Platform default");
    expect(labels.join(" ")).toContain("Context menu");
    expect(labels.join(" ")).toContain("Quick copy/paste");
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
    const rightClickLabel = labels.find((el) => el.textContent === "Right-click behavior");
    expect(rightClickLabel).toBeUndefined();
  });

  it("renders the scrollback buffer input", () => {
    renderWith(defaultSettings);
    const labels = Array.from(container.querySelectorAll(".settings-form__label"));
    const label = labels.find((el) => el.textContent === "Scrollback buffer");
    expect(label).toBeDefined();

    const field = label?.closest(".settings-form__field");
    const input = field?.querySelector("input[type='number']") as HTMLInputElement | null;
    expect(input).not.toBeNull();
  });

  it("shows the effective default scrollback as field text with a Default tag (#5632)", () => {
    renderWith(defaultSettings);
    expect(scrollbackInput().value).toBe("10000");
    expect(scrollbackInput().placeholder).toBe("");
    const tag = container.querySelector('[data-testid="settings-scrollback-buffer-default"]');
    expect(tag?.textContent).toBe("Default");
    expect(tag?.closest(".settings-form__label-row")).not.toBeNull();
    expect(container.querySelector('[data-testid="settings-scrollback-buffer-reset"]')).toBeNull();
  });

  it("formats the scrollback hint the way the field shows numbers (#5632)", () => {
    renderWith(defaultSettings);
    const hint = scrollbackInput().closest(".settings-form__field")?.textContent ?? "";
    expect(hint).toContain("1000000");
    expect(hint).not.toMatch(/\d \d{3}/);
  });

  it("resets a custom scrollback back to the default (#5554)", () => {
    const onChange = renderWith({ ...defaultSettings, scrollbackBuffer: 25000 });
    const reset = container.querySelector(
      '[data-testid="settings-scrollback-buffer-reset"]'
    ) as HTMLButtonElement;
    act(() => reset.click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ scrollbackBuffer: undefined }));
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
      .find((el) => el.textContent === "Scrollback buffer")
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
      (el) => el.textContent === "Cursor blink"
    );
    const toggle = label?.closest(".settings-form__field")?.querySelector('[role="switch"]') as
      | HTMLElement
      | undefined;
    expect(toggle).toBeTruthy();
    expect(toggle!.getAttribute("aria-checked")).toBe("true");
    act(() => toggle!.click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ cursorBlink: false }));
  });

  it("renders the command status marks toggle, on by default, and flips onChange (#3415)", () => {
    const onChange = renderWith(defaultSettings);
    const toggle = container.querySelector(
      '[data-testid="settings-terminal-command-decorations"]'
    ) as HTMLElement | null;
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-checked")).toBe("true");
    act(() => toggle!.click());
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ terminalCommandDecorations: false })
    );
  });

  describe("the command-marks group (#5633)", () => {
    const group = () => container.querySelector('[data-testid="settings-command-marks"]');
    const labelsIn = (el: Element | null) =>
      Array.from(el?.querySelectorAll(".settings-form__label") ?? []).map((l) => l.textContent);

    it("puts both command-mark toggles under one Command marks heading", () => {
      renderWith(defaultSettings);
      expect(group()).not.toBeNull();
      expect(group()!.querySelector("h4")?.textContent).toBe("Command marks");
      expect(labelsIn(group())).toEqual([
        "Show command marks",
        "Add shell hook to new sessions automatically",
      ]);
      expect(
        group()!.querySelector('[data-testid="settings-terminal-command-decorations"]')
      ).not.toBeNull();
      expect(
        group()!.querySelector('[data-testid="settings-default-shell-integration"]')
      ).not.toBeNull();
    });

    it("nests the shell-hook toggle under Show command marks", () => {
      renderWith(defaultSettings);
      const hook = group()!.querySelector('[data-testid="settings-default-shell-integration"]')!;
      expect(hook.closest(".settings-panel__nested")).not.toBeNull();
    });

    it("keeps the shell hook off by default and flips defaultShellIntegration", () => {
      const onChange = renderWith(defaultSettings);
      const toggle = container.querySelector(
        '[data-testid="settings-default-shell-integration"]'
      ) as HTMLElement;
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      act(() => toggle.click());
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ defaultShellIntegration: true })
      );
    });

    it("hides the group when search matches neither toggle", () => {
      act(() => {
        root.render(
          <TerminalSettings
            settings={defaultSettings}
            onChange={vi.fn()}
            visibleFields={new Set(["cursorBlink"])}
          />
        );
      });
      expect(group()).toBeNull();
    });
  });

  it("reflects a disabled command status marks setting", () => {
    renderWith({ ...defaultSettings, terminalCommandDecorations: false });
    const toggle = container.querySelector(
      '[data-testid="settings-terminal-command-decorations"]'
    ) as HTMLElement;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("renders the inline images toggle, on by default, and flips onChange (PROD-057)", () => {
    const onChange = renderWith(defaultSettings);
    const toggle = container.querySelector(
      '[data-testid="settings-terminal-inline-images"]'
    ) as HTMLElement | null;
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-checked")).toBe("true");
    act(() => toggle!.click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ terminalInlineImages: false }));
  });

  it("reflects a disabled inline images setting", () => {
    renderWith({ ...defaultSettings, terminalInlineImages: false });
    const toggle = container.querySelector(
      '[data-testid="settings-terminal-inline-images"]'
    ) as HTMLElement;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("renders the combine emoji toggle, off by default, and flips onChange (#4177)", () => {
    const onChange = renderWith(defaultSettings);
    const toggle = container.querySelector(
      '[data-testid="settings-terminal-combine-emoji"]'
    ) as HTMLElement | null;
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-checked")).toBe("false");
    act(() => toggle!.click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ combineEmoji: true }));
  });

  it("labels combine emoji as experimental and warns about cursor drift", () => {
    renderWith({ ...defaultSettings, combineEmoji: true });
    const toggle = container.querySelector(
      '[data-testid="settings-terminal-combine-emoji"]'
    ) as HTMLElement;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    const field = toggle.closest(".settings-form__field");
    expect(field?.querySelector(".settings-form__label")?.textContent).toBe(
      "Combine emoji (experimental)"
    );
    expect(field?.querySelector(".settings-form__hint")?.textContent?.toLowerCase()).toContain(
      "cursor"
    );
  });

  it("hint text mentions memory", () => {
    renderWith(defaultSettings);
    const labels = Array.from(container.querySelectorAll(".settings-form__label"));
    const field = labels
      .find((el) => el.textContent === "Scrollback buffer")
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
    const label = labels.find((el) => el.textContent === "Scrollback buffer");
    expect(label).toBeUndefined();
  });
});
