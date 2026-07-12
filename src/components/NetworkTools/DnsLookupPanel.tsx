import { useState, useCallback } from "react";
import { Play } from "lucide-react";
import { Button, Field, Input, Select } from "@/components/ui";
import { networkDnsLookup } from "@/services/networkApi";
import type { DnsRecord, DnsRecordType } from "@/types/network";
import { DiagnosticResultsTable } from "./DiagnosticResultsTable";
import { validateHost } from "@/utils/fieldValidation";
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

/** Record-type dropdown options (value === label), derived once. */
const RECORD_TYPE_OPTIONS = RECORD_TYPES.map((t) => ({ value: t, label: t }));

interface DnsLookupPanelProps {
  prefillHost?: string;
}

/** DNS Lookup diagnostic tab content. */
export function DnsLookupPanel({ prefillHost }: DnsLookupPanelProps) {
  const [hostname, setHostname] = useState(prefillHost ?? "");
  const [recordType, setRecordType] = useState<DnsRecordType>("A");
  const [server, setServer] = useState("");
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [queryMs, setQueryMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hostnameRef = useAutofocusSelect<HTMLInputElement>();

  const hostnameError = validateHost(hostname, "Hostname");

  const handleRun = useCallback(async () => {
    if (!hostname.trim()) return;
    setRecords([]);
    setQueryMs(null);
    setError(null);

    try {
      const result = await networkDnsLookup(hostname, recordType, server.trim() || undefined);
      setRecords(result.records);
      setQueryMs(result.queryMs);
    } catch (err) {
      setError(String(err));
      frontendLog("dns_lookup", `DNS lookup failed: ${err}`);
      throw err; // keep the async Button in its error path (no false success flash)
    }
  }, [hostname, recordType, server]);

  // Enter submits the form; a mouse click goes through the Button's onClick so its
  // async lifecycle drives the pending affordance (useFormSubmit swallows the
  // Enter-path rejection that the click path uses to drive the Button error state).
  const handleSubmit = useFormSubmit(!hostnameError, handleRun);

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
            pendingLabel="Looking up…"
            errorToast={false}
            disabled={!!hostnameError}
            onClick={(e) => {
              e.preventDefault();
              return handleRun();
            }}
            data-testid="dns-run"
          >
            Run
          </Button>
        </div>
      </div>

      <div className="network-panel__form">
        <Field
          className="network-panel__field"
          label="Hostname"
          htmlFor="dns-hostname"
          error={hostnameError ?? undefined}
        >
          <Input
            ref={hostnameRef}
            id="dns-hostname"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder="example.com"
            error={!!hostnameError}
            data-testid="dns-hostname"
          />
        </Field>
        <Field
          className="network-panel__field network-panel__field--small"
          label="Type"
          htmlFor="dns-record-type"
        >
          <Select
            value={recordType}
            onChange={(value) => setRecordType(value as DnsRecordType)}
            options={RECORD_TYPE_OPTIONS}
            aria-label="Record type"
            data-testid="dns-record-type"
          />
        </Field>
        <Field
          className="network-panel__field network-panel__field--small"
          label="Server (auto)"
          htmlFor="dns-server"
        >
          <Input
            id="dns-server"
            value={server}
            onChange={(e) => setServer(e.target.value)}
            placeholder="8.8.8.8"
            data-testid="dns-server"
          />
        </Field>
      </div>

      {error && <div className="network-panel__error">{error}</div>}

      <DiagnosticResultsTable
        columns={columns}
        rows={formattedRows}
        rowTestIdPrefix="dns-result"
        footer={
          queryMs != null ? `Query time: ${queryMs}ms · ${records.length} record(s) found` : null
        }
      />
    </form>
  );
}
