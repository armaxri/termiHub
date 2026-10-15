import { describe, it, expect } from "vitest";
import { changedSecretLabels, clearDraftSecrets, restoreDraftSecrets } from "./formDraftSecrets";
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

describe("changedSecretLabels (#4758)", () => {
  it("names only the secrets that differ from the saved document, at any depth", () => {
    const saved = { apiToken: "saved", plugin: { clientSecret: "s" }, fontSize: 13 };
    const edited = { apiToken: "saved", plugin: { clientSecret: "typed" }, fontSize: 18 };
    expect(changedSecretLabels(edited, saved)).toEqual(["Client secret"]);
  });

  it("names a secret typed into a field the saved document lacks, or one cleared", () => {
    expect(changedSecretLabels({ apiToken: "typed" }, {})).toEqual(["API token"]);
    expect(changedSecretLabels({ apiToken: "" }, { apiToken: "saved" })).toEqual(["API token"]);
    expect(changedSecretLabels({ apiToken: "" }, {})).toEqual([]);
  });
});

describe("restoreDraftSecrets (#4758)", () => {
  it("takes every secret string from the saved document instead of leaving it empty", () => {
    const draft = { fontSize: 18, apiToken: "", plugin: { clientSecret: "" }, hops: [{ pin: "" }] };
    const saved = {
      fontSize: 13,
      apiToken: "a",
      plugin: { clientSecret: "b" },
      hops: [{ pin: "c" }],
    };
    expect(restoreDraftSecrets(draft, saved)).toEqual({
      fontSize: 18,
      apiToken: "a",
      plugin: { clientSecret: "b" },
      hops: [{ pin: "c" }],
    });
  });

  it("leaves a secret out when nothing is saved for it", () => {
    expect(restoreDraftSecrets({ fontSize: 18, apiToken: "" }, { fontSize: 13 })).toEqual({
      fontSize: 18,
    });
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
