/**
 * Re-export of the desktop-version wrapper. The implementation now lives in
 * {@link useAppInfo}, which owns the single cached `getAppInfo` fetch shared by
 * every consumer; this module is kept so existing `@/hooks/useDesktopVersion`
 * imports (agent badges, status-bar summary) keep working unchanged.
 */
export { useDesktopVersion } from "./useAppInfo";
