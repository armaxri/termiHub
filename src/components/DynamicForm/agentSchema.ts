/**
 * Static SettingsSchema for the Remote Agent SSH transport.
 *
 * Agents are not a "connection type" in the backend registry — they're a
 * transport layer. So we define their schema statically on the frontend.
 */

import type { SettingsSchema } from "@/types/schema";

export const AGENT_SCHEMA: SettingsSchema = {
  groups: [
    {
      key: "connection",
      label: "Connection",
      fields: [
        {
          key: "host",
          label: "Host",
          fieldType: { type: "text" },
          required: true,
          placeholder: "192.168.1.100",
          supportsEnvExpansion: true,
        },
        {
          key: "port",
          label: "Port",
          fieldType: { type: "port" },
          required: true,
          default: 22,
        },
        {
          key: "username",
          label: "Username",
          fieldType: { type: "text" },
          required: true,
          placeholder: "pi",
        },
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
              { value: "password", label: "Password" },
              { value: "key", label: "SSH Key" },
              { value: "agent", label: "SSH Agent" },
            ],
          },
          required: true,
          default: "password",
        },
        {
          key: "keyPath",
          label: "Key Path",
          fieldType: { type: "filePath", kind: "file" },
          required: false,
          placeholder: "~/.ssh/id_ed25519",
          supportsEnvExpansion: true,
          supportsTildeExpansion: true,
          visibleWhen: { field: "authMethod", equals: "key" },
        },
        {
          key: "password",
          label: "Password",
          fieldType: { type: "password" },
          required: false,
          visibleWhen: { field: "authMethod", equals: "password" },
        },
        {
          key: "savePassword",
          label: "Save password",
          fieldType: { type: "boolean" },
          required: false,
          default: false,
          description:
            "When enabled, the password or passphrase is stored in the credential store.",
          visibleWhen: { field: "authMethod", equals: "password" },
        },
      ],
    },
  ],
};
