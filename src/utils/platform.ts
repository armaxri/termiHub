/** Detect if the app is running on Windows via the webview user agent. */
export function isWindows(): boolean {
  return navigator.userAgent.includes("Windows");
}
