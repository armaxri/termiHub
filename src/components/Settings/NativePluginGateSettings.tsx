import { useCallback, useEffect, useMemo, useState } from "react";
import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store/appStore";
import {
  acknowledgeNativePlugin,
  getNativePluginTrust,
  revokeNativePluginTrust,
  setNativePluginsEnabled,
} from "@/services/api";
import type { NativePluginTrust } from "@/types/plugin";
import { Button, EmptyState, Toggle, toast } from "@/components/ui";
import { frontendLog } from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";
import { SettingsField } from "./SettingsField";

/**
 * Settings → Plugins → the native (in-process) plugin trust gate
 * (SEC-002 / PLG-006 / ARCH-008).
 *
 * Native plugin backends are dynamic libraries loaded **in the app process** with
 * termiHub's full privileges and no OS sandbox. To invert the former install-time
 * trust model, they are:
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
  const [trust, setTrust] = useState<NativePluginTrust | null>(null);

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
    // Enabling/acknowledging/revoking (here or on the plugin detail panel) emits
    // the plugin-changed event; re-fetch so the acknowledgment list stays current.
    const unlisten = listen("plugin-changed", () => void load());
    return () => {
      void unlisten.then((off) => off());
    };
  }, [load]);

  /** Installed native plugins — those declaring a terminal-backend extension. */
  const nativePlugins = useMemo(
    () => plugins.filter((p) => p.manifest.extensions.terminalBackend != null),
    [plugins]
  );

  const acknowledgedIds = useMemo(
    () => new Set((trust?.acknowledged ?? []).map((a) => a.id)),
    [trust]
  );

  const handleToggleGlobal = useCallback(
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

  const handleTrust = useCallback(
    async (id: string, name: string) => {
      try {
        await acknowledgeNativePlugin(id);
        await load();
        toast.success(`Trusted and loaded ${name}`);
      } catch (err) {
        toast.error(`Failed to trust ${name}: ${errorMessage(err)}`);
        throw err;
      }
    },
    [load]
  );

  const handleRevoke = useCallback(
    async (id: string, name: string) => {
      try {
        await revokeNativePluginTrust(id);
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
          <ShieldAlert size={16} aria-hidden="true" /> Native Plugins (Advanced)
        </h3>
        <p className="settings-panel__description" data-testid="native-plugin-disclosure">
          {trust?.disclosure ??
            "Native plugins run inside termiHub with full application privileges and no operating-system sandbox."}
        </p>

        <SettingsField
          label="Enable Native (In-Process) Plugins"
          hint="Off by default. Even when enabled, each native plugin must be trusted individually below before it loads. Theme and JavaScript plugins are unaffected by this setting."
          hintVariant="warning"
        >
          <Toggle
            checked={enabled}
            onCheckedChange={handleToggleGlobal}
            data-testid="settings-native-plugins-enabled"
          />
        </SettingsField>

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
            {nativePlugins.map((p) => {
              const id = p.manifest.id;
              const isTrusted = acknowledgedIds.has(id);
              return (
                <li
                  key={id}
                  className="settings-panel__file-item"
                  data-testid={`native-plugin-row-${id}`}
                >
                  <div>
                    <span className="settings-panel__subsection-title">{p.manifest.name}</span>{" "}
                    <span className="settings-panel__description">
                      · {isTrusted ? "trusted" : "not trusted"}
                    </span>
                  </div>
                  {isTrusted ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<ShieldX size={14} />}
                      onClick={() => handleRevoke(id, p.manifest.name)}
                      errorToast={false}
                      aria-label={`Revoke trust for ${p.manifest.name}`}
                      data-testid={`native-plugin-revoke-${id}`}
                    >
                      Revoke
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<ShieldCheck size={14} />}
                      onClick={() => handleTrust(id, p.manifest.name)}
                      disabled={!enabled}
                      errorToast={false}
                      aria-label={`Trust ${p.manifest.name}`}
                      data-testid={`native-plugin-trust-${id}`}
                    >
                      Trust &amp; Load
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
