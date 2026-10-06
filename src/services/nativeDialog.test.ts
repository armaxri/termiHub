import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open as pluginOpen, save as pluginSave } from "@tauri-apps/plugin-dialog";

import { TEST_BRIDGE_GLOBAL_KEY } from "@/testbridge/testMode";
import { clearNativeDialogStubs, open, save, setNativeDialogStub } from "./nativeDialog";

const globals = window as unknown as Record<string, unknown>;

function enableBridge(): void {
  globals[TEST_BRIDGE_GLOBAL_KEY] = true;
}

describe("nativeDialog (#4122)", () => {
  beforeEach(() => {
    vi.mocked(pluginOpen).mockReset();
    vi.mocked(pluginSave).mockReset();
  });

  afterEach(() => {
    clearNativeDialogStubs();
    delete globals[TEST_BRIDGE_GLOBAL_KEY];
    vi.unstubAllEnvs();
  });

  it("passes save straight through to the plugin when nothing is stubbed", async () => {
    vi.mocked(pluginSave).mockResolvedValue("/picked/by/user.json");
    const options = { defaultPath: "export.json" };

    await expect(save(options)).resolves.toBe("/picked/by/user.json");
    expect(pluginSave).toHaveBeenCalledWith(options);
  });

  it("passes open straight through to the plugin when nothing is stubbed", async () => {
    vi.mocked(pluginOpen).mockResolvedValue("/picked/by/user.json");
    const options = { multiple: false, directory: false };

    await expect(open(options)).resolves.toBe("/picked/by/user.json");
    expect(pluginOpen).toHaveBeenCalledWith(options);
  });

  it("answers the next save from a stub without showing a dialog", async () => {
    enableBridge();
    setNativeDialogStub("save", "/tmp/stubbed/export.json");

    await expect(save({ defaultPath: "export.json" })).resolves.toBe("/tmp/stubbed/export.json");
    expect(pluginSave).not.toHaveBeenCalled();
  });

  it("uses a stub once: the dialog after it is real again", async () => {
    enableBridge();
    vi.mocked(pluginSave).mockResolvedValue("/real.json");
    setNativeDialogStub("save", "/tmp/stubbed.json");

    await save();
    await expect(save()).resolves.toBe("/real.json");
  });

  it("answers a stubbed cancel with null", async () => {
    enableBridge();
    setNativeDialogStub("open", null);

    await expect(open({ multiple: false })).resolves.toBeNull();
    expect(pluginOpen).not.toHaveBeenCalled();
  });

  it("wraps a stubbed open path in an array for a multiple pick", async () => {
    enableBridge();
    setNativeDialogStub("open", "/tmp/a.json");

    await expect(open({ multiple: true })).resolves.toEqual(["/tmp/a.json"]);
  });

  it("returns a stubbed directory pick as the plain path", async () => {
    enableBridge();
    setNativeDialogStub("open", "/tmp/portable");

    await expect(open({ directory: true })).resolves.toBe("/tmp/portable");
  });

  it("keeps open and save stubs apart", async () => {
    enableBridge();
    vi.mocked(pluginOpen).mockResolvedValue("/real-open.json");
    setNativeDialogStub("save", "/tmp/save.json");

    await expect(open()).resolves.toBe("/real-open.json");
    await expect(save()).resolves.toBe("/tmp/save.json");
  });

  it("replaces a pending stub with a newer one", async () => {
    enableBridge();
    setNativeDialogStub("save", "/tmp/old.json");
    setNativeDialogStub("save", "/tmp/new.json");

    await expect(save()).resolves.toBe("/tmp/new.json");
  });

  it("refuses to set a stub when the test bridge is off", () => {
    expect(() => setNativeDialogStub("save", "/tmp/x.json")).toThrow(/not enabled/);
  });

  it("ignores a pending stub once the bridge is off, and drops it", async () => {
    enableBridge();
    setNativeDialogStub("save", "/tmp/stubbed.json");
    delete globals[TEST_BRIDGE_GLOBAL_KEY];
    vi.mocked(pluginSave).mockResolvedValue("/real.json");

    await expect(save()).resolves.toBe("/real.json");
    enableBridge();
    vi.mocked(pluginSave).mockResolvedValue("/real-again.json");
    await expect(save()).resolves.toBe("/real-again.json");
  });

  it("never honours a stub in a production build without VITE_TEST_BRIDGE", async () => {
    enableBridge();
    setNativeDialogStub("save", "/tmp/stubbed.json");
    vi.stubEnv("PROD", true);
    vi.stubEnv("VITE_TEST_BRIDGE", "");
    vi.mocked(pluginSave).mockResolvedValue("/real.json");

    await expect(save()).resolves.toBe("/real.json");
    expect(pluginSave).toHaveBeenCalledTimes(1);
  });
});
