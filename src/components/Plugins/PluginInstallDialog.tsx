import { useState } from "react";
import { Cpu, MonitorX, Package, ShieldAlert } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import type {
  PluginInstallConfirmations,
  PluginInstallPendingConfirmation,
  PluginManifest,
  PluginTrustInfo,
} from "@/types/plugin";
import { Button, Checkbox, Modal } from "@/components/ui";
import {
  PERMISSION_DESCRIPTIONS,
  PERMISSION_LABELS,
  pluginHasNativeCode,
  pluginTypeLabel,
  trustBanner,
} from "./pluginPresentation";
import { platformLabel, pluginPlatformSupport } from "./pluginPlatforms";
import { PluginPlatformList } from "./PluginPlatformList";
import { PluginSignerChangeDialog } from "./PluginSignerChangeDialog";
import { PluginVersionChangeDialog } from "./PluginVersionChangeDialog";
import "./Plugins.css";

/** Props for {@link PluginInstallDialog}. */
export interface PluginInstallDialogProps {
  /** Absolute path to the validated `.termihub-plugin` package. */
  filePath: string;
  /** The manifest parsed from the package by `preview_plugin`. */
  manifest: PluginManifest;
  /** The package's assessed trust (from `assess_plugin_trust`). */
  trust: PluginTrustInfo;
  /**
   * This computer's Rust target triple (from `preview_plugin`), used to mark
   * "this computer" in the supported-platform list. `null`/omitted when unknown.
   */
  hostPlatform?: string | null;
  /**
   * Whether the package ships a native library for this computer (PLG-011).
   * When `false` the dialog explains why it cannot be installed, lists the
   * platforms it does support, and offers no install action. Defaults to `true`.
   */
  platformSupported?: boolean;
  /** Called after a successful install, or on cancel/close. */
  onClose: () => void;
}

