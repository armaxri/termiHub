import { useState, useEffect, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import { Button, Field, Input, Select } from "@/components/ui";
import { networkOpenPorts } from "@/services/networkApi";
import type { OpenPort, PortProtocol } from "@/types/network";
import { DiagnosticResultsTable } from "./DiagnosticResultsTable";
import { frontendLog } from "@/utils/frontendLog";

/** Protocol-filter dropdown options. */
const PROTOCOL_OPTIONS = [
  { value: "All", label: "All" },
  { value: "TCP", label: "TCP" },
  { value: "UDP", label: "UDP" },
];

/** Open Ports Viewer diagnostic tab content. */
export function OpenPortsPanel() {
  const [loaded, setLoaded] = useState(false);
  const [ports, setPorts] = useState<OpenPort[]>([]);
  const [filter, setFilter] = useState("");
  const [protocolFilter, setProtocolFilter] = useState<PortProtocol | "All">("All");
  const [error, setError] = useState<string | null>(null);

  const handleRefresh = useCallback(async () => {
    setError(null);
    try {
      const result = await networkOpenPorts();
      setPorts(result);
      setLoaded(true);
    } catch (err) {
      setError(String(err));
      frontendLog("open_ports", `Failed to list open ports: ${err}`);
      throw err; // keep the async Button in its error path (no false success flash)
    }
  }, []);

  // Auto-load listening ports on mount so the panel opens populated; Refresh
  // remains for an explicit re-fetch. The handler throws to keep the Refresh
  // Button's error path, so swallow that here (the error is already surfaced
  // inline via setError).
  useEffect(() => {
    void handleRefresh().catch(() => {});
  }, [handleRefresh]);

  const filtered = ports.filter((p) => {
    if (protocolFilter !== "All" && p.protocol !== protocolFilter) return false;
    if (filter) {
      const q = filter.toLowerCase();
      return (
        p.localAddr.toLowerCase().includes(q) ||
        (p.process ?? "").toLowerCase().includes(q) ||
        String(p.pid ?? "").includes(q)
      );
    }
    return true;
  });

  const columns = [
    { key: "protocol", label: "Proto" },
    { key: "localAddr", label: "Local Address" },
    { key: "pid", label: "PID" },
    { key: "process", label: "Process" },
  ];

  const formattedRows = filtered.map((p) => ({
    protocol: p.protocol,
    localAddr: p.localAddr,
    pid: p.pid ?? "—",
    process: p.process ?? "—",
  }));

  return (
    <div className="network-panel" data-testid="open-ports-panel">
      <div className="network-panel__header">
        <span className="network-panel__title">Open Ports</span>
        <div className="network-panel__actions">
          <Button
            variant="primary"
            size="sm"
            icon={<RefreshCw size={14} />}
            pendingLabel="Refreshing…"
            errorToast={false}
            onClick={handleRefresh}
            data-testid="open-ports-refresh"
          >
            Refresh
          </Button>
        </div>
      </div>

      <div className="network-panel__form">
        <Field className="network-panel__field" label="Filter" htmlFor="open-ports-filter">
          <Input
            id="open-ports-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="address, process, pid…"
            data-testid="open-ports-filter"
          />
        </Field>
        <Field
          className="network-panel__field network-panel__field--small"
          label="Protocol"
          htmlFor="open-ports-protocol"
        >
          <Select
            value={protocolFilter}
            onChange={(value) => setProtocolFilter(value as PortProtocol | "All")}
            options={PROTOCOL_OPTIONS}
            aria-label="Protocol filter"
            data-testid="open-ports-protocol"
          />
        </Field>
      </div>

      {error && <div className="network-panel__error">{error}</div>}

      {!loaded && (
        <div className="network-panel__placeholder">Click Refresh to list listening ports</div>
      )}

      <DiagnosticResultsTable
        columns={columns}
        rows={formattedRows}
        footer={
          loaded
            ? `${filtered.length} listening port(s)${filter ? ` (filtered from ${ports.length})` : ""}`
            : null
        }
      />
    </div>
  );
}
