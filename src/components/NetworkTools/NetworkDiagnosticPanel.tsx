import type { NetworkDiagnosticMeta } from "@/types/terminal";
import "./NetworkTools.css";
import { PortScannerPanel } from "./PortScannerPanel";
import { PingPanel } from "./PingPanel";
import { DnsLookupPanel } from "./DnsLookupPanel";
import { HttpMonitorPanel } from "./HttpMonitorPanel";
import { TraceroutePanel } from "./TraceroutePanel";
import { WolPanel } from "./WolPanel";
import { OpenPortsPanel } from "./OpenPortsPanel";

interface NetworkDiagnosticPanelProps {
  meta: NetworkDiagnosticMeta;
  isVisible: boolean;
}

/**
 * Router component: renders the correct diagnostic panel based on `meta.tool`.
 */
export function NetworkDiagnosticPanel({ meta, isVisible }: NetworkDiagnosticPanelProps) {
  if (!isVisible) return null;

  switch (meta.tool) {
    case "port-scanner":
      return <PortScannerPanel prefillHost={meta.prefillHost} />;
    case "ping":
      return <PingPanel prefillHost={meta.prefillHost} />;
    case "dns-lookup":
      return <DnsLookupPanel prefillHost={meta.prefillHost} />;
    case "http-monitor":
      return <HttpMonitorPanel />;
    case "traceroute":
      return <TraceroutePanel prefillHost={meta.prefillHost} />;
    case "wol":
      return <WolPanel />;
    case "open-ports":
      return <OpenPortsPanel />;
    default:
      return (
        <div className="network-panel__error">
          Unknown tool: {(meta as NetworkDiagnosticMeta).tool}
        </div>
      );
  }
}
