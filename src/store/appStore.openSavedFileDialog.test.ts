import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./appStore";
import { currentSettingsView } from "./settingsBridge";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";

setupSettingsRegion();

describe("openSavedFileDialog store state", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("is closed by default", () => {
    expect(useAppStore.getState().openSavedFileDialog).toEqual({ open: false, filePath: "" });
  });

  it("showOpenSavedFileDialog opens the dialog with the saved file path", () => {
    useAppStore.getState().showOpenSavedFileDialog("/tmp/terminal-output.txt");
    expect(useAppStore.getState().openSavedFileDialog).toEqual({
      open: true,
      filePath: "/tmp/terminal-output.txt",
    });
  });

  it("closeOpenSavedFileDialog resets the dialog state", () => {
    useAppStore.getState().showOpenSavedFileDialog("/tmp/terminal-output.txt");
    useAppStore.getState().closeOpenSavedFileDialog();
    expect(useAppStore.getState().openSavedFileDialog).toEqual({ open: false, filePath: "" });
  });

  it("askOpenSavedFileInTab defaults to true in settings", () => {
    // The field is unset in the projected baseline document (the backend seeds the
    // `true` default, #2404); read sites coalesce a missing value to `true`.
    expect(currentSettingsView().askOpenSavedFileInTab ?? true).toBe(true);
  });
});
