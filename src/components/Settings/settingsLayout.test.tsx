/**
 * The shared settings layout primitives (#5843): compact number inputs sized to
 * their value range with a unit, a plain "Default" marker that is not a pill,
 * the "?" help tip beside a label, and one centred page width for the search
 * bar, nav and content.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRoot, Root } from "react-dom/client";
import { Input } from "@/components/ui";
import { DefaultNumberInput } from "./DefaultNumberInput";
import { SettingsNumberInput } from "./SettingsNumberInput";
import { SettingDefaultMarker } from "./SettingDefaultMarker";
import { SettingsField } from "./SettingsField";
import { MAX_NUMBER_CHARS, MIN_NUMBER_CHARS, settingsNumberChars } from "./settingsNumber";

const here = dirname(fileURLToPath(import.meta.url));
const css = (file: string) => readFileSync(join(here, file), "utf8");
const variablesCss = readFileSync(join(here, "../../styles/variables.css"), "utf8");

/** Body of the first CSS rule whose selector list is exactly `selector`. */
function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(source)?.[1] ?? "";
}

let container: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode) {
  act(() => root.render(node));
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return container.querySelector<T>(`[data-testid="${id}"]`);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("settingsNumberChars (#5843)", () => {
  it("sizes the input to the widest value of its range", () => {
    expect(settingsNumberChars(100, 1000000)).toBe(7);
    expect(settingsNumberChars(10, 500)).toBe(MIN_NUMBER_CHARS);
    expect(settingsNumberChars(8, 32)).toBe(MIN_NUMBER_CHARS);
  });

  it("counts the step's decimals", () => {
    expect(settingsNumberChars(0.8, 2.0, 0.1)).toBe(MIN_NUMBER_CHARS);
    expect(settingsNumberChars(0, 10000, 0.01)).toBe(8);
  });

  it("caps an unbounded or huge range", () => {
    expect(settingsNumberChars()).toBe(MAX_NUMBER_CHARS);
    expect(settingsNumberChars(0, 1e15)).toBe(MAX_NUMBER_CHARS);
  });
});

describe("compact number inputs (#5843)", () => {
  it("DefaultNumberInput shows its unit and names it in the description", () => {
    render(
      <DefaultNumberInput
        value={undefined}
        defaultValue={14}
        min={8}
        max={32}
        unit="px"
        onChange={vi.fn()}
        aria-describedby="hint-id"
        data-testid="n"
      />
    );
    const input = byId<HTMLInputElement>("n-input")!;
    const unit = byId("n-unit")!;
    expect(unit.textContent).toBe("px");
    expect(input.classList.contains("settings-number__input")).toBe(true);
    expect(input.getAttribute("aria-describedby")?.split(" ")).toEqual(["hint-id", unit.id]);
    const frame = input.closest<HTMLElement>(".settings-number")!;
    expect(frame.style.getPropertyValue("--settings-number-chars")).toBe("4");
  });

  it("DefaultNumberInput without a unit renders no unit and no extra description", () => {
    render(<DefaultNumberInput value={5} defaultValue={1} onChange={vi.fn()} data-testid="n" />);
    expect(byId("n-unit")).toBeNull();
    expect(byId("n-input")?.hasAttribute("aria-describedby")).toBe(false);
  });

  it("SettingsNumberInput keeps the NumberInput value contract", () => {
    const onValueChange = vi.fn();
    render(
      <SettingsNumberInput
        value={50}
        min={10}
        max={500}
        unit="sessions"
        onValueChange={onValueChange}
        data-testid="limit"
      />
    );
    const input = byId<HTMLInputElement>("limit")!;
    expect(input.value).toBe("50");
    expect(byId("limit-unit")?.textContent).toBe("sessions");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "120");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onValueChange).toHaveBeenLastCalledWith(120);
  });

  it("the input width comes from the character count, not the column", () => {
    const body = rule(css("SettingsNumberFrame.css"), ".settings-number__input.ui-input");
    expect(body).toContain("var(--settings-number-chars) * 1ch");
    expect(body).toContain("var(--settings-number-chrome)");
    expect(variablesCss).toMatch(/--settings-number-chrome:\s*\d+px/);
  });
});

describe("the Default marker and the reset (#5843)", () => {
  it("is plain text at the default, a labelled reset button once overridden", () => {
    const onReset = vi.fn();
    render(<SettingDefaultMarker isDefault onReset={onReset} name="Font size" data-testid="m" />);
    const tag = byId("m-default")!;
    expect(tag.tagName).toBe("SPAN");
    expect(tag.textContent).toBe("Default");
    expect(byId("m-reset")).toBeNull();

    render(
      <SettingDefaultMarker
        isDefault={false}
        onReset={onReset}
        name="Font size"
        defaultText="14"
        data-testid="m"
      />
    );
    const reset = byId<HTMLButtonElement>("m-reset")!;
    expect(reset.tagName).toBe("BUTTON");
    expect(reset.textContent).toContain("Reset to default");
    expect(reset.getAttribute("aria-label")).toBe("Reset font size to the default (14)");
    act(() => reset.click());
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("draws the Default tag without a border or fill", () => {
    const body = rule(css("SettingDefaultMarker.css"), ".settings-default-marker__tag");
    expect(body).not.toBe("");
    expect(body).not.toMatch(/border|background|padding/);
    expect(body).toContain("color: var(--text-secondary)");
  });
});

describe("the help tip (#5843)", () => {
  it("sits on the label row and shows its details on focus", () => {
    render(
      <SettingsField
        label="Scrollback buffer"
        hint="Lines kept (100–1000000)."
        help="Roughly 1–2 MB per 10000 lines."
        helpTestId="h"
      >
        <Input data-testid="c" />
      </SettingsField>
    );
    const help = byId<HTMLButtonElement>("h")!;
    expect(help.closest(".settings-form__label-row")).not.toBeNull();
    expect(help.getAttribute("aria-label")).toBe("More about scrollback buffer");
    expect(document.body.textContent).not.toContain("Roughly 1–2 MB");
    act(() => help.focus());
    expect(document.body.textContent).toContain("Roughly 1–2 MB");
  });

  it("renders no help button without help", () => {
    render(
      <SettingsField label="Name" helpTestId="h">
        <Input />
      </SettingsField>
    );
    expect(byId("h")).toBeNull();
    expect(container.querySelector(".settings-form__label-row")).toBeNull();
  });
});

describe("one centred settings page width (#5843)", () => {
  const panel = css("SettingsPanel.css");

  it("caps the search bar and the body to one centred width token", () => {
    const body = rule(panel, ".settings-search,\n.settings-panel__body");
    expect(body).toContain("max-width: var(--settings-page-max-width)");
    expect(body).toContain("margin-inline: auto");
  });

  it("derives the page width from the nav and content widths", () => {
    expect(variablesCss).toMatch(/--settings-nav-width:\s*180px/);
    expect(variablesCss).toMatch(/--settings-content-max-width:\s*640px/);
    expect(variablesCss).toMatch(
      /--settings-page-max-width:\s*calc\(\s*var\(--settings-nav-width\)\s*\+\s*var\(--settings-content-max-width\)\s*\)/
    );
    expect(rule(css("SettingsNav.css"), ".settings-nav")).toContain(
      "width: var(--settings-nav-width)"
    );
    expect(rule(panel, ".settings-panel__content")).toContain(
      "max-width: var(--settings-content-max-width)"
    );
  });
});
