/** Detect if the app is running on Windows via the webview user agent. */
export function isWindows(): boolean {
  return navigator.userAgent.includes("Windows");
}

/** Detect if the app is running on macOS via the webview user agent. */
export function isMac(): boolean {
  return navigator.userAgent.includes("Macintosh");
}

/** Return the current platform. */
export function getPlatform(): "windows" | "macos" | "linux" {
  if (isWindows()) return "windows";
  if (isMac()) return "macos";
  return "linux";
}

/** The platform identifiers {@link getPlatform} can return. */
export type Platform = ReturnType<typeof getPlatform>;

/**
 * Label for the "open the OS file manager" action, worded to match each
 * platform's native file manager (Finder / File Explorer / a generic file
 * manager on Linux). Pure so the wording is unit-testable on any CI platform.
 */
export function fileManagerActionLabel(platform: Platform = getPlatform()): string {
  switch (platform) {
    case "macos":
      return "Reveal in Finder";
    case "windows":
      return "Show in File Explorer";
    default:
      return "Open in File Manager";
  }
}
