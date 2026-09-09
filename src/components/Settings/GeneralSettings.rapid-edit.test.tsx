/**
 * Regression test for #2680 — GeneralSettings stale-closure onChange.
 *
 * Both General inputs used to spread the captured `settings` render snapshot
 * (`onChange({ ...settings, <field>: value })`). Two edits fired back-to-back
 * against the *same* snapshot (before React re-renders GeneralSettings with the
 * first edit folded in) meant the second call rebuilt from the stale snapshot and
 * dropped the earlier field's new value.
 *
 * This renders GeneralSettings with a **fixed** `settings` prop — never handing
 * the accumulated state back as a prop — which is exactly the "before a re-render"
 * window. A parent-faithful resolver (object or functional-updater, mirroring
 * `SettingsPanel.handleSettingsChange`) accumulates the emitted changes. It fails
 * on the pre-fix component (the second field clobbers the first) and passes once
 * the fields route through the functional-updater form.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AppSettings } from "@/types/connection";
import { TooltipProvider } from "@/components/ui";
import { GeneralSettings } from "./GeneralSettings";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
}));

vi.mock("@/utils/shell-detection", () => ({
  detectAvailableShells: vi.fn().mockResolvedValue([]),
  getWslDistroName: vi.fn(() => null),
}));

vi.mock("@/utils/restoreMode", () => ({
  resolveRestoreMode: vi.fn().mockResolvedValue("ask"),
}));

vi.mock("@/hooks/useSshKeyFiles", () => ({
  useSshKeyFiles: () => ({ keyFiles: [], isLoading: false, sshDirPath: "" }),
}));

vi.mock("@/services/api", () => ({
  validateSshKey: vi.fn().mockResolvedValue({ status: "valid", message: "" }),
}));

const BASE_SETTINGS: AppSettings = {
  version: "1",
  externalConnectionFiles: [],
  powerMonitoringEnabled: true,
  fileBrowserEnabled: true,
};

let container: HTMLDivElement;
let root: Root;

/** Set a controlled input's value the way a real keystroke would, firing React's onChange. */
function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("GeneralSettings — rapid back-to-back edits (#2680)", () => {
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

  it("keeps both fields when two edits fire before a re-render", () => {
    // Parent-faithful resolver: accepts either a full document or a functional
    // updater, exactly like SettingsPanel.handleSettingsChange. `settings` is held
    // FIXED (never re-fed as a prop), so GeneralSettings never re-renders with the
    // first edit folded in — the stale-snapshot window from #2680.
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

    const userInput = container.querySelector<HTMLInputElement>(
      "[data-testid='settings-default-user']"
    );
    const keyInput = container.querySelector<HTMLInputElement>(
      "[data-testid='general-settings-key-path-input']"
    );
    expect(userInput).not.toBeNull();
    expect(keyInput).not.toBeNull();

    setValue(userInput!, "alice");
    setValue(keyInput!, "/home/alice/.ssh/id_ed25519");

    expect(current.defaultUser).toBe("alice");
    expect(current.defaultSshKeyPath).toBe("/home/alice/.ssh/id_ed25519");
  });
});
