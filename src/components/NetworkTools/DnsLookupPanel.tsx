import { useState, useCallback } from "react";
import { Play } from "lucide-react";
import { Button } from "@/components/ui";
import { networkDnsLookup } from "@/services/networkApi";
import type { DnsRecord, DnsRecordType, DiagnosticStatus } from "@/types/network";
import { DiagnosticResultsTable } from "./DiagnosticResultsTable";
import { useAutofocusSelect } from "@/hooks/useAutofocusSelect";
import { useFormSubmit } from "@/hooks/useFormSubmit";
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

  const hostnameRef = useAutofocusSelect<HTMLInputElement>();

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

  // Enter submits the form (respects the Run button's disabled state).
  const handleSubmit = useFormSubmit(status !== "running" && !!hostname.trim(), handleRun);

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
    <form className="network-panel" data-testid="dns-lookup-panel" onSubmit={handleSubmit}>
      <div className="network-panel__header">
        <span className="network-panel__title">DNS Lookup</span>
        <div className="network-panel__actions">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            icon={<Play size={14} />}
            disabled={!hostname.trim() || status === "running"}
            data-testid="dns-run"
          >
            Run
          </Button>
        </div>
      </div>

      <div className="network-panel__form">
        <label className="network-panel__field">
          <span>Hostname</span>
          <input
            ref={hostnameRef}
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
        rowTestIdPrefix="dns-result"
        footer={
          queryMs != null
            ? `Query time: ${queryMs}ms · ${records.length} record(s) found`
            : status === "running"
              ? "Querying…"
              : null
        }
      />
    </form>
  );
}
