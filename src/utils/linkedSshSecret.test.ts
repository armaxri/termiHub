/**
 * Asking for the secret of a VNC connection's linked SSH file route (#4265):
 * the usual password prompt, its "Save password" box writing to the linked
 * connection's credential entry, the unlock gate for a locked store, and a
 * cancel that asks nothing more.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAppStore } from "@/store/appStore";
import { storeCredential } from "@/services/api";
import { ensureCredentialStoreUnlocked } from "@/utils/ensureCredentialStoreUnlocked";
import type { LinkedSecretRequest } from "@/types/generated/LinkedSecretRequest";
import { isPasswordPromptAbort } from "@/store/slices/passwordPromptSlice";
import { askLinkedSshSecret } from "./linkedSshSecret";

vi.mock("@/services/api", () => ({
  storeCredential: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/utils/ensureCredentialStoreUnlocked", () => ({
  ensureCredentialStoreUnlocked: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

const mockedStore = vi.mocked(storeCredential);
const mockedUnlock = vi.mocked(ensureCredentialStoreUnlocked);

const REQUEST: LinkedSecretRequest = {
  connectionId: "Lab/Tiger",
  sourceFile: null,
  kind: "password",
  authMethod: "password",
  host: "tiger-box",
  username: "arne",
  storeLocked: false,
  canSave: true,
  rejected: false,
};

/** A prompt that answers `answer`, with the Save box checked when `save`. */
function prompt(answer: string | null, save = false) {
  return vi.fn(async () => {
    useAppStore.setState({ passwordPromptShouldSave: answer !== null && save });
    return answer;
  });
}

describe("askLinkedSshSecret", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("asks with the usual prompt for the linked host and account", async () => {
    const requestPassword = prompt("typed");
    const outcome = await askLinkedSshSecret(REQUEST, requestPassword);
    expect(outcome).toEqual({ status: "entered", secret: "typed" });
    expect(requestPassword).toHaveBeenCalledWith("tiger-box", "arne", "", "password");
    expect(mockedStore).not.toHaveBeenCalled();
    expect(mockedUnlock).not.toHaveBeenCalled();
  });

  it("saves the secret under the linked connection when Save password is checked", async () => {
    const requestPassword = prompt("typed", true);
    await askLinkedSshSecret(
      { ...REQUEST, kind: "key_passphrase", sourceFile: "/team/connections.json" },
      requestPassword
    );
    expect(requestPassword).toHaveBeenCalledWith("tiger-box", "arne", "", "key_passphrase");
    expect(mockedStore).toHaveBeenCalledWith(
      "Lab/Tiger",
      "key_passphrase",
      "typed",
      "/team/connections.json"
    );
  });

  it("offers no Save box for a shared credential and never saves it", async () => {
    const requestPassword = prompt("typed", true);
    await askLinkedSshSecret({ ...REQUEST, canSave: false }, requestPassword);
    expect(requestPassword).toHaveBeenCalledWith("tiger-box", "arne", "", "password", {
      allowSave: false,
    });
    expect(mockedStore).not.toHaveBeenCalled();
  });

  it("forwards the caller's abort signal to the prompt (#4312)", async () => {
    const requestPassword = prompt("typed");
    const controller = new AbortController();
    await askLinkedSshSecret({ ...REQUEST, canSave: false }, requestPassword, controller.signal);
    expect(requestPassword).toHaveBeenCalledWith("tiger-box", "arne", "", "password", {
      allowSave: false,
      signal: controller.signal,
    });
  });

  it("rejects, saving nothing, when the prompt is aborted (#4312)", async () => {
    const controller = new AbortController();
    const pending = askLinkedSshSecret(
      REQUEST,
      useAppStore.getState().requestPassword,
      controller.signal
    );
    controller.abort();
    await expect(pending).rejects.toSatisfy(isPasswordPromptAbort);
    expect(useAppStore.getState().passwordPromptQueue).toHaveLength(0);
    expect(mockedStore).not.toHaveBeenCalled();
  });

  it("reports a cancel and saves nothing", async () => {
    const outcome = await askLinkedSshSecret(REQUEST, prompt(null));
    expect(outcome).toEqual({ status: "canceled" });
    expect(mockedStore).not.toHaveBeenCalled();
  });

  it("says why when the entered secret was rejected", async () => {
    const requestPassword = prompt("again");
    await askLinkedSshSecret({ ...REQUEST, rejected: true }, requestPassword);
    expect(requestPassword).toHaveBeenCalledWith(
      "tiger-box",
      "arne",
      "Password was rejected — please re-enter.",
      "password"
    );
  });

  it("unlocks a locked store first instead of asking for the secret", async () => {
    const requestPassword = prompt("typed");
    const outcome = await askLinkedSshSecret({ ...REQUEST, storeLocked: true }, requestPassword);
    expect(outcome).toEqual({ status: "unlocked" });
    expect(mockedUnlock).toHaveBeenCalledWith({ authMethod: "password", savePassword: true });
    expect(requestPassword).not.toHaveBeenCalled();
  });

  it("treats a dismissed unlock dialog as a cancel", async () => {
    mockedUnlock.mockResolvedValueOnce(false);
    const requestPassword = prompt("typed");
    const outcome = await askLinkedSshSecret({ ...REQUEST, storeLocked: true }, requestPassword);
    expect(outcome).toEqual({ status: "canceled" });
    expect(requestPassword).not.toHaveBeenCalled();
  });
});
