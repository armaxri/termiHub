import type { ConnectionTypeInfo } from "@/types/connection";

/**
 * Plugin-provided connection types in the connection-type selector (#2002).
 *
 * A plugin that declares a `terminalBackend` extension registers its connection
 * type into the shared `ConnectionTypeRegistry` (#1999), so it flows to the
 * frontend through the normal `get_connection_types` path alongside the
 * built-ins — including a settings schema derived from the manifest
 * `configSchema` (which the generic `DynamicForm` then renders).
 *
 * A plugin type is registered under the stable, namespaced id
 * `plugin:<pluginId>:<connectionType>` ({@link pluginConnectionTypeId}, PLG-007)
 * — never the bare manifest `connectionType`, and never an id that depends on
 * load order. Anything matching a saved connection or open tab against a
 * plugin's backend must compare against that id. When two types share a display
 * name, the later one's label is suffixed with the plugin name.
 *
 * The plugin host stamps every such registry entry with the {@link
 * PLUGIN_CONNECTION_TYPE_ICON} icon; no built-in type uses it, so the selector
 * partitions the registry on it to list plugin types under their own separator.
 */

/** The prefix of every plugin-provided connection-type id (mirrors Rust `PLUGIN_TYPE_ID_PREFIX`). */
export const PLUGIN_CONNECTION_TYPE_PREFIX = "plugin:";

/**
 * The stable registry id of a plugin's terminal-backend connection type:
 * `plugin:<pluginId>:<connectionType>`. Mirrors Rust `plugin_type_id` — this is
 * the `type` a saved connection or open tab of that plugin carries.
 */
export function pluginConnectionTypeId(pluginId: string, connectionType: string): string {
  return `${PLUGIN_CONNECTION_TYPE_PREFIX}${pluginId}:${connectionType}`;
}

/** The registry icon the plugin host assigns to every plugin-provided type (#1999). */
export const PLUGIN_CONNECTION_TYPE_ICON = "puzzle";

/** Whether a connection type is plugin-provided (registered by an active plugin). */
export function isPluginConnectionType(info: Pick<ConnectionTypeInfo, "icon">): boolean {
  return info.icon === PLUGIN_CONNECTION_TYPE_ICON;
}

/**
 * Split a connection-type registry into built-in and plugin-provided types,
 * preserving each group's original registry order. Two plugins registering the
 * same `connectionType` have distinct ids and distinct labels.
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
