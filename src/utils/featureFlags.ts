import { ConnectionConfig, SshConfig } from "@/types/terminal";

/**
 * Resolve whether a per-connection feature is enabled.
 *
 * For SSH connections the per-connection override (if set) takes precedence
 * over the global default. Non-SSH connections always return `false`.
 */
export function resolveFeatureEnabled(
  config: ConnectionConfig | undefined,
  feature: "enableMonitoring" | "enableFileBrowser",
  globalDefault: boolean
): boolean {
  if (!config || config.type !== "ssh") return false;
  const override_ = (config.config as SshConfig)[feature];
  return override_ !== undefined ? override_ : globalDefault;
}
