import { useState, useEffect } from "react";
import { checkDockerAvailable, checkPodmanAvailable } from "@/services/api";

interface AvailableRuntimes {
  dockerAvailable: boolean;
  podmanAvailable: boolean;
  loading: boolean;
}

/** Cached result so we only probe once per session. */
let cachedResult: { docker: boolean; podman: boolean } | null = null;

/**
 * Probes the system for available container runtimes (Docker / Podman).
 *
 * Results are cached for the lifetime of the session — runtime availability
 * is unlikely to change while the app is running.
 */
export function useAvailableRuntimes(): AvailableRuntimes {
  const [state, setState] = useState<AvailableRuntimes>(() => {
    if (cachedResult) {
      return {
        dockerAvailable: cachedResult.docker,
        podmanAvailable: cachedResult.podman,
        loading: false,
      };
    }
    return { dockerAvailable: false, podmanAvailable: false, loading: true };
  });

  useEffect(() => {
    if (cachedResult) return;

    let cancelled = false;

    async function probe() {
      const [docker, podman] = await Promise.all([
        checkDockerAvailable().catch(() => false),
        checkPodmanAvailable().catch(() => false),
      ]);
      cachedResult = { docker, podman };
      if (!cancelled) {
        setState({ dockerAvailable: docker, podmanAvailable: podman, loading: false });
      }
    }

    probe();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

/**
 * Reset the cached runtime probe result.
 * Exposed for testing only.
 */
export function resetRuntimeCache(): void {
  cachedResult = null;
}
