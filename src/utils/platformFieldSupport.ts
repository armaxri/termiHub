/**
 * Honest annotations for schema-driven connection fields whose backend feature
 * is not implemented on the current platform (audit PROD-019).
 *
 * Some connection settings map to an OS-specific capability that simply does
 * nothing on other platforms — e.g. RDP audio output redirection (rdpsnd) is not
 * wired up on Linux. Rather than let the user toggle a control that has no
 * effect, the form disables such a field on the unsupported platform and shows a
 * short note explaining why.
 *
 * This is a small, explicit lookup keyed by the schema field key — not a new
 * capability system. Platform detection reuses the app's existing frontend OS
 * detection ({@link getPlatform}, `src/utils/platform.ts`).
 */

import { getPlatform, type Platform } from "@/utils/platform";

/**
 * The note to show for `fieldKey` on `platform` when its backend feature is
 * unavailable there, or `null` when the field is fully supported.
 *
 * A non-null result means the control should also be rendered disabled — the
 * feature does nothing on this platform, so the toggle must not be flippable.
 */
export function fieldPlatformLimitation(
  fieldKey: string,
  platform: Platform = getPlatform()
): string | null {
  // RDP audio output redirection (rdpsnd) is implemented on macOS and Windows
  // only; the Linux sidecar build omits the audio backend (#1764).
  if (fieldKey === "audioRedirection" && platform === "linux") {
    return "Not available on Linux — audio output redirection (rdpsnd) isn't implemented on the Linux build yet.";
  }
  return null;
}