/** Basename of a path, tolerating both POSIX and Windows separators. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Title-case a plugin's primary type for the meta line (e.g. "Terminal Backend"). */
function typeTitle(manifest: PluginManifest): string {
  return pluginTypeLabel(manifest.extensions).replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The primary-button label for a given trust level and trust-checkbox state. */
function installButtonLabel(level: PluginTrustInfo["level"], trustPublisher: boolean): string {
  switch (level) {
    case "verified":
      return "Install & Enable";
    case "signed":
      return trustPublisher ? "Trust & Install" : "Install once";
    case "untrusted":
      return "Install Anyway";
    case "tampered":
      return "Close";
  }
}

/**
 * Install-from-file confirmation dialog (#1997, code-signing #2036). Renders on
 * the shared Modal overlay after a package is picked, validated, and its trust
 * assessed: a four-state **provenance banner** (verified / signed / unsigned /
 * tampered), the parsed manifest, and the Requested Permissions list.
 *
 * The banner and footer are driven by {@link PluginTrustInfo}: a verified
 * publisher installs with no risk gate; a signed-but-unknown key offers a
 * "Trust this publisher" checkbox (trust-on-first-use); an unsigned package
 * keeps the untrusted-source acknowledgement; a tampered package is hard-blocked
 * with no install action.
 *
 * When the package would replace an installed plugin with an older version, a
 * different build of the same version, or an uncomparable version, the backend
 * refuses and the dialog swaps to a {@link PluginVersionChangeDialog}; only an
 * explicit confirmation there re-issues the install (PLG-012).
 *
 * When the package is signed by a different key than the installed copy, is
 * unsigned where the installed copy was signed, or the installed copy's signer
 * is unknown, the backend refuses and the dialog swaps to a danger-styled
 * {@link PluginSignerChangeDialog} showing both fingerprints (#3489). If the
 * same install is also a downgrade / rebuild, that dialog covers both, and its
 * single explicit confirmation re-issues the install with both flags. This
 * applies equally to manual installs and to update-check installs, which hand
 * the downloaded package to this dialog.
 */
export function PluginInstallDialog({
  filePath,
  manifest,
  trust,
  hostPlatform = null,
  platformSupported = true,
  onClose,
}: PluginInstallDialogProps) {
  const installPlugin = useAppStore((s) => s.installPlugin);
  const enablePlugin = useAppStore((s) => s.enablePlugin);
  const selectPlugin = useAppStore((s) => s.selectPlugin);

  const [trustPublisher, setTrustPublisher] = useState(false);
  const [pending, setPending] = useState<PluginInstallPendingConfirmation | null>(null);

  const banner = trustBanner(trust);
  const BannerIcon = banner.icon;
  const unavailable = !platformSupported;
  const blocked = trust.isBlocked || unavailable;
  const isNative = pluginHasNativeCode(manifest.extensions);
  const platforms = pluginPlatformSupport(manifest, hostPlatform);

  const runInstall = async (confirmations: PluginInstallConfirmations) => {
    // installPlugin / enablePlugin own their own pending → success/error toasts
    // and re-throw on failure, so the async Button keeps the dialog open (and
    // shows the error) when either step fails. `acceptUntrusted` acknowledges an
    // unsigned package's risk; `trustPublisher` pins a signed key on first use.
    const acceptUntrusted = trust.level === "untrusted";
    const doTrust = trust.level === "signed" && trustPublisher;
    const next = await installPlugin(filePath, acceptUntrusted, doTrust, confirmations);
    if (next) {
      // Downgrade / rebuild and/or publisher-key change: nothing was installed;
      // ask first. Confirmations already given stay given on the re-issue.
      setPending(next);
      return;
    }
    await enablePlugin(manifest.id);
    selectPlugin(manifest.id);
    onClose();
  };

  const handleInstall = () => runInstall({});

  if (pending?.signer) {
    // The signer confirmation also covers any version change shown with it.
    const confirmVersionChange = pending.version !== null;
    return (
      <PluginSignerChangeDialog
        signer={pending.signer}
        version={pending.version}
        onConfirm={() => runInstall({ confirmSignerChange: true, confirmVersionChange })}
        onCancel={onClose}
      />
    );
  }

  if (pending?.version) {
    return (
      <PluginVersionChangeDialog
        change={pending.version}
        onConfirm={() => runInstall({ confirmVersionChange: true })}
        onCancel={onClose}
      />
    );
  }

  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Install Plugin"
      description={`Review ${manifest.name} before installing`}
      data-testid="plugin-install-dialog"
      footer={
        blocked ? (
          <Button variant="primary" onClick={onClose} data-testid="plugin-install-close">
            Close
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} data-testid="plugin-install-cancel">
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleInstall}
              errorToast={false}
              data-testid="plugin-install-confirm"
            >
              {installButtonLabel(trust.level, trustPublisher)}
            </Button>
          </>
        )
      }
    >
      {unavailable && (
        <div
          className="plugin-install__banner plugin-install__banner--danger"
          data-testid="plugin-install-platform-unavailable"
        >
          <MonitorX className="plugin-install__banner-icon" aria-hidden="true" />
          <div>
            <span className="plugin-install__banner-title">Not available for this computer</span>{" "}
            <span className="plugin-install__banner-desc">
              — {manifest.name} ships its native code only for the platforms listed below
              {hostPlatform ? `, not for ${platformLabel(hostPlatform)}` : ""}. It cannot be
              installed here; ask the publisher for a build for this computer.
            </span>
          </div>
        </div>
      )}

      {unavailable && platforms && (
        <>
          <div className="plugin-install__perm-title">Supported Platforms</div>
          <PluginPlatformList support={platforms} testIdBase="plugin-install" />
        </>
      )}

      {!unavailable && (
        <div
          className={`plugin-install__banner plugin-install__banner--${banner.tone}`}
          data-testid={`plugin-install-trust-${trust.level}`}
        >
          <BannerIcon className="plugin-install__banner-icon" aria-hidden="true" />
          <div>
            <span className="plugin-install__banner-title">{banner.title}</span>{" "}
            <span className="plugin-install__banner-desc">— {banner.description}</span>
            {trust.level === "signed" && (
              <label className="plugin-install__trust-check" htmlFor="plugin-trust-publisher">
                <Checkbox
                  id="plugin-trust-publisher"
                  checked={trustPublisher}
                  onCheckedChange={setTrustPublisher}
                  data-testid="plugin-install-trust-publisher"
                />
                <span>
                  <span className="plugin-install__trust-check-name">Trust this publisher</span>{" "}
                  <span className="plugin-install__banner-desc">
                    — pin the key so future updates verify automatically
                  </span>
                </span>
              </label>
            )}
          </div>
        </div>
      )}

      {!blocked && isNative && (
        <div className="plugin-install__native" data-testid="plugin-install-native-warning">
          <Cpu className="plugin-install__native-icon" aria-hidden="true" />
          <div>
            <span className="plugin-install__native-title">Native code — runs unsandboxed</span>{" "}
            <span className="plugin-install__native-desc">
              — this plugin includes a native terminal backend that loads into termiHub and runs
              with full application privileges. It is not sandboxed: once enabled it can access
              anything termiHub can — your files, network, and credentials — regardless of the
              permissions listed below. Only install native plugins from sources you trust.
            </span>
          </div>
        </div>
      )}

      {!blocked && (
        <>
          <div className="plugin-install__meta">
            <div className="plugin-install__row">
              <span className="plugin-install__label">File</span>
              <span className="plugin-install__file">
                <Package aria-hidden="true" />
                {baseName(filePath)}
              </span>
            </div>
            <div className="plugin-install__row">
              <span className="plugin-install__label">Plugin</span>
              <span>{manifest.name}</span>
            </div>
            <div className="plugin-install__row">
              <span className="plugin-install__label">Version</span>
              <span>{manifest.version}</span>
            </div>
            <div className="plugin-install__row">
              <span className="plugin-install__label">Author</span>
              <span>{manifest.author}</span>
            </div>
            <div className="plugin-install__row">
              <span className="plugin-install__label">Type</span>
              <span>{typeTitle(manifest)}</span>
            </div>
          </div>

          {platforms && (
            <>
              <div className="plugin-install__perm-title">Supported Platforms</div>
              <PluginPlatformList support={platforms} testIdBase="plugin-install" />
            </>
          )}

          <div className="plugin-install__perm-title">Requested Permissions</div>
          {manifest.permissions.length === 0 ? (
            <div className="plugin-install__perm-empty" data-testid="plugin-install-no-perms">
              This plugin requests no special permissions.
            </div>
          ) : (
            manifest.permissions.map((perm) => (
              <div
                className="plugin-install__perm"
                key={perm}
                data-testid={`plugin-install-perm-${perm}`}
              >
                <ShieldAlert className="plugin-install__perm-icon" aria-hidden="true" />
                <div>
                  <span className="plugin-install__perm-name">{PERMISSION_LABELS[perm]}</span>{" "}
                  <span className="plugin-install__perm-desc">
                    — {PERMISSION_DESCRIPTIONS[perm]}
                  </span>
                </div>
              </div>
            ))
          )}
        </>
      )}
    </Modal>
  );
}
