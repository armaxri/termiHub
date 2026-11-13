import { useAppStore } from "@/store/appStore";

/**
 * Display name of a registered connection type (e.g. `"Telnet"` for
 * `"telnet"`), or `undefined` when the type is not registered.
 *
 * Used to title the connect-time password prompt after the real transport
 * (#5617), so a telnet or VNC password is never presented as an SSH one.
 */
export function connectionTypeDisplayName(typeId: string): string | undefined {
  return useAppStore.getState().connectionTypes.find((t) => t.typeId === typeId)?.displayName;
}
