import { useEffect, useRef } from "react";
import { toast } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { usePluginSandbox } from "@/store/usePluginSandbox";
import { EMPTY_SANDBOX_VIEW } from "@/store/pluginSandboxBridge";
import { DenialToastLimiter, type DenialToast } from "./denialToastLimiter";

function show(t: DenialToast): void {
  toast.info(t.title, {
    description: t.description,
    testId: `plugin-denial-toast-${t.pluginId}`,
  });
}

/**
 * Raises the rate-limited "Blocked a plugin request" toasts (#4188) from the
 * backend `plugin-sandbox` region: at most one per plugin per 30 s, later ones
 * folded into "and N more". Renders nothing; mount it once at the app root.
 */
export function PluginDenialToasts() {
  const sandbox = usePluginSandbox();
  const plugins = useAppStore((s) => s.plugins);
  const limiter = useRef(new DenialToastLimiter());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const names = useRef(new Map<string, string>());

  useEffect(() => {
    names.current = new Map(plugins.map((p) => [p.manifest.id, p.manifest.name]));
  }, [plugins]);

  useEffect(() => {
    // Nothing has arrived from the region yet: the first real view is the
    // baseline, so denials from before this window subscribed are not replayed.
    if (sandbox === EMPTY_SANDBOX_VIEW) return;
    const nameOf = (id: string) => names.current.get(id) ?? id;
    limiter.current.observe(sandbox, Date.now(), nameOf).forEach(show);
    // Surface denials folded into a window once it closes.
    const next = limiter.current.nextFlushAt();
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current =
      next === undefined
        ? null
        : setTimeout(
            () => limiter.current.flush(Date.now(), nameOf).forEach(show),
            Math.max(0, next - Date.now())
          );
  }, [sandbox]);

  useEffect(
    () => () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
    },
    []
  );

  return null;
}
