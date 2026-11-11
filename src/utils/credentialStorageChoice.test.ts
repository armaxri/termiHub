import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/store/appStore";
import type { CredentialStoreStatusInfo } from "@/types/credential";
import {
  credentialStorageNeedsChoice,
  credentialStoreActive,
  ensureCredentialStorageForSave,
} from "./credentialStorageChoice";

const fresh: CredentialStoreStatusInfo = {
  mode: "none",
  status: "unavailable",
  storageChosen: false,
};

describe("credentialStorageNeedsChoice (#5187)", () => {
  it("asks only while storage is the untouched none default", () => {
    expect(credentialStorageNeedsChoice(fresh)).toBe(true);
  });

  it("never asks once a choice was recorded (including Don't save)", () => {
    expect(credentialStorageNeedsChoice({ ...fresh, storageChosen: true })).toBe(false);
  });

  it("treats an install with an active store as chosen", () => {
    expect(
      credentialStorageNeedsChoice({ mode: "os_keychain", status: "unlocked", storageChosen: true })
    ).toBe(false);
    // Even if a status ever reported it unchosen, an active store is never re-asked.
    expect(
      credentialStorageNeedsChoice({
        mode: "master_password",
        status: "locked",
        storageChosen: false,
      })
    ).toBe(false);
  });

  it("does not ask while the status is unknown", () => {
    expect(credentialStorageNeedsChoice(null)).toBe(false);
    expect(credentialStorageNeedsChoice({ mode: "none", status: "unavailable" })).toBe(false);
  });
});

describe("ensureCredentialStorageForSave (#5187)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("opens the chooser on the first save and resolves true once a store is chosen", async () => {
    useAppStore.setState({ credentialStoreStatus: fresh });

    const pending = ensureCredentialStorageForSave();
    expect(useAppStore.getState().storageChooserOpen).toBe(true);
    useAppStore.getState().resolveStorageChoice("os_keychain");

    await expect(pending).resolves.toBe(true);
    expect(useAppStore.getState().storageChooserOpen).toBe(false);
  });

  it("resolves false when the chooser is canceled", async () => {
    useAppStore.setState({ credentialStoreStatus: fresh });

    const pending = ensureCredentialStorageForSave();
    useAppStore.getState().resolveStorageChoice("canceled");

    await expect(pending).resolves.toBe(false);
  });

  it("resolves false when the user chooses not to save", async () => {
    useAppStore.setState({ credentialStoreStatus: fresh });

    const pending = ensureCredentialStorageForSave();
    useAppStore.getState().resolveStorageChoice("none");

    await expect(pending).resolves.toBe(false);
  });

  it("does not ask on a later save once a store is active", async () => {
    useAppStore.setState({
      credentialStoreStatus: { mode: "os_keychain", status: "unlocked", storageChosen: true },
    });

    await expect(ensureCredentialStorageForSave()).resolves.toBe(true);
    expect(useAppStore.getState().storageChooserOpen).toBe(false);
  });

  it("does not ask after Don't save was chosen", async () => {
    useAppStore.setState({ credentialStoreStatus: { ...fresh, storageChosen: true } });

    await expect(ensureCredentialStorageForSave()).resolves.toBe(false);
    expect(useAppStore.getState().storageChooserOpen).toBe(false);
  });

  it("settles every save waiting on the single chooser", async () => {
    useAppStore.setState({ credentialStoreStatus: fresh });

    const first = ensureCredentialStorageForSave();
    const second = ensureCredentialStorageForSave();
    useAppStore.getState().resolveStorageChoice("master_password");

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });
});

describe("credentialStoreActive", () => {
  it("is true for any mode but none", () => {
    expect(credentialStoreActive(fresh)).toBe(false);
    expect(credentialStoreActive(null)).toBe(false);
    expect(credentialStoreActive({ mode: "os_keychain", status: "unlocked" })).toBe(true);
  });
});
