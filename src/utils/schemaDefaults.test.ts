import { describe, it, expect } from "vitest";
import type { SettingsSchema, SettingsField } from "@/types/schema";
import { buildDefaults, isFieldVisible, findPasswordPromptInfo } from "./schemaDefaults";

function textField(key: string, opts: Partial<SettingsField> = {}): SettingsField {
  return {
    key,
    label: key,
    fieldType: { type: "text" },
    required: false,
    ...opts,
  };
}

function passwordField(key: string, opts: Partial<SettingsField> = {}): SettingsField {
  return {
    key,
    label: key,
    fieldType: { type: "password" },
    required: false,
    ...opts,
  };
}

const SSH_LIKE_SCHEMA: SettingsSchema = {
  groups: [
    {
      key: "connection",
      label: "Connection",
      fields: [
        textField("host", { required: true, placeholder: "example.com" }),
        {
          key: "port",
          label: "Port",
          fieldType: { type: "port" },
          required: true,
          default: 22,
        },
        textField("username", { required: true }),
      ],
    },
    {
      key: "authentication",
      label: "Authentication",
      fields: [
        {
          key: "authMethod",
          label: "Auth Method",
          fieldType: {
            type: "select",
            options: [
              { value: "key", label: "SSH Key" },
              { value: "password", label: "Password" },
              { value: "agent", label: "SSH Agent" },
            ],
          },
          required: true,
          default: "key",
        },
        {
          key: "keyPath",
          label: "Key Path",
          fieldType: { type: "filePath", kind: "file" },
          required: false,
          visibleWhen: { field: "authMethod", equals: "key" },
        },
        passwordField("password", {
          visibleWhen: { field: "authMethod", equals: "password" },
        }),
      ],
    },
  ],
};

const DOCKER_LIKE_SCHEMA: SettingsSchema = {
  groups: [
    {
      key: "container",
      label: "Container",
      fields: [
        textField("image", { required: true, default: "ubuntu:22.04" }),
        {
          key: "envVars",
          label: "Environment Variables",
          fieldType: { type: "keyValueList" },
          required: false,
        },
        {
          key: "volumes",
          label: "Volumes",
          fieldType: {
            type: "objectList",
            fields: [
              textField("hostPath"),
              textField("containerPath"),
              {
                key: "readOnly",
                label: "Read Only",
                fieldType: { type: "boolean" },
                required: false,
                default: false,
              },
            ],
          },
          required: false,
        },
        {
          key: "removeOnExit",
          label: "Remove on Exit",
          fieldType: { type: "boolean" },
          required: false,
          default: true,
        },
      ],
    },
  ],
};

describe("buildDefaults", () => {
  it("extracts default values from schema fields", () => {
    const defaults = buildDefaults(SSH_LIKE_SCHEMA);
    expect(defaults).toEqual({
      port: 22,
      authMethod: "key",
    });
  });

  it("provides empty arrays for keyValueList and objectList fields", () => {
    const defaults = buildDefaults(DOCKER_LIKE_SCHEMA);
    expect(defaults).toEqual({
      image: "ubuntu:22.04",
      envVars: [],
      volumes: [],
      removeOnExit: true,
    });
  });

  it("returns empty object for schema with no defaults", () => {
    const schema: SettingsSchema = {
      groups: [
        {
          key: "basic",
          label: "Basic",
          fields: [textField("host"), textField("port")],
        },
      ],
    };
    expect(buildDefaults(schema)).toEqual({});
  });

  it("handles empty schema", () => {
    expect(buildDefaults({ groups: [] })).toEqual({});
  });
});

describe("isFieldVisible", () => {
  it("returns true for fields without visibleWhen", () => {
    const field = textField("host");
    expect(isFieldVisible(field, {})).toBe(true);
  });

  it("returns true when condition is met", () => {
    const field = passwordField("password", {
      visibleWhen: { field: "authMethod", equals: "password" },
    });
    expect(isFieldVisible(field, { authMethod: "password" })).toBe(true);
  });

  it("returns false when condition is not met", () => {
    const field = passwordField("password", {
      visibleWhen: { field: "authMethod", equals: "password" },
    });
    expect(isFieldVisible(field, { authMethod: "key" })).toBe(false);
  });

  it("handles boolean condition values", () => {
    const field = textField("extraOption", {
      visibleWhen: { field: "advanced", equals: true },
    });
    expect(isFieldVisible(field, { advanced: true })).toBe(true);
    expect(isFieldVisible(field, { advanced: false })).toBe(false);
  });

  it("handles numeric condition values", () => {
    const field = textField("highPort", {
      visibleWhen: { field: "mode", equals: 2 },
    });
    expect(isFieldVisible(field, { mode: 2 })).toBe(true);
    expect(isFieldVisible(field, { mode: 1 })).toBe(false);
  });

  it("returns false when referenced field is missing", () => {
    const field = textField("extra", {
      visibleWhen: { field: "mode", equals: "advanced" },
    });
    expect(isFieldVisible(field, {})).toBe(false);
  });
});

describe("findPasswordPromptInfo", () => {
  it("returns prompt info when password field is visible and empty", () => {
    const settings = { authMethod: "password", host: "example.com", username: "admin" };
    const result = findPasswordPromptInfo(SSH_LIKE_SCHEMA, settings);
    expect(result).toEqual({
      hostKey: "host",
      usernameKey: "username",
      passwordKey: "password",
    });
  });

  it("returns null when password field is not visible", () => {
    const settings = { authMethod: "key" };
    const result = findPasswordPromptInfo(SSH_LIKE_SCHEMA, settings);
    expect(result).toBeNull();
  });

  it("returns null when password is already set", () => {
    const settings = { authMethod: "password", password: "secret" };
    const result = findPasswordPromptInfo(SSH_LIKE_SCHEMA, settings);
    expect(result).toBeNull();
  });

  it("returns null when schema has no password fields", () => {
    const schema: SettingsSchema = {
      groups: [
        {
          key: "conn",
          label: "Connection",
          fields: [textField("host")],
        },
      ],
    };
    expect(findPasswordPromptInfo(schema, {})).toBeNull();
  });

  it("returns prompt info for unconditional password field", () => {
    const schema: SettingsSchema = {
      groups: [
        {
          key: "conn",
          label: "Connection",
          fields: [textField("host"), textField("username"), passwordField("password")],
        },
      ],
    };
    const result = findPasswordPromptInfo(schema, { host: "h", username: "u" });
    expect(result).toEqual({
      hostKey: "host",
      usernameKey: "username",
      passwordKey: "password",
    });
  });
});
