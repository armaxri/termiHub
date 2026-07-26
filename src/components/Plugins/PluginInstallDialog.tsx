import { Package, ShieldAlert } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import type { PluginManifest } from "@/types/plugin";
import { Button, Modal } from "@/components/ui";
import { PERMISSION_DESCRIPTIONS, PERMISSION_LABELS, pluginTypeLabel } from "./pluginPresentation";
import "./Plugins.css";

/** Props for {@link PluginInstallDialog}. */
export interface PluginInstallDialogProps {
  /** Absolute path to the validated `.termihub-plugin` package. */
  filePath: string;
  /** The manifest parsed from the package by `validate_plugin`. */
  manifest: PluginManifest;
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

/**
 * Install-from-file confirmation dialog (#1997). Renders on the shared Modal
 * overlay after a package is picked and validated: the parsed manifest (file,
 * name, version, author, type) and a Requested Permissions list where each
 * permission shows a shield-alert icon and a plain-language explanation. Cancel
 * aborts; "Install & Enable" installs the package and activates it.
 */
export function PluginInstallDialog({ filePath, manifest, onClose }: PluginInstallDialogProps) {
  const installPlugin = useAppStore((s) => s.installPlugin);
  const enablePlugin = useAppStore((s) => s.enablePlugin);
  const selectPlugin = useAppStore((s) => s.selectPlugin);

  const handleInstall = async () => {
    // installPlugin / enablePlugin own their own pending → success/error toasts
    // and re-throw on failure, so the async Button keeps the dialog open (and
    // shows the error) when either step fails. Clicking "Install & Enable" is the
    // user accepting the untrusted-source risk shown below, so `acceptUntrusted`
    // is passed as `true` (no plugin is signature-verified today).
    await installPlugin(filePath, true);
    await enablePlugin(manifest.id);
    selectPlugin(manifest.id);
    onClose();
  };

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
            Install &amp; Enable
          </Button>
        </>
      }
    >
      <div className="plugin-install__warning" data-testid="plugin-install-untrusted-warning">
        <ShieldAlert className="plugin-install__warning-icon" aria-hidden="true" />
        <div>
          <span className="plugin-install__warning-title">Untrusted source.</span>{" "}
          termiHub cannot verify who built this plugin — it is not signature-checked, and a native
          plugin runs with the same access as the app. Only install plugins you trust.
        </div>
      </div>

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
              <span className="plugin-install__perm-desc">— {PERMISSION_DESCRIPTIONS[perm]}</span>
            </div>
          </div>
        ))
      )}
    </Modal>
  );
}
