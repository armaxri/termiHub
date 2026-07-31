import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  getStatusBarWidgets,
  subscribeStatusBarWidgets,
  type StatusBarWidgetEntry,
} from "@/plugins/sandbox/statusBarWidgetStore";
import { buildWidgetDom } from "@/plugins/sandbox/widgetNode";
import type { WidgetPosition } from "@/types/plugin";

/**
 * Renders the status-bar widgets registered by active frontend plugins into one
 * side of the status bar (#1998, concept §8), now sandboxed (#2136).
 *
 * Widget `render()` runs inside the sandbox worker, which posts a declarative
 * {@link StatusBarWidgetEntry.node} descriptor. This component subscribes to the
 * main-thread snapshot store via `useSyncExternalStore` — so a plugin
 * enabling/disabling at runtime mounts or unmounts its widgets without a store
 * round-trip — and materialises each descriptor into real DOM on the main thread
 * ({@link buildWidgetDom}, strictly allowlisted). A plugin being disabled removes
 * its descriptor, which unmounts its host here; `dispose()` runs in the worker.
 */
export function PluginStatusBarWidgets({ position }: { position: WidgetPosition }) {
  const widgets = useSyncExternalStore(subscribeStatusBarWidgets, () =>
    getStatusBarWidgets(position)
  );

  return (
    <>
      {widgets.map((entry) => (
        <PluginWidgetHost key={entry.key} entry={entry} />
      ))}
    </>
  );
}

/**
 * Host for a single plugin status-bar widget: materialises the descriptor the
 * sandbox produced and mounts it, replacing the DOM whenever the descriptor
 * changes. The descriptor crosses a trust boundary, so it is rebuilt through the
 * allowlisted {@link buildWidgetDom} — never `innerHTML` — so plugin content can
 * never inject executable markup into the host page.
 */
function PluginWidgetHost({ entry }: { entry: StatusBarWidgetEntry }) {
  const hostRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const el = buildWidgetDom(entry.node);
    host.appendChild(el);
    return () => {
      if (el.parentNode === host) host.removeChild(el);
    };
  }, [entry.node]);

  return (
    <span
      className="status-bar__item status-bar__plugin-widget"
      data-testid={`plugin-widget-${entry.widgetId}`}
      ref={hostRef}
    />
  );
}
