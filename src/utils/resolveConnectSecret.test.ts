import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/api", () => ({
  isSshKeyEncrypted: vi.fn(),
}));
vi.mock("@/utils/ensureCredentialStoreUnlocked", () => ({
  ensureCredentialStoreUnlocked: vi.fn(),
}));
vi.mock("@/utils/resolveConnectionCredential", () => ({
  resolveConnectionCredential: vi.fn(),
}));

import { isSshKeyEncrypted } from "@/services/api";
import { ensureCredentialStoreUnlocked } from "@/utils/ensureCredentialStoreUnlocked";
import { resolveConnectionCredential } from "@/utils/resolveConnectionCredential";
import type { SettingsSchema } from "@/types/schema";
import { resolveConnectSecret } from "./resolveConnectSecret";

const mockedKeyEncrypted = vi.mocked(isSshKeyEncrypted);
const mockedUnlock = vi.mocked(ensureCredentialStoreUnlocked);
const mockedResolve = vi.mocked(resolveConnectionCredential);

/** SSH-like schema: password field visible only for password auth. */
const SCHEMA: SettingsSchema = {
  groups: [
    {
      key: "conn",
      label: "Connection",
      fields: [
        { key: "host", label: "Host", fieldType: { type: "text" }, required: true },
        { key: "username", label: "User", fieldType: { type: "text" }, required: false },
        {
          key: "password",
          label: "Password",
          fieldType: { type: "password" },
          required: false,
          visibleWhen: { field: "authMethod", equals: "password" },
        },
      ],
    },
  ],
} as unknown as SettingsSchema;

const PASSWORD_SETTINGS = { host: "h.example", username: "alice", authMethod: "password" };
const KEY_SETTINGS = {
  host: "h.example",
  username: "alice",
  authMethod: "key",
  keyPath: "/k",
  savePassword: true,
};

describe("resolveConnectSecret", () => {
  let requestPassword: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    requestPassword = vi.fn();
    mockedUnlock.mockResolvedValue(true);
    mockedResolve.mockResolvedValue({
      password: null,
      usedStoredCredential: false,
      credentialType: "password",
    });
    mockedKeyEncrypted.mockResolvedValue(false);
  });

  it("returns none when no schema is available", async () => {
    const r = await resolveConnectSecret({
      schema: undefined,
      settings: PASSWORD_SETTINGS,
      connectionId: "c1",
      requestPassword,
    });
    expect(r).toEqual({ status: "none" });
  });

  it("returns none when the password is already typed into the form", async () => {
    const r = await resolveConnectSecret({
      schema: SCHEMA,
      settings: { ...PASSWORD_SETTINGS, password: "typed" },
      connectionId: "c1",
      requestPassword,
    });
    expect(r).toEqual({ status: "none" });
    expect(mockedResolve).not.toHaveBeenCalled();
    expect(requestPassword).not.toHaveBeenCalled();
  });

  it("returns none for an unencrypted key", async () => {
    mockedKeyEncrypted.mockResolvedValue(false);
    const r = await resolveConnectSecret({
      schema: SCHEMA,
      settings: KEY_SETTINGS,
      connectionId: "c1",
      requestPassword,
    });
    expect(r).toEqual({ status: "none" });
  });

  it("uses the stored credential without prompting", async () => {
    mockedResolve.mockResolvedValue({
      password: "stored",
      usedStoredCredential: true,
      credentialType: "password",
    });
    const r = await resolveConnectSecret({
      schema: SCHEMA,
      settings: PASSWORD_SETTINGS,
      connectionId: "c1",
      requestPassword,
    });
    expect(mockedUnlock).toHaveBeenCalledWith({ authMethod: "password", savePassword: undefined });
    expect(mockedResolve).toHaveBeenCalledWith("c1", "password", undefined);
    expect(requestPassword).not.toHaveBeenCalled();
    expect(r).toEqual({
      status: "resolved",
      passwordKey: "password",
      secret: "stored",
      source: "stored",
      credentialType: "password",
    });
  });

  it("prompts for a passphrase-protected key when nothing is stored", async () => {
    mockedKeyEncrypted.mockResolvedValue(true);
    requestPassword.mockResolvedValue("pass");
    const r = await resolveConnectSecret({
      schema: SCHEMA,
      settings: KEY_SETTINGS,
      connectionId: "c1",
      requestPassword,
    });
    expect(requestPassword).toHaveBeenCalledWith("h.example", "alice", "", "key_passphrase");
    expect(r).toEqual({
      status: "resolved",
      passwordKey: "password",
      secret: "pass",
      source: "prompt",
      credentialType: "key_passphrase",
    });
  });

  it("treats an unreadable key file as encrypted (prompts)", async () => {
    mockedKeyEncrypted.mockRejectedValue(new Error("unreadable"));
    requestPassword.mockResolvedValue("pass");
    const r = await resolveConnectSecret({
      schema: SCHEMA,
      settings: KEY_SETTINGS,
      connectionId: "c1",
      requestPassword,
    });
    expect(r.status).toBe("resolved");
  });

  it("skips the store entirely when there is no connection id (unsaved)", async () => {
    requestPassword.mockResolvedValue("typed-in-prompt");
    const r = await resolveConnectSecret({
      schema: SCHEMA,
      settings: PASSWORD_SETTINGS,
      connectionId: null,
      requestPassword,
    });
    expect(mockedUnlock).not.toHaveBeenCalled();
    expect(mockedResolve).not.toHaveBeenCalled();
    expect(requestPassword).toHaveBeenCalledWith("h.example", "alice", "", "password");
    expect(r).toMatchObject({ status: "resolved", source: "prompt", secret: "typed-in-prompt" });
  });

  it("returns canceled when the unlock gate is dismissed", async () => {
    mockedUnlock.mockResolvedValue(false);
    const r = await resolveConnectSecret({
      schema: SCHEMA,
      settings: PASSWORD_SETTINGS,
      connectionId: "c1",
      requestPassword,
    });
    expect(r).toEqual({ status: "canceled" });
    expect(requestPassword).not.toHaveBeenCalled();
  });

  it("returns canceled when the password prompt is dismissed", async () => {
    requestPassword.mockResolvedValue(null);
    const r = await resolveConnectSecret({
      schema: SCHEMA,
      settings: PASSWORD_SETTINGS,
      connectionId: "c1",
      requestPassword,
    });
    expect(r).toEqual({ status: "canceled" });
  });
});
