/**
 * Main-thread snapshot store for sandbox status-bar widgets — part of the plugin
 * sandbox work (#2136).
 *
 * Status-bar widgets are registered and rendered inside the sandbox worker,
 * which posts declarative {@link WidgetNode} descriptors to the host. The host
 * ({@link ./pluginSandboxHost}) feeds those into this store; the status bar
 * ({@link ../../components/StatusBar/PluginStatusBarWidgets}) reads it via
 * `useSyncExternalStore`. Per-position arrays keep a **stable reference** until
 * the registry changes, as `useSyncExternalStore` requires.
 *
 * This module is pure main-thread state — no worker, no Tauri — so it stays
 * unit-testable and free of the worker realm.
 */

import type { WidgetNode } from "./protocol";
import type { WidgetPosition } from "@/types/plugin";

/** A materialisable status-bar widget: its host key, bare id, and DOM descriptor. */
export interface StatusBarWidgetEntry {
  /** Collision-proof `<pluginId>:<widgetId>` key (stable React key). */
  key: string;
  /** Bare widget id — drives the host `data-testid` (`plugin-widget-<id>`). */
  widgetId: string;
  /** The declarative DOM the host materialises via {@link ./widgetNode}. */
  node: WidgetNode;
}

/** A widget with its side, as tracked in the flat registry. */
interface Tracked extends StatusBarWidgetEntry {
  position: WidgetPosition;
}

let entries: Tracked[] = [];
let snapshot: Record<WidgetPosition, StatusBarWidgetEntry[]> = { left: [], right: [] };
const listeners = new Set<() => void>();

function refresh(): void {
  const next: Record<WidgetPosition, StatusBarWidgetEntry[]> = { left: [], right: [] };
  for (const e of entries) {
    next[e.position].push({ key: e.key, widgetId: e.widgetId, node: e.node });
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

/**
 * Insert or replace a widget by key (a re-render posts the same key with a new
 * node). Preserves insertion order for a stable left-to-right layout.
 */
export function upsertStatusBarWidget(
  key: string,
  position: WidgetPosition,
  widgetId: string,
  node: WidgetNode
): void {
  const existing = entries.findIndex((e) => e.key === key);
  const entry: Tracked = { key, position, widgetId, node };
  if (existing >= 0) entries[existing] = entry;
  else entries.push(entry);
  refresh();
}

/** Remove a widget by key. No-op when absent. */
export function removeStatusBarWidget(key: string): void {
  const before = entries.length;
  entries = entries.filter((e) => e.key !== key);
  if (entries.length !== before) refresh();
}

/** Drop every widget (used on sandbox teardown / in tests). */
export function clearStatusBarWidgets(): void {
  if (entries.length === 0) return;
  entries = [];
  refresh();
}

/**
 * Current status-bar widgets for a side, as a stable-reference array suitable
 * for `useSyncExternalStore`. The reference only changes when the registry does.
 */
export function getStatusBarWidgets(position: WidgetPosition): StatusBarWidgetEntry[] {
  return snapshot[position];
}

/** Subscribe to widget-registry changes; returns an unsubscribe. */
export function subscribeStatusBarWidgets(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
