import { describe, it, expect } from "vitest";
import { clearDraftSecrets } from "./formDraftSecrets";
import { isSecretKeyName } from "./redactLogText";
import type { SettingsSchema } from "@/types/schema";

const SCHEMA: SettingsSchema = {
  groups: [
    {
      key: "conn",
      label: "Connection",
      fields: [
        { key: "host", label: "Host", fieldType: { type: "text" }, required: true },
        { key: "password", label: "Password", fieldType: { type: "password" }, required: false },
        // A plugin's secret field whose key names no secret word.
        {
          key: "vaultKey2",
          label: "Vault unlock",
          fieldType: { type: "password" },
          required: false,
        },
      ],
    },
  ],
} as unknown as SettingsSchema;

describe("clearDraftSecrets (#4500)", () => {
  it("clears schema password fields and labels them as the form does", () => {
    const { values, cleared } = clearDraftSecrets(
      { host: "h", password: "hunter2", vaultKey2: "v" },
      SCHEMA
    );
    expect(values).toEqual({ host: "h", password: "", vaultKey2: "" });
    expect(cleared).toEqual(["Password", "Vault unlock"]);
  });

  it("clears secret-named strings at any depth, including jump-host hops", () => {
    const { values, cleared } = clearDraftSecrets({
      sshPassword: "a",
      apiToken: "b",
      proxyJump: [{ host: "bastion", password: "c" }],
      tabGroupDefs: [{ inlineConfig: { config: { keyPassphrase: "d" } } }],
    });
    expect(values).toEqual({
      sshPassword: "",
      apiToken: "",
      proxyJump: [{ host: "bastion", password: "" }],
      tabGroupDefs: [{ inlineConfig: { config: { keyPassphrase: "" } } }],
    });
    expect(cleared).toEqual(["SSH password", "API token", "Jump host password", "Key passphrase"]);
  });

  it("keeps non-string flags and non-secret keys, and names empty secrets nowhere", () => {
    const draft = {
      savePassword: true,
      credentialRef: "cred-1",
      keyPath: "~/.ssh/id",
      password: "",
    };
    const { values, cleared } = clearDraftSecrets(draft);
    expect(values).toEqual(draft);
    expect(cleared).toEqual([]);
  });

  it("does not mutate its input", () => {
    const draft = { password: "x", nested: { token: "y" } };
    clearDraftSecrets(draft);
    expect(draft).toEqual({ password: "x", nested: { token: "y" } });
  });
});

describe("isSecretKeyName", () => {
  it.each(["password", "sshPassword", "keyPassphrase", "apiToken", "client_secret", "privateKey"])(
    "treats %s as a secret",
    (key) => expect(isSecretKeyName(key)).toBe(true)
  );

  it.each(["host", "credentialRef", "keyPath", "authMethod", "name"])(
    "does not treat %s as a secret",
    (key) => expect(isSecretKeyName(key)).toBe(false)
  );
});
