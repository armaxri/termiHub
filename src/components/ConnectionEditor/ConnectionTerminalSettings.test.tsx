import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionTerminalSettings } from "./ConnectionTerminalSettings";
import type { TerminalOptions } from "@/types/terminal";

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

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

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
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, scrollbackBuffer: 50000 },
    });
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
