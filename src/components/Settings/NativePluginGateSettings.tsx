import { useCallback, useEffect, useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useTauriListener } from "@/hooks/useTauriListener";
import { useAppStore } from "@/store/appStore";
import { usePluginSandbox } from "@/store/usePluginSandbox";
import {
  acknowledgeNativePlugin,
  enablePlugin,
  getNativePluginTrust,
  revokeNativePluginTrust,
  setNativePluginsEnabled,
} from "@/services/api";
import type { InstalledPlugin, NativePluginTrust } from "@/types/plugin";
import { ConfirmDialog, EmptyState, Toggle, toast } from "@/components/ui";
import { frontendLog } from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";
import { SettingsField } from "./SettingsField";
import { NativePluginRow, openSessionsLabel } from "./NativePluginRow";

/**
 * Settings → Plugins → the native plugin trust gate (SEC-002 / PLG-006 /
 * ARCH-008) and sandbox status (#4188).
 *
 * Native plugin backends are dynamic libraries. Each runs in its own sandboxed
 * plugin process (ADR-19), and every row shows its isolation, process status
 * and access from the backend `plugin-sandbox` region. To invert the former install-time trust
 * model, they are:
 *
 * 1. **Default-OFF globally** — no native plugin loads unless this switch is on;
 * 2. **Per-plugin acknowledged** — even then, each native plugin loads only after
 *    the user explicitly trusts it, bound to its exact library hash (a changed
 *    binary must be re-trusted).
 *
 * The disclosure text is fetched from the backend so it can never drift from the
 * gate it describes. Sandboxed-JS / theme plugins are a separate surface and are
 * unaffected by this setting (see {@link FrontendPluginGateSettings}).
 */
