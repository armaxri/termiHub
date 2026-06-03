import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./appStore";

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
    expect(useAppStore.getState().settings.askOpenSavedFileInTab).toBe(true);
  });
});
