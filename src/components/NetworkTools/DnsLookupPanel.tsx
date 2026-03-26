import { useState, useCallback } from "react";
import { Play } from "lucide-react";
import { networkDnsLookup } from "@/services/networkApi";
import type { DnsRecord, DnsRecordType, DiagnosticStatus } from "@/types/network";
import { DiagnosticResultsTable } from "./DiagnosticResultsTable";
import { frontendLog } from "@/utils/frontendLog";

const RECORD_TYPES: DnsRecordType[] = [
  "A",
  "AAAA",
  "MX",
  "CNAME",
  "NS",
  "TXT",
  "SRV",
  "SOA",
  "PTR",
  "ANY",
];

interface DnsLookupPanelProps {
  prefillHost?: string;
}

/** DNS Lookup diagnostic tab content. */
export function DnsLookupPanel({ prefillHost }: DnsLookupPanelProps) {
  const [hostname, setHostname] = useState(prefillHost ?? "");
  const [recordType, setRecordType] = useState<DnsRecordType>("A");
  const [server, setServer] = useState("");
  const [status, setStatus] = useState<DiagnosticStatus>("idle");
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [queryMs, setQueryMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRun = useCallback(async () => {
    if (!hostname.trim()) return;
    setStatus("running");
    setRecords([]);
    setQueryMs(null);
    setError(null);

    try {
      const result = await networkDnsLookup(hostname, recordType, server.trim() || undefined);
      setRecords(result.records);
      setQueryMs(result.queryMs);
      setStatus("completed");
    } catch (err) {
      setError(String(err));
      setStatus("error");
      frontendLog("dns_lookup", `DNS lookup failed: ${err}`);
    }
  }, [hostname, recordType, server]);

  const columns = [
    { key: "recordType", label: "Type" },
    { key: "name", label: "Name" },
    { key: "value", label: "Value" },
    { key: "ttl", label: "TTL" },
  ];

  const formattedRows = records.map((r) => ({
    recordType: r.recordType,
    name: r.name,
    value: r.value,
    ttl: `${r.ttl}s`,
  }));

  return (
    <div className="network-panel" data-testid="dns-lookup-panel">
      <div className="network-panel__header">
        <span className="network-panel__title">DNS Lookup</span>
        <div className="network-panel__actions">
          <button
            className="network-panel__btn network-panel__btn--run"
            onClick={handleRun}
            disabled={!hostname.trim() || status === "running"}
            data-testid="dns-run"
          >
            <Play size={14} />
            Run
          </button>
        </div>
      </div>

      <div className="network-panel__form">
        <label className="network-panel__field">
          <span>Hostname</span>
          <input
            className="network-panel__input"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder="example.com"
            data-testid="dns-hostname"
          />
        </label>
        <label className="network-panel__field network-panel__field--small">
          <span>Type</span>
          <select
            className="network-panel__select"
            value={recordType}
            onChange={(e) => setRecordType(e.target.value as DnsRecordType)}
            data-testid="dns-record-type"
          >
            {RECORD_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="network-panel__field network-panel__field--small">
          <span>Server (auto)</span>
          <input
            className="network-panel__input"
            value={server}
            onChange={(e) => setServer(e.target.value)}
            placeholder="8.8.8.8"
          />
        </label>
      </div>

      {error && <div className="network-panel__error">{error}</div>}

      <DiagnosticResultsTable
        columns={columns}
        rows={formattedRows}
        footer={
          queryMs != null
            ? `Query time: ${queryMs}ms · ${records.length} record(s) found`
            : status === "running"
              ? "Querying…"
              : null
        }
      />
    </div>
  );
}
