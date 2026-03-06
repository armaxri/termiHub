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
