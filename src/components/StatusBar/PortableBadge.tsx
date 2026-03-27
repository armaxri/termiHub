import { HardDrive } from "lucide-react";
import { useAppStore } from "@/store/appStore";

/**
 * Status bar badge shown when termiHub is running in portable mode.
 * Displays the portable data directory path as a tooltip on hover.
 */
export function PortableBadge() {
  const isPortableMode = useAppStore((s) => s.isPortableMode);
  const portableDataDir = useAppStore((s) => s.portableDataDir);

  if (!isPortableMode) return null;

  return (
    <span
      className="status-bar__item portable-badge"
      title={portableDataDir ? `Portable mode — data: ${portableDataDir}` : "Portable mode"}
      data-testid="portable-badge"
    >
      <HardDrive size={12} />
      Portable
    </span>
  );
}
