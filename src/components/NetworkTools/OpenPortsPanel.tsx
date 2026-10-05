import { useState, useEffect, useCallback, useRef } from "react";
import { RefreshCw } from "lucide-react";
import { Button, Field, Input, Select } from "@/components/ui";
import { networkOpenPorts } from "@/services/networkApi";
import type { OpenPort, PortProtocol } from "@/types/network";
import { DiagnosticResultsTable } from "./DiagnosticResultsTable";
import { openPortsTable } from "./exportResults";
import { NetworkToolHistory } from "./NetworkToolHistory";
import { recordToolRun } from "./runHistory";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import { useRunLocationStore } from "@/store/runLocationStore";

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
  const [loading, setLoading] = useState(false);
  const inFlight = useRef<Promise<void> | null>(null);

  const runListing = useCallback(async () => {
    setError(null);
    const startedAt = new Date().toISOString();
    try {
      const result = await networkOpenPorts();
      setPorts(result);
      setLoaded(true);
      void recordToolRun({
        tool: "open-ports",
        status: "completed",
        startedAt,
        params: {},
        summary: `${result.length} listening port(s)`,
        table: openPortsTable(result),
      });
    } catch (err) {
      setError(errorMessage(err));
      void recordToolRun({
        tool: "open-ports",
        status: "error",
        startedAt,
        params: {},
        summary: "Listing failed",
        error: errorMessage(err),
      });
      frontendLog("open_ports", `Failed to list open ports: ${errorMessage(err)}`);
      throw err; // keep the async Button in its error path (no false success flash)
    }
  }, []);

  // One listing at a time (#3814): a Refresh or history re-run while the
  // mount-load (or an earlier Refresh) is still in flight joins that run
  // instead of stacking a second backend listing.
  const handleRefresh = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    setLoading(true);
    const run = runListing().finally(() => {
      inFlight.current = null;
      setLoading(false);
    });
    inFlight.current = run;
    return run;
  }, [runListing]);

  // Auto-load listening ports on mount so the panel opens populated; Refresh
  // remains for an explicit re-fetch. The handler throws to keep the Refresh
  // Button's error path, so swallow that here (the error is already surfaced
  // inline via setError).
  useEffect(() => {
    void handleRefresh().catch(() => {});
  }, [handleRefresh]);

  // The list belongs to one vantage (this computer or an agent host, PROD-033).
  // When "Run on" changes, drop the stale list rather than show one host's
  // ports under another's label; Refresh then lists the new vantage. (An
  // automatic re-fetch here could race the backend recording the new choice.)
  const location = useRunLocationStore((s) => s.networkToolLocations["open-ports"]);
  const previousLocation = useRef(location);
  useEffect(() => {
    if (previousLocation.current === location) return;
    previousLocation.current = location;
    setPorts([]);
    setLoaded(false);
    setError(null);
  }, [location]);

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
            disabled={loading}
            aria-busy={loading || undefined}
            data-testid="open-ports-refresh"
          >
            {loading ? "Refreshing…" : "Refresh"}
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
        <div className="network-panel__placeholder" data-testid="open-ports-placeholder">
          {loading ? "Listing listening ports…" : "Click Refresh to list listening ports"}
        </div>
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

      <NetworkToolHistory
        tool="open-ports"
        onRerun={() => void handleRefresh().catch(() => {})}
        rerunDisabled={loading}
      />
    </div>
  );
}
