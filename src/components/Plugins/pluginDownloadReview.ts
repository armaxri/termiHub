import { assessPluginTrust, previewPlugin } from "@/services/api";
import type { PluginManifest, PluginTrustInfo } from "@/types/plugin";

/**
 * A downloaded, checksum-verified package awaiting the install dialog — the
 * props {@link PluginInstallDialog} needs, shared by every flow that obtains a
 * package from the network (update check, plugin index, pasted URL).
 */
export interface DownloadedPackageReview {
  filePath: string;
  manifest: PluginManifest;
  trust: PluginTrustInfo;
  /** This computer's target triple (PLG-011, #3507). */
  hostPlatform: string;
  /** Whether the package ships a native library for this computer. */
  platformSupported: boolean;
}

/**
 * Read the install preview and trust assessment of a verified package at
 * `filePath` — exactly what a manual "Install from file…" shows — so a
 * network-obtained package goes through the same install dialog and gates.
 */
export async function reviewDownloadedPackage(filePath: string): Promise<DownloadedPackageReview> {
  const [preview, trust] = await Promise.all([
    previewPlugin(filePath),
    assessPluginTrust(filePath),
  ]);
  const { manifest, hostPlatform, platformSupported } = preview;
  return { filePath, manifest, trust, hostPlatform, platformSupported };
}
