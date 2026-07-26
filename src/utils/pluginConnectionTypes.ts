import type { ConnectionTypeInfo } from "@/types/connection";

/**
 * Plugin-provided connection types in the connection-type selector (#2002).
 *
 * A plugin that declares a `terminalBackend` extension registers its connection
 * type into the shared `ConnectionTypeRegistry` (#1999), so it flows to the
 * frontend through the normal `get_connection_types` path alongside the
 * built-ins — including a settings schema derived from the manifest
 * `configSchema` (which the generic `DynamicForm` then renders) and, when the
 * declared `connectionType` collided with a built-in or another plugin, a
 * disambiguated `type_id` / display name suffixed by the plugin.
 *
 * The plugin host stamps every such registry entry with the {@link
 * PLUGIN_CONNECTION_TYPE_ICON} icon; no built-in type uses it. That icon is the
 * authoritative marker of a plugin-provided type — it survives the backend's
 * disambiguation (unlike matching a raw manifest `connectionType` name against
 * the store's `pluginBackendTypes` projection, which does not) — so the selector
 * partitions the registry on it to list plugin types under their own separator.
 */

/** The registry icon the plugin host assigns to every plugin-provided type (#1999). */
export const PLUGIN_CONNECTION_TYPE_ICON = "puzzle";

/** Whether a connection type is plugin-provided (registered by an active plugin). */
export function isPluginConnectionType(info: Pick<ConnectionTypeInfo, "icon">): boolean {
  return info.icon === PLUGIN_CONNECTION_TYPE_ICON;
}

/**
 * Split a connection-type registry into built-in and plugin-provided types,
 * preserving each group's original registry order. The plugin group carries the
 * types' already-disambiguated display names, so two plugins registering the
 * same `connectionType` render distinct labels.
 */
export function partitionConnectionTypes(types: ConnectionTypeInfo[]): {
  builtins: ConnectionTypeInfo[];
  plugins: ConnectionTypeInfo[];
} {
  const builtins: ConnectionTypeInfo[] = [];
  const plugins: ConnectionTypeInfo[] = [];
  for (const type of types) {
    (isPluginConnectionType(type) ? plugins : builtins).push(type);
  }
  return { builtins, plugins };
}
