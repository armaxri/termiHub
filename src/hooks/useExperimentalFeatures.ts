import { useProjectedSettings } from "@/store/useProjectedSettings";

/**
 * Returns whether experimental features are enabled.
 *
 * Experimental features are hidden by default and not guaranteed to be
 * released or long-term supported. Gate any experimental UI behind this hook.
 *
 * @example
 * const experimental = useExperimentalFeatures();
 * if (!experimental) return null;
 */
export function useExperimentalFeatures(): boolean {
  return useProjectedSettings().experimentalFeaturesEnabled ?? false;
}
