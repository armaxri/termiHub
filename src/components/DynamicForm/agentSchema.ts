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
    {
      key: "updates",
      label: "Updates",
      fields: [
        {
          key: "updateStrategy",
          label: "Update Strategy",
          fieldType: {
            type: "select",
            options: [
              { value: "immediate", label: "Immediate (shut down & redeploy)" },
              { value: "coordinated", label: "Coordinated (notify connected hosts)" },
            ],
          },
          required: false,
          default: "immediate",
          description:
            "How this agent's binary is updated when a newer desktop version deploys. " +
            "Coordinated notifies other connected hosts and lets them reconnect cleanly " +
            "before applying (Unix agents — Windows falls back to Immediate).",
        },
        // NOTE: The "Allow agent self-update" toggle and the "Deferred" update
        // strategy are intentionally NOT rendered here. Their underlying
        // mechanisms (SI-8 self-update; deferred apply-on-last-disconnect) are
        // not implemented yet, so exposing them as controls only persisted an
        // inert preference that silently did nothing (WA-FE-002). The type
        // fields (`allowSelfUpdate`, `updateStrategy: "deferred"`) are kept in
        // RemoteAgentConfig for forward-compat and tolerant loading of existing
        // configs — re-add the controls here once the backend mechanisms land.
      ],
    },
  ],
};
