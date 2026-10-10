import { useCallback, useState } from "react";
import { RotateCcw, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { Button, ConfirmDialog } from "@/components/ui";
import type { PluginSandboxStatus, PluginSandboxView } from "@/store/pluginSandboxBridge";
import type { InstalledPlugin } from "@/types/plugin";
import type { NativeAckInfo } from "@/types/generated/NativeAckInfo";
import { NativePluginSandboxStatus } from "./NativePluginSandboxStatus";
import { accessChips, isolationBadge, layerName, missingLayerWarning } from "./nativePluginSandbox";

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

/**
 * Why a recorded acknowledgement no longer covers the installed plugin
 * (#4294), or `undefined` when it does (or there is none). The host refuses a
 * stale one, so the row must never call such a plugin trusted.
 */
export function staleAckReason(ack: NativeAckInfo | undefined): string | undefined {
  switch (ack?.state) {
    case undefined:
    case "current":
      return undefined;
    case "accessChanged":
      return ack.addedAccess.length > 0
        ? `Permissions changed — review. This version asks for access you have not approved: ${ack.addedAccess.join(", ")}.`
        : "Permissions changed — review. This version asks for different access than you approved.";
    case "accessNotRecorded":
      return "Permissions changed — review. termiHub now records the access you approve; check what this plugin can reach and trust it again.";
    case "libraryChanged":
      return "The plugin changed since you trusted it. Trust the new build to load it.";
    case "unavailable":
      return "termiHub cannot read this plugin's library or manifest, so it does not load.";
  }
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
  const [reviewAccess, setReviewAccess] = useState(false);
  const id = plugin.manifest.id;
  const name = plugin.manifest.name;
  const legacyAbi = predatesToolchainRecord(plugin);
  // A stale acknowledgement — the library or the requested access changed, or
  // it predates access binding — is refused by the host (#4294), and so is a
  // 1.0 plugin trusted without the toolchain acceptance: both are offered for
  // (re-)trust, never shown as trusted.
  const staleReason = staleAckReason(ack);
  const stale = staleReason !== undefined;
  const accessStale = ack?.state === "accessChanged" || ack?.state === "accessNotRecorded";
  const isTrusted = ack !== undefined && !stale && (!legacyAbi || ack.unverifiedToolchainAccepted);
  const status: PluginSandboxStatus | undefined = sandbox.plugins[id];
  const badge = isolationBadge(plugin, status, isTrusted);
  const missing = status?.missing ?? [];

  const handleConfirmReduced = useCallback(async () => {
    await onAcceptReducedIsolation(plugin, legacyAbi);
    setConfirmReduced(false);
  }, [onAcceptReducedIsolation, plugin, legacyAbi]);

  const handleConfirmReview = useCallback(async () => {
    await onTrust(plugin, legacyAbi);
    setReviewAccess(false);
  }, [onTrust, plugin, legacyAbi]);

  const trustAction = !isTrusted && ack?.state !== "unavailable" && (
    <Button
      variant="secondary"
      size="sm"
      icon={<ShieldCheck size={14} />}
      onClick={() => (accessStale ? setReviewAccess(true) : onTrust(plugin, legacyAbi))}
      disabled={!nativeEnabled}
      errorToast={false}
      aria-label={accessStale ? `Review permissions for ${name}` : `Trust ${name}`}
      data-testid={`native-plugin-trust-${id}`}
    >
      {accessStale
        ? "Permissions changed — review"
        : ack?.state === "libraryChanged"
          ? "Trust new build"
          : "Trust & Load"}
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
  const revokeAction = (isTrusted || stale) && (
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
            · {isTrusted ? "trusted" : stale ? "needs re-approval" : "not trusted"} · v
            {plugin.manifest.version}
          </span>
        </div>
        {staleReason && (
          <p className="settings-panel__description" data-testid={`native-plugin-stale-${id}`}>
            {staleReason}
          </p>
        )}
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
            {missingLayerWarning(missing, status?.enforced ?? [])} The plugin can reach more of your
            system than a fully isolated plugin. termiHub remembers this choice for this exact
            plugin build only.
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
      <ConfirmDialog
        open={reviewAccess}
        variant="warn"
        title={`Review the access ${name} asks for`}
        message={
          (ack?.state === "accessChanged" && ack.addedAccess.length > 0
            ? `New since you approved it: ${ack.addedAccess.join(", ")}. `
            : "What you approved earlier no longer matches this plugin. ") +
          "Trusting it again lets it use:"
        }
        confirmLabel="Trust & Load"
        confirmVariant="primary"
        confirmIcon={<ShieldCheck size={14} />}
        confirmErrorToast={false}
        confirmOnEnter={false}
        onConfirm={handleConfirmReview}
        onCancel={() => setReviewAccess(false)}
        testIdBase={`native-plugin-review-${id}`}
        data-testid={`native-plugin-review-dialog-${id}`}
      >
        <ul
          className="native-plugin-review__access"
          data-testid={`native-plugin-review-access-${id}`}
        >
          {accessChips(plugin, status)
            .filter((chip) => !chip.denied)
            .map((chip) => (
              <li key={chip.id}>
                {chip.label}: {chip.rule}
              </li>
            ))}
        </ul>
      </ConfirmDialog>
    </li>
  );
}
