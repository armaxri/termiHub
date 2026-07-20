import { useState, useEffect, useCallback } from "react";
import { Trash2 } from "lucide-react";
import { rdpTrustList, rdpTrustForget, type RdpTrustedHost } from "@/services/api";
import { Button, Tooltip, toast } from "@/components/ui";
import { frontendLog } from "@/utils/frontendLog";

interface RdpTrustSettingsProps {
  visibleFields?: Set<string>;
}

/**
 * Settings section to review and revoke remembered RDP server-certificate trust
 * (#1784). Lists each host trusted via the interactive cert-trust prompt (#1767)
 * and lets the user forget a single fingerprint or a whole host, so the next
 * connect to that host prompts again.
 */
export function RdpTrustSettings({ visibleFields }: RdpTrustSettingsProps) {
  const [hosts, setHosts] = useState<RdpTrustedHost[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setHosts(await rdpTrustList());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      frontendLog("rdp_trust_settings", `failed to load trust store: ${message}`);
      toast.error(`Failed to load remembered RDP certificates: ${message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleForgetFingerprint = useCallback(async (host: string, fingerprint: string) => {
    try {
      await rdpTrustForget(host, fingerprint);
      // Drop the fingerprint locally, and the host once its last one is gone —
      // matching the backend, which removes an emptied host so it re-prompts.
      setHosts((prev) =>
        prev
          .map((h) =>
            h.host === host
              ? { ...h, fingerprints: h.fingerprints.filter((f) => f !== fingerprint) }
              : h
          )
          .filter((h) => h.fingerprints.length > 0)
      );
      toast.success(`Revoked certificate for ${host}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to revoke certificate: ${message}`);
      throw err; // keep the async Button in its error path (no success flash)
    }
  }, []);

  const handleForgetHost = useCallback(async (host: string) => {
    try {
      await rdpTrustForget(host);
      setHosts((prev) => prev.filter((h) => h.host !== host));
      toast.success(`Forgot all remembered certificates for ${host}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to forget host: ${message}`);
      throw err; // keep the async Button in its error path (no success flash)
    }
  }, []);

  if (visibleFields && !visibleFields.has("rdpTrustedCertificates")) return null;

  return (
    <div className="settings-panel__category">
      <div className="settings-panel__section" data-testid="settings-rdp-trust">
        <h3 className="settings-panel__section-title">Remembered RDP Certificates</h3>
        <p className="settings-panel__description">
          Hosts whose RDP server certificate you chose to trust ("Accept for host") are remembered
          here. Revoke a single fingerprint or forget a host to be prompted again on the next
          connect.
        </p>

        {loading ? (
          <p className="settings-panel__empty">Loading…</p>
        ) : hosts.length === 0 ? (
          <p className="settings-panel__empty" data-testid="rdp-trust-empty">
            No remembered RDP certificates.
          </p>
        ) : (
          hosts.map((h) => (
            <div key={h.host} className="settings-panel__field" data-testid="rdp-trust-host">
              <div className="settings-panel__section-header">
                <h4 className="settings-panel__subsection-title">{h.host}</h4>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleForgetHost(h.host)}
                  errorToast={false}
                  aria-label={`Forget all remembered certificates for ${h.host}`}
                >
                  Forget host
                </Button>
              </div>
              <ul className="settings-panel__file-list">
                {h.fingerprints.map((fp) => (
                  <li key={fp} className="settings-panel__file-item">
                    <code className="settings-panel__file-path">{fp}</code>
                    <Tooltip content="Revoke this certificate">
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        icon={<Trash2 size={14} />}
                        onClick={() => handleForgetFingerprint(h.host, fp)}
                        errorToast={false}
                        aria-label={`Revoke certificate ${fp} for ${h.host}`}
                      />
                    </Tooltip>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
