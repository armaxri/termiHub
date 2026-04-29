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
});
