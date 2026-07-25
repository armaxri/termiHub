import { useState, useEffect, useCallback } from "react";
import { Trash2 } from "lucide-react";
import { sshTrustList, sshTrustForget, type SshTrustedHost } from "@/services/api";
import { Button, Tooltip, toast } from "@/components/ui";
import { frontendLog } from "@/utils/frontendLog";

interface SshTrustSettingsProps {
  visibleFields?: Set<string>;
}

/**
 * Settings section to review and revoke remembered SSH host-key trust (#1968).
 * Lists each host trusted via the interactive host-key trust prompt (#1959) and
 * lets the user forget a single fingerprint or a whole host, so the next connect
 * to that host prompts again. The SSH analogue of {@link RdpTrustSettings}.
 */
export function SshTrustSettings({ visibleFields }: SshTrustSettingsProps) {
  const [hosts, setHosts] = useState<SshTrustedHost[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setHosts(await sshTrustList());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      frontendLog("ssh_trust_settings", `failed to load trust store: ${message}`);
      toast.error(`Failed to load remembered SSH host keys: ${message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleForgetFingerprint = useCallback(async (host: string, fingerprint: string) => {
    try {
      await sshTrustForget(host, fingerprint);
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
      toast.success(`Revoked host key for ${host}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to revoke host key: ${message}`);
      throw err; // keep the async Button in its error path (no success flash)
    }
  }, []);

  const handleForgetHost = useCallback(async (host: string) => {
    try {
      await sshTrustForget(host);
      setHosts((prev) => prev.filter((h) => h.host !== host));
      toast.success(`Forgot all remembered host keys for ${host}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to forget host: ${message}`);
      throw err; // keep the async Button in its error path (no success flash)
    }
  }, []);

  if (visibleFields && !visibleFields.has("sshTrustedHostKeys")) return null;

  return (
    <div className="settings-panel__category">
      <div className="settings-panel__section" data-testid="settings-ssh-trust">
        <h3 className="settings-panel__section-title">Remembered SSH Host Keys</h3>
        <p className="settings-panel__description">
          Hosts whose SSH host key you chose to trust ("Accept for host") are remembered here.
          Revoke a single fingerprint or forget a host to be prompted again on the next connect.
        </p>

        {loading ? (
          <p className="settings-panel__empty">Loading…</p>
        ) : hosts.length === 0 ? (
          <p className="settings-panel__empty" data-testid="ssh-trust-empty">
            No remembered SSH host keys.
          </p>
        ) : (
          hosts.map((h) => (
            <div key={h.host} className="settings-panel__field" data-testid="ssh-trust-host">
              <div className="settings-panel__section-header">
                <h4 className="settings-panel__subsection-title">{h.host}</h4>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleForgetHost(h.host)}
                  errorToast={false}
                  aria-label={`Forget all remembered host keys for ${h.host}`}
                >
                  Forget host
                </Button>
              </div>
              <ul className="settings-panel__file-list">
                {h.fingerprints.map((fp) => (
                  <li key={fp} className="settings-panel__file-item">
                    <code className="settings-panel__file-path">{fp}</code>
                    <Tooltip content="Revoke this host key">
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        icon={<Trash2 size={14} />}
                        onClick={() => handleForgetFingerprint(h.host, fp)}
                        errorToast={false}
                        aria-label={`Revoke host key ${fp} for ${h.host}`}
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