export function NativePluginGateSettings() {
  const plugins = useAppStore((s) => s.plugins);
  const sandbox = usePluginSandbox();
  const [trust, setTrust] = useState<NativePluginTrust | null>(null);
  // Switching native plugins off ends every open plugin session; with any
  // open, it waits for this confirmation first (#4379).
  const [confirmDisable, setConfirmDisable] = useState(false);

  const load = useCallback(async () => {
    try {
      setTrust(await getNativePluginTrust());
    } catch (err) {
      const message = errorMessage(err);
      frontendLog("native_plugin_gate", `failed to load native-plugin trust: ${message}`);
      toast.error(`Failed to load native-plugin trust: ${message}`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Enabling/acknowledging/revoking (here or on the plugin detail panel) emits
  // the plugin-changed event; re-fetch so the acknowledgment list stays current.
  useTauriListener<void>("plugin-changed", () => void load(), "native_plugin_gate");

  /** Installed native plugins — those declaring a terminal-backend extension. */
  const nativePlugins = useMemo(
    () => plugins.filter((p) => p.manifest.extensions.terminalBackend != null),
    [plugins]
  );

  /** Open sessions across every native plugin, from the `plugin-sandbox` region. */
  const openSessions = useMemo(
    () =>
      nativePlugins.reduce(
        (sum, p) => sum + (sandbox.plugins[p.manifest.id]?.process?.sessions ?? 0),
        0
      ),
    [nativePlugins, sandbox]
  );

  const acknowledgments = useMemo(
    () => new Map((trust?.acknowledged ?? []).map((a) => [a.id, a])),
    [trust]
  );

  const applyGlobal = useCallback(
    async (checked: boolean) => {
      try {
        await setNativePluginsEnabled(checked);
        await load();
        toast.success(checked ? "Native plugins enabled" : "Native plugins disabled");
      } catch (err) {
        toast.error(`Failed to update native plugins: ${errorMessage(err)}`);
        throw err;
      }
    },
    [load]
  );

  const handleToggleGlobal = useCallback(
    async (checked: boolean) => {
      if (!checked && openSessions > 0) {
        setConfirmDisable(true);
        return;
      }
      await applyGlobal(checked);
    },
    [applyGlobal, openSessions]
  );

  const handleConfirmDisable = useCallback(async () => {
    await applyGlobal(false);
    setConfirmDisable(false);
  }, [applyGlobal]);

  const handleTrust = useCallback(
    async (plugin: InstalledPlugin, acceptUnverifiedToolchain: boolean) => {
      const name = plugin.manifest.name;
      try {
        await acknowledgeNativePlugin(plugin.manifest.id, { acceptUnverifiedToolchain });
        await load();
        toast.success(`Trusted and loaded ${name}`);
      } catch (err) {
        toast.error(`Failed to trust ${name}: ${errorMessage(err)}`);
        throw err;
      }
    },
    [load]
  );

  const handleAcceptReducedIsolation = useCallback(
    async (plugin: InstalledPlugin, acceptUnverifiedToolchain: boolean) => {
      const name = plugin.manifest.name;
      try {
        await acknowledgeNativePlugin(plugin.manifest.id, {
          acceptUnverifiedToolchain,
          acceptReducedIsolation: true,
        });
        await load();
        toast.success(`Loaded ${name} with reduced isolation`);
      } catch (err) {
        toast.error(`Failed to load ${name}: ${errorMessage(err)}`);
        throw err;
      }
    },
    [load]
  );

  const handleRestart = useCallback(
    async (plugin: InstalledPlugin, reenable: boolean) => {
      const name = plugin.manifest.name;
      try {
        // Enabling re-runs the load path: a running plugin restarts, one
        // disabled after crashes gets a fresh crash budget.
        await enablePlugin(plugin.manifest.id);
        await load();
        toast.success(reenable ? `Re-enabled ${name}` : `Restarted ${name}`);
      } catch (err) {
        toast.error(
          `Failed to ${reenable ? "re-enable" : "restart"} ${name}: ${errorMessage(err)}`
        );
        throw err;
      }
    },
    [load]
  );

  const handleRevoke = useCallback(
    async (plugin: InstalledPlugin) => {
      const name = plugin.manifest.name;
      try {
        await revokeNativePluginTrust(plugin.manifest.id);
        await load();
        toast.success(`Revoked trust for ${name}`);
      } catch (err) {
        toast.error(`Failed to revoke ${name}: ${errorMessage(err)}`);
        throw err;
      }
    },
    [load]
  );

  const enabled = trust?.enabled ?? false;

  return (
    <div className="settings-panel__category">
      <div className="settings-panel__section" data-testid="settings-native-plugin-gate">
        <h3 className="settings-panel__section-title">
          <ShieldCheck size={16} aria-hidden="true" /> Native Plugins
        </h3>
        <p className="settings-panel__description" data-testid="native-plugin-disclosure">
          {trust?.disclosure ?? "Native plugins run in a separate, sandboxed process."}
        </p>

        <SettingsField
          label="Enable Native Plugins"
          hint="Off by default. Even when enabled, each native plugin must be trusted individually below before it loads. Theme and JavaScript plugins are unaffected by this setting."
          hintVariant="warning"
        >
          <Toggle
            checked={enabled}
            onCheckedChange={handleToggleGlobal}
            data-testid="settings-native-plugins-enabled"
          />
        </SettingsField>
        <ConfirmDialog
          open={confirmDisable}
          variant="warn"
          title="Disable native plugins?"
          message={`This ends the ${openSessionsLabel(openSessions)} of your native plugins.`}
          confirmLabel="Disable"
          confirmVariant="danger"
          confirmErrorToast={false}
          onConfirm={handleConfirmDisable}
          onCancel={() => setConfirmDisable(false)}
          testIdBase="native-plugins-disable"
          data-testid="native-plugins-disable-dialog"
        />

        <div className="settings-panel__subsection-title">Trusted Native Plugins</div>
        <p className="settings-panel__description">
          Each native plugin loads only after you trust it, bound to its exact library. If a
          plugin&apos;s library changes, you must trust it again. Revoking trust unloads it
          immediately.
        </p>

        {nativePlugins.length === 0 ? (
          <EmptyState
            variant="panel"
            title="No native plugins installed."
            data-testid="native-plugins-empty"
          />
        ) : (
          <ul className="settings-panel__file-list">
            {nativePlugins.map((p) => (
              <NativePluginRow
                key={p.manifest.id}
                plugin={p}
                ack={acknowledgments.get(p.manifest.id)}
                nativeEnabled={enabled}
                sandbox={sandbox}
                onTrust={handleTrust}
                onAcceptReducedIsolation={handleAcceptReducedIsolation}
                onRestart={handleRestart}
                onRevoke={handleRevoke}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
