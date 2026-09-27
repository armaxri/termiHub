import { useState } from "react";
import { Link } from "lucide-react";
import { downloadPluginFromUrl } from "@/services/api";
import { Button, Input, toast } from "@/components/ui";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import type { DownloadedPackageReview } from "@/components/Plugins/pluginDownloadReview";
import { reviewDownloadedPackage } from "@/components/Plugins/pluginDownloadReview";
import { SettingsField } from "./SettingsField";

/** Props for {@link PluginUrlInstall}. */
export interface PluginUrlInstallProps {
  /** Called with the verified package, to open the install dialog. */
  onReady: (review: DownloadedPackageReview) => void;
}

const SHA256_RE = /^[0-9a-fA-F]{64}$/;

/** Inline validation for the URL field; `null` when valid or still empty. */
export function urlFieldError(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;
  return trimmed.toLowerCase().startsWith("https://") ? null : "Only https:// URLs are allowed.";
}

/** Inline validation for the checksum field; `null` when valid or still empty. */
export function shaFieldError(sha: string): string | null {
  const trimmed = sha.trim();
  if (trimmed === "") return null;
  return SHA256_RE.test(trimmed) ? null : "A SHA-256 checksum is exactly 64 hex characters.";
}

/**
 * "Install from URL" (PROD-048): paste an HTTPS package URL and the SHA-256 the
 * publisher states. The backend downloads it, refuses it unless the checksum
 * matches, validates the package, and then the ordinary install dialog opens —
 * trust banner, permissions and confirmations all apply.
 */
export function PluginUrlInstall({ onReady }: PluginUrlInstallProps) {
  const [url, setUrl] = useState("");
  const [sha, setSha] = useState("");

  const urlError = urlFieldError(url);
  const shaError = shaFieldError(sha);
  const ready = url.trim() !== "" && sha.trim() !== "" && !urlError && !shaError;

  const handleDownload = async () => {
    const toastId = toast.loading("Downloading and verifying plugin…");
    try {
      const filePath = await downloadPluginFromUrl(url.trim(), sha.trim());
      const review = await reviewDownloadedPackage(filePath);
      toast.dismiss(toastId);
      setUrl("");
      setSha("");
      onReady(review);
    } catch (err) {
      frontendLog("plugin_catalog", `Install from URL failed: ${errorMessage(err)}`);
      toast.error(`Could not download the plugin: ${errorMessage(err)}`, { id: toastId });
      throw err;
    }
  };

  return (
    <div className="plugin-catalog__url" data-testid="plugin-url-install">
      <h4 className="plugin-catalog__subtitle">
        <Link size={14} aria-hidden="true" /> Install from URL
      </h4>
      <SettingsField
        label="Package URL"
        hint="An https:// link to a .termihub-plugin file."
        error={urlError ?? undefined}
      >
        <Input
          value={url}
          placeholder="https://example.com/my-plugin-1.0.0.termihub-plugin"
          onChange={(e) => setUrl(e.target.value)}
          spellCheck={false}
          data-testid="plugin-url-install-url"
        />
      </SettingsField>
      <SettingsField
        label="SHA-256 Checksum"
        hint="As published by the plugin author. The download is refused unless it matches."
        error={shaError ?? undefined}
      >
        <Input
          value={sha}
          placeholder="64 hex characters"
          onChange={(e) => setSha(e.target.value)}
          spellCheck={false}
          data-testid="plugin-url-install-sha"
        />
      </SettingsField>
      <div className="plugin-catalog__actions">
        <Button
          variant="secondary"
          size="sm"
          disabled={!ready}
          onClick={handleDownload}
          errorToast={false}
          data-testid="plugin-url-install-download"
        >
          Download &amp; review…
        </Button>
      </div>
    </div>
  );
}
