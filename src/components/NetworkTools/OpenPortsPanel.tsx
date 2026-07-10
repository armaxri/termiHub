import { useState, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui";
import { networkOpenPorts } from "@/services/networkApi";
import type { OpenPort, PortProtocol } from "@/types/network";
import { DiagnosticResultsTable } from "./DiagnosticResultsTable";
import { frontendLog } from "@/utils/frontendLog";

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
        <label className="network-panel__field">
          <span>Filter</span>
          <input
            className="network-panel__input"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="address, process, pid…"
          />
        </label>
        <label className="network-panel__field network-panel__field--small">
          <span>Protocol</span>
          <select
            className="network-panel__select"
            value={protocolFilter}
            onChange={(e) => setProtocolFilter(e.target.value as PortProtocol | "All")}
          >
            <option value="All">All</option>
            <option value="TCP">TCP</option>
            <option value="UDP">UDP</option>
          </select>
        </label>
      </div>

      {error && <div className="network-panel__error">{error}</div>}

      {!loaded && ports.length === 0 && (
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
