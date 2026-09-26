import type { ConnectionTypeInfo } from "@/types/connection";
import type { InstalledPlugin } from "@/types/plugin";

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

/**
 * Split a namespaced plugin connection-type id into its plugin id and declared
 * connection type. Mirrors Rust `parse_plugin_type_id`: `null` for anything that
 * is not `plugin:<pluginId>:<connectionType>` with both parts non-empty (a
 * built-in id, a legacy plugin id, or a malformed value). A plugin id never
 * contains a `:`, so the first `:` after the prefix is the separator.
 */
export function parsePluginConnectionTypeId(
  typeId: string
): { pluginId: string; connectionType: string } | null {
  if (!typeId.startsWith(PLUGIN_CONNECTION_TYPE_PREFIX)) return null;
  const rest = typeId.slice(PLUGIN_CONNECTION_TYPE_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { pluginId: rest.slice(0, sep), connectionType: rest.slice(sep + 1) };
}

/** Why a saved connection's plugin cannot serve it right now (#3344). */
export type PluginConnectionIssueReason =
  /** No plugin with that id is installed. */
  | "not-installed"
  /** Installed but disabled by the user. */
  | "disabled"
  /**
   * Installed and enabled but not loaded — for a native backend this is the
   * trust gate (#3296): native plugins are off or the plugin is not trusted.
   */
  | "not-loaded"
  /** Activation failed. */
  | "error"
  /** Targets an unsupported plugin-API version. */
  | "incompatible"
  /** Loaded, but it no longer declares this connection type. */
  | "type-missing";

/** A saved connection whose plugin-provided type is currently unavailable. */
export interface PluginConnectionIssue {
  /** The plugin id named by the connection's `plugin:<id>:<type>` type. */
  pluginId: string;
  /** Display name: the manifest name when installed, else the plugin id. */
  pluginName: string;
  /** Whether a plugin with that id is installed (drives the shortcut target). */
  installed: boolean;
  reason: PluginConnectionIssueReason;
  /** Display-ready explanation for the sidebar tooltip and blocked connect. */
  message: string;
}

/**
 * Whether the plugin behind a saved connection's type can serve it (#3344).
 *
 * `null` for a built-in (non-`plugin:`) type or when the plugin is active and
 * still declares the type; otherwise the reason plus a display-ready message.
 * Derived from the backend plugin manager's installed-plugin list, which the
 * store re-fetches on every plugin change, so the result updates live when a
 * plugin is installed, enabled or trusted.
 */
export function pluginConnectionIssue(
  typeId: string,
  plugins: readonly InstalledPlugin[]
): PluginConnectionIssue | null {
  const parsed = parsePluginConnectionTypeId(typeId);
  if (!parsed) return null;
  const { pluginId, connectionType } = parsed;
  const plugin = plugins.find((p) => p.manifest.id === pluginId);
  if (!plugin) {
    return {
      pluginId,
      pluginName: pluginId,
      installed: false,
      reason: "not-installed",
      message: `Plugin '${pluginId}' is not installed`,
    };
  }
  const name = plugin.manifest.name || pluginId;
  const issue = (reason: PluginConnectionIssueReason, message: string): PluginConnectionIssue => ({
    pluginId,
    pluginName: name,
    installed: true,
    reason,
    message,
  });
  switch (plugin.state) {
    case "disabled":
      return issue("disabled", `Plugin '${name}' is disabled`);
    case "incompatible":
      return issue("incompatible", `Plugin '${name}' is incompatible with this termiHub version`);
    case "error":
      return issue(
        "error",
        `Plugin '${name}' failed to load${plugin.errorMessage ? `: ${plugin.errorMessage}` : ""}`
      );
    case "installed":
      return issue(
        "not-loaded",
        `Plugin '${name}' is not loaded — native plugins must be enabled and the plugin trusted`
      );
    case "active":
      if (plugin.manifest.extensions.terminalBackend?.connectionType !== connectionType) {
        return issue(
          "type-missing",
          `Plugin '${name}' no longer provides the '${connectionType}' connection type`
        );
      }
      return null;
  }
}
