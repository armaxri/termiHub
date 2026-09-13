/**
 * OBS-009 — the in-app log-file verbosity control.
 *
 * Choosing a level must (1) persist it through the normal settings document
 * (`onChange` with `fileLogLevel`) so it survives a restart, and (2) apply it
 * live via the `set_file_log_level` command. The Radix `Select` primitive is
 * replaced with a native `<select>` here so the change is driven deterministically
 * in jsdom — the primitive itself is covered by `Select.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AppSettings } from "@/types/connection";
import { GeneralSettings } from "./GeneralSettings";
import { setFileLogLevel } from "@/services/api";
import { TooltipProvider } from "@/components/ui";

vi.mock("@/utils/shell-detection", () => ({
  detectAvailableShells: vi.fn().mockResolvedValue([]),
  getWslDistroName: vi.fn(() => null),
}));

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
  frontendError: vi.fn(),
}));

vi.mock("@/services/api", () => ({
  getLogFilePath: vi
    .fn()
    .mockResolvedValue("/home/u/.local/share/com.termihub.app/logs/termihub.log"),
  setFileLogLevel: vi.fn().mockResolvedValue(undefined),
}));

// Replace the Radix Select with a native <select> for deterministic control;
// keep every other primitive real.
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    Select: ({
      value,
      onChange,
      options,
      ...rest
    }: {
      value?: string;
      onChange: (value: string) => void;
      options?: { value: string; label: string }[];
      [key: string]: unknown;
    }) => (
      <select
        data-testid={rest["data-testid"] as string}
        aria-label={rest["aria-label"] as string}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options
          ? options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))
          : // The other Select in this section (default shell) uses the children
            // form; render a lone matching option so React does not warn.
            value && <option value={value}>{value}</option>}
      </select>
    ),
  };
});

const BASE_SETTINGS: AppSettings = {
  version: "1",
  externalConnectionFiles: [],
  powerMonitoringEnabled: true,
  fileBrowserEnabled: true,
};

let container: HTMLDivElement;
let root: Root;

function change(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("GeneralSettings — log file verbosity (OBS-009)", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("persists the chosen level and applies it live", async () => {
    let current: AppSettings = BASE_SETTINGS;
    const onChange = (update: AppSettings | ((prev: AppSettings) => AppSettings)) => {
      current = typeof update === "function" ? update(current) : update;
    };

    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <GeneralSettings settings={BASE_SETTINGS} onChange={onChange} />
        </TooltipProvider>
      );
    });

    const select = container.querySelector<HTMLSelectElement>(
      "[data-testid='settings-file-log-level']"
    );
    expect(select).not.toBeNull();
    // Defaults to Info when unset.
    expect(select!.value).toBe("info");

    change(select!, "debug");

    // Persisted into the settings document…
    expect(current.fileLogLevel).toBe("debug");
    // …and applied live via the command.
    expect(vi.mocked(setFileLogLevel)).toHaveBeenCalledWith("debug");
  });
});
