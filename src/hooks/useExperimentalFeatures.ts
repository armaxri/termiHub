import { useMemo } from "react";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import type { LocalProcessSwitches } from "@/utils/localProcessGate";

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

/** The two switches a local program needs (#6178), as the settings say now. */
export function useLocalProcessSwitches(): LocalProcessSwitches {
  const settings = useProjectedSettings();
  const experimental = settings.experimentalFeaturesEnabled ?? false;
  const localPrograms = settings.workflowLocalProcessEnabled === true;
  return useMemo(() => ({ experimental, localPrograms }), [experimental, localPrograms]);
}
