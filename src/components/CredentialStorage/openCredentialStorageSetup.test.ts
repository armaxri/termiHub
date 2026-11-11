import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/store/appStore";
import { openCredentialStorageSetup } from "./openCredentialStorageSetup";

describe("openCredentialStorageSetup", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("opens the first-use chooser while no storage choice exists (#5187)", () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "none", status: "unavailable", storageChosen: false },
    });
    openCredentialStorageSetup();
    expect(useAppStore.getState().storageChooserOpen).toBe(true);
    expect(useAppStore.getState().pendingSettingsCategory).not.toBe("security");
    useAppStore.getState().resolveStorageChoice("canceled");
  });

  it("opens Settings ▸ Security once a choice was made (#5186)", () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "none", status: "unavailable", storageChosen: true },
    });
    openCredentialStorageSetup();
    expect(useAppStore.getState().storageChooserOpen).toBe(false);
    expect(useAppStore.getState().pendingSettingsCategory).toBe("security");
  });
});
