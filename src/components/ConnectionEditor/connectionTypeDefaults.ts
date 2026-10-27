import type { ConnectionTypeInfo } from "@/services/api";
import { buildDefaults } from "@/utils/schemaDefaults";

/**
 * Build default settings for a new connection of a type, applying the app-level
 * defaults from Settings (default user, SSH key, shell hook, X11 forwarding).
 */
export function buildTypeDefaults(
  typeInfo: ConnectionTypeInfo | undefined,
  appSettings: {
    defaultUser?: string;
    defaultSshKeyPath?: string;
    defaultShellIntegration?: boolean;
    defaultX11Forwarding?: boolean;
  }
): Record<string, unknown> {
  if (!typeInfo) return {};
  const defaults = buildDefaults(typeInfo.schema);

  // Apply app-level SSH defaults for types that have these fields
  if (appSettings.defaultUser && defaults.username === undefined) {
    // Check if schema has a username field
    for (const group of typeInfo.schema.groups) {
      if (group.fields.some((f) => f.key === "username")) {
        defaults.username = appSettings.defaultUser;
        break;
      }
    }
  }
  if (appSettings.defaultSshKeyPath) {
    for (const group of typeInfo.schema.groups) {
      if (group.fields.some((f) => f.key === "keyPath")) {
        defaults.keyPath = appSettings.defaultSshKeyPath;
        if (defaults.authMethod === "password") {
          defaults.authMethod = "key";
        }
        break;
      }
    }
  }
  for (const group of typeInfo.schema.groups) {
    if (group.fields.some((f) => f.key === "shellIntegration")) {
      // The hook is typed into the shell, so it is opt-in: only an explicit
      // "on" in Settings pre-enables it for a new connection (#5042).
      defaults.shellIntegration = appSettings.defaultShellIntegration ?? false;
      break;
    }
  }
  for (const group of typeInfo.schema.groups) {
    if (group.fields.some((f) => f.key === "enableX11Forwarding")) {
      defaults.enableX11Forwarding = appSettings.defaultX11Forwarding ?? true;
      break;
    }
  }
  return defaults;
}
