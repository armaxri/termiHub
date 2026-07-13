import { useState, useCallback, useRef } from "react";
import { Play, StopCircle } from "lucide-react";
import { Button, Field, Input, Select } from "@/components/ui";
import { networkDnsLookup } from "@/services/networkApi";
import type { DnsRecord, DnsRecordType, DnsResult } from "@/types/network";
import { DiagnosticResultsTable } from "./DiagnosticResultsTable";
import { validateHost } from "@/utils/fieldValidation";
import { useAutofocusSelect } from "@/hooks/useAutofocusSelect";
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

/** Bound a hung resolver so the lookup can never hang the panel indefinitely. */
const DNS_TIMEOUT_MS = 10_000;

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
  const [running, setRunning] = useState(false);

  const hostnameRef = useAutofocusSelect<HTMLInputElement>();

  // Rejects the in-flight lookup when the user cancels; null while idle.
  const cancelRef = useRef<(() => void) | null>(null);

  const hostnameError = validateHost(hostname, "Hostname");

  const handleRun = useCallback(async () => {
    if (!hostname.trim()) return;
    setRecords([]);
    setQueryMs(null);
    setError(null);
    setRunning(true);

    try {
      // Race the lookup against a bounded timeout and a user Cancel so a hung
      // resolver can never leave the panel spinning forever.
      const result = await new Promise<DnsResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          cancelRef.current = null;
          reject(new Error(`DNS lookup timed out after ${DNS_TIMEOUT_MS / 1000}s`));
        }, DNS_TIMEOUT_MS);
        cancelRef.current = () => {
          clearTimeout(timer);
          cancelRef.current = null;
          reject(new Error("DNS lookup canceled"));
        };
        networkDnsLookup(hostname, recordType, server.trim() || undefined)
          .then((r) => {
            clearTimeout(timer);
            cancelRef.current = null;
            resolve(r);
          })
          .catch((e) => {
            clearTimeout(timer);
            cancelRef.current = null;
            reject(e instanceof Error ? e : new Error(String(e)));
          });
      });
      setRecords(result.records);
      setQueryMs(result.queryMs);
    } catch (err) {
      setError(String(err));
      frontendLog("dns_lookup", `DNS lookup failed: ${err}`);
      throw err; // keep the async Button in its error path (no false success flash)
    } finally {
      setRunning(false);
    }
  }, [hostname, recordType, server]);

  const handleCancel = useCallback(() => {
    cancelRef.current?.();
  }, []);

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
    <form className="network-panel" data-testid="dns-lookup-panel">
      <div className="network-panel__header">
        <span className="network-panel__title">DNS Lookup</span>
        <div className="network-panel__actions">
          {running && (
            <Button
              variant="danger"
              size="sm"
              icon={<StopCircle size={14} />}
              onClick={handleCancel}
              data-testid="dns-cancel"
            >
              Cancel
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            icon={<Play size={14} />}
            pendingLabel="Looking up…"
            errorToast={false}
            type="submit"
            disabled={!!hostnameError}
            onClick={handleRun}
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
