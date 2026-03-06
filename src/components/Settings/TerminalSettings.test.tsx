import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AppSettings } from "@/types/connection";
import { TerminalSettings } from "./TerminalSettings";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

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

  it("renders the right-click behavior dropdown", () => {
    renderWith(defaultSettings);
    const labels = Array.from(container.querySelectorAll(".settings-form__label"));
    const rightClickLabel = labels.find((el) => el.textContent === "Right-Click Behavior");
    expect(rightClickLabel).toBeDefined();

    // Find the select within the same field
    const field = rightClickLabel?.closest(".settings-form__field");
    const dropdown = field?.querySelector("select") as HTMLSelectElement | null;
    expect(dropdown).not.toBeNull();
    expect(dropdown!.value).toBe("");
  });

  it("shows Platform Default when rightClickBehavior is undefined", () => {
    renderWith(defaultSettings);
    const labels = Array.from(container.querySelectorAll(".settings-form__label"));
    const field = labels
      .find((el) => el.textContent === "Right-Click Behavior")
      ?.closest(".settings-form__field");
    const dropdown = field?.querySelector("select") as HTMLSelectElement;
    expect(dropdown.value).toBe("");
  });

  it("reflects contextMenu setting value", () => {
    renderWith({ ...defaultSettings, rightClickBehavior: "contextMenu" });
    const labels = Array.from(container.querySelectorAll(".settings-form__label"));
    const field = labels
      .find((el) => el.textContent === "Right-Click Behavior")
      ?.closest(".settings-form__field");
    const dropdown = field?.querySelector("select") as HTMLSelectElement;
    expect(dropdown.value).toBe("contextMenu");
  });

  it("reflects quickAction setting value", () => {
    renderWith({ ...defaultSettings, rightClickBehavior: "quickAction" });
    const labels = Array.from(container.querySelectorAll(".settings-form__label"));
    const field = labels
      .find((el) => el.textContent === "Right-Click Behavior")
      ?.closest(".settings-form__field");
    const dropdown = field?.querySelector("select") as HTMLSelectElement;
    expect(dropdown.value).toBe("quickAction");
  });

  it("calls onChange with quickAction when selecting Quick Copy/Paste", () => {
    const onChange = renderWith(defaultSettings);
    const labels = Array.from(container.querySelectorAll(".settings-form__label"));
    const field = labels
      .find((el) => el.textContent === "Right-Click Behavior")
      ?.closest(".settings-form__field");
    const dropdown = field?.querySelector("select") as HTMLSelectElement;

    act(() => {
      dropdown.value = "quickAction";
      dropdown.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ rightClickBehavior: "quickAction" })
    );
  });

  it("calls onChange with undefined when selecting Platform Default", () => {
    const onChange = renderWith({ ...defaultSettings, rightClickBehavior: "contextMenu" });
    const labels = Array.from(container.querySelectorAll(".settings-form__label"));
    const field = labels
      .find((el) => el.textContent === "Right-Click Behavior")
      ?.closest(".settings-form__field");
    const dropdown = field?.querySelector("select") as HTMLSelectElement;

    act(() => {
      dropdown.value = "";
      dropdown.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ rightClickBehavior: undefined })
    );
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
});
