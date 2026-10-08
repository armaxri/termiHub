import { useCallback, useState } from "react";
import { RotateCcw, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { Button, ConfirmDialog } from "@/components/ui";
import type { PluginSandboxStatus, PluginSandboxView } from "@/store/pluginSandboxBridge";
import type { InstalledPlugin } from "@/types/plugin";
import type { NativeAckInfo } from "@/types/generated/NativeAckInfo";
import { NativePluginSandboxStatus } from "./NativePluginSandboxStatus";
import { isolationBadge, layerName, missingLayerWarning } from "./nativePluginSandbox";

/**
 * Whether a native plugin was built for an ABI that predates the build-toolchain
 * record (native ABI 1.0, #3576). termiHub cannot verify such a plugin's
 * compiler, so it loads only when the user explicitly accepts that when trusting
 * it. The manifest `apiVersion` is a host-checked mirror of the library's ABI.
 */
export function predatesToolchainRecord(plugin: InstalledPlugin): boolean {
  const [major, minor] = plugin.manifest.apiVersion.split(".").map(Number);
  return major === 1 && minor === 0;
}

/** Props for {@link NativePluginRow}. */
export interface NativePluginRowProps {
  plugin: InstalledPlugin;
  /** The recorded trust acknowledgement, if any. */
  ack: NativeAckInfo | undefined;
  /** Whether native plugins are enabled globally. */
  nativeEnabled: boolean;
  /** The `plugin-sandbox` region view. */
  sandbox: PluginSandboxView;
  /** Trust and load (`acceptUnverifiedToolchain` for an ABI 1.0 plugin). */
  onTrust: (plugin: InstalledPlugin, acceptUnverifiedToolchain: boolean) => Promise<void>;
  /** Accept reduced isolation for this exact library and load it. */
  onAcceptReducedIsolation: (plugin: InstalledPlugin, legacyAbi: boolean) => Promise<void>;
  /** Restart a running plugin, or re-enable one disabled after crashes. */
  onRestart: (plugin: InstalledPlugin, reenable: boolean) => Promise<void>;
  /** Revoke trust (unloads immediately). */
  onRevoke: (plugin: InstalledPlugin) => Promise<void>;
}

/**
 * One row of Settings → Plugins → Native Plugins (concept
 * `plugin-os-sandbox.html`, "UI Interface"): name, trust state, the sandbox
 * status (isolation badge, process status, access chips) and the actions the
 * state allows — Trust & Load, Load with reduced isolation…, Restart /
 * Re-enable and Revoke. Reduced isolation is a recorded, hash-bound choice
 * made in a confirmation dialog that names the missing layer.
 */
export function NativePluginRow({
  plugin,
  ack,
  nativeEnabled,
  sandbox,
  onTrust,
  onAcceptReducedIsolation,
  onRestart,
  onRevoke,
}: NativePluginRowProps) {
  const [confirmReduced, setConfirmReduced] = useState(false);
  const id = plugin.manifest.id;
  const name = plugin.manifest.name;
  const legacyAbi = predatesToolchainRecord(plugin);
  // A 1.0 plugin trusted without the toolchain acceptance is still refused by
  // the host, so it is offered for (re-)trust.
  const isTrusted = ack !== undefined && (!legacyAbi || ack.unverifiedToolchainAccepted);
  const status: PluginSandboxStatus | undefined = sandbox.plugins[id];
  const badge = isolationBadge(plugin, status, isTrusted);
  const missing = status?.missing ?? [];

  const handleConfirmReduced = useCallback(async () => {
    await onAcceptReducedIsolation(plugin, legacyAbi);
    setConfirmReduced(false);
  }, [onAcceptReducedIsolation, plugin, legacyAbi]);

  const trustAction = !isTrusted && (
    <Button
      variant="secondary"
      size="sm"
      icon={<ShieldCheck size={14} />}
      onClick={() => onTrust(plugin, legacyAbi)}
      disabled={!nativeEnabled}
      errorToast={false}
      aria-label={`Trust ${name}`}
      data-testid={`native-plugin-trust-${id}`}
    >
      Trust &amp; Load
    </Button>
  );
  const reducedAction = isTrusted && badge?.kind === "unavailable" && (
    <Button
      variant="secondary"
      size="sm"
      icon={<ShieldAlert size={14} />}
      onClick={() => setConfirmReduced(true)}
      disabled={!nativeEnabled}
      data-testid={`native-plugin-load-reduced-${id}`}
    >
      Load with reduced isolation…
    </Button>
  );
  const reenable = badge?.kind === "disabled";
  const restartAction = (reenable || status?.process?.state === "running") && (
    <Button
      variant="secondary"
      size="sm"
      icon={<RotateCcw size={14} />}
      onClick={() => onRestart(plugin, reenable)}
      errorToast={false}
      aria-label={`${reenable ? "Re-enable" : "Restart"} ${name}`}
      data-testid={`native-plugin-restart-${id}`}
    >
      {reenable ? "Re-enable" : "Restart"}
    </Button>
  );
  const revokeAction = isTrusted && (
    <Button
      variant="ghost"
      size="sm"
      icon={<ShieldX size={14} />}
      onClick={() => onRevoke(plugin)}
      errorToast={false}
      aria-label={`Revoke trust for ${name}`}
      data-testid={`native-plugin-revoke-${id}`}
    >
      Revoke
    </Button>
  );

  return (
    <li
      className="settings-panel__file-item native-plugin-row"
      data-testid={`native-plugin-row-${id}`}
    >
      <div className="native-plugin-row__main">
        <div>
          <span className="settings-panel__subsection-title">{name}</span>{" "}
          <span className="settings-panel__section-badge">
            · {isTrusted ? "trusted" : "not trusted"} · v{plugin.manifest.version}
          </span>
        </div>
        <NativePluginSandboxStatus plugin={plugin} badge={badge} status={status} />
        {legacyAbi && (
          <p
            className="settings-panel__description"
            data-testid={`native-plugin-toolchain-warning-${id}`}
          >
            Built for plugin ABI 1.0: termiHub cannot verify which compiler built it, and a
            mismatched build can crash termiHub. Trusting it also accepts this risk. Ask the author
            for a build for ABI 1.1 or later.
          </p>
        )}
      </div>
      <div className="native-plugin-row__actions">
        {trustAction}
        {reducedAction}
        {restartAction}
        {revokeAction}
      </div>
      <ConfirmDialog
        open={confirmReduced}
        variant="warn"
        title={`Load ${name} with reduced isolation?`}
        message={
          <>
            {missingLayerWarning(missing)} The plugin can reach more of your system than a fully
            isolated plugin. termiHub remembers this choice for this exact plugin build only.
          </>
        }
        description={`Missing sandbox layers: ${missing.map(layerName).join(", ")}`}
        confirmLabel="Load with reduced isolation"
        confirmVariant="primary"
        confirmIcon={<ShieldAlert size={14} />}
        confirmErrorToast={false}
        confirmOnEnter={false}
        onConfirm={handleConfirmReduced}
        onCancel={() => setConfirmReduced(false)}
        testIdBase={`native-plugin-reduced-${id}`}
        data-testid={`native-plugin-reduced-dialog-${id}`}
      />
    </li>
  );
}
