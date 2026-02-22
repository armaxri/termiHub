import { ConnectionConfig } from "@/types/terminal";

/**
 * Resolve whether a per-connection feature is enabled.
 *
 * Checks the connection config for a per-connection boolean override
 * of the feature flag. If the override exists, it takes precedence
 * over the global default. Otherwise falls back to `globalDefault`.
 *
 * Callers are responsible for checking whether the connection type
 * supports the feature (via capabilities) before calling this function.
 */
export function resolveFeatureEnabled(
  config: ConnectionConfig | undefined,
  feature: "enableMonitoring" | "enableFileBrowser",
  globalDefault: boolean
): boolean {
  if (!config) return false;
  const cfg = config.config as unknown as Record<string, unknown>;
  const override_ = cfg[feature];
  if (typeof override_ === "boolean") return override_;
  return globalDefault;
}
