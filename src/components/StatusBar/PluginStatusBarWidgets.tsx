import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  getStatusBarWidgets,
  subscribeStatusBarWidgets,
  type StatusBarWidget,
} from "@/plugins/pluginRuntime";
import type { WidgetPosition } from "@/types/plugin";
import { frontendLog } from "@/utils/frontendLog";

/**
 * Renders the status-bar widgets registered by active frontend plugins into one
 * side of the status bar (#1998, concept §8).
 *
 * The widget registry lives in {@link @/plugins/pluginRuntime}; this component
 * subscribes to it via `useSyncExternalStore` so a plugin enabling/disabling at
 * runtime mounts or unmounts its widgets without a store round-trip. Each widget
 * owns its DOM (`render()` → an `HTMLElement`); a plugin being disabled drops it
 * from the registry, which unmounts its host here and is where `dispose()` runs
 * — so a widget is disposed exactly once, cleanly.
 */
export function PluginStatusBarWidgets({ position }: { position: WidgetPosition }) {
  const widgets = useSyncExternalStore(subscribeStatusBarWidgets, () =>
    getStatusBarWidgets(position)
  );

  return (
    <>
      {widgets.map(({ key, widget }) => (
        <PluginWidgetHost key={key} widget={widget} />
      ))}
    </>
  );
}

/**
 * Host for a single plugin status-bar widget: mounts the plugin's `render()`
 * DOM on mount and calls `dispose()` on unmount. Both calls cross into
 * plugin-provided code, so both are wrapped — a throwing widget is logged and
 * isolated, never allowed to break the status bar (concept "Error Handling").
 */
function PluginWidgetHost({ widget }: { widget: StatusBarWidget }) {
  const hostRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let el: HTMLElement | null = null;
    try {
      el = widget.render();
      if (el) host.appendChild(el);
    } catch (err) {
      frontendLog(
        "plugin_runtime",
        `Status-bar widget "${widget.id}" render() threw: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return () => {
      try {
        widget.dispose();
      } catch (err) {
        frontendLog(
          "plugin_runtime",
          `Status-bar widget "${widget.id}" dispose() threw: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (el && el.parentNode === host) host.removeChild(el);
    };
  }, [widget]);

  return (
    <span
      className="status-bar__item status-bar__plugin-widget"
      data-testid={`plugin-widget-${widget.id}`}
      ref={hostRef}
    />
  );
}
