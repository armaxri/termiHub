import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { listTrustedPublishers, revokeTrustedPublisher } from "@/services/api";
import type { TrustedPublisher } from "@/types/plugin";
import { Button, Tooltip, toast } from "@/components/ui";
import { fingerprintShort } from "@/components/Plugins/pluginPresentation";
import { frontendLog } from "@/utils/frontendLog";

/**
 * Settings → Plugins → Trusted Publishers (#2036). Lists every publisher key the
 * trust store holds — bundled first-party keys (immutable) and user-pinned keys
 * (revocable) — with its label, fingerprint and source. Revoking a pinned key
 * drops packages from it back to "signed (unknown)" on the next install/update;
 * it does not uninstall already-installed plugins. The plugin analogue of
 * {@link SshTrustSettings}.
 */
export function TrustedPublishersSettings() {
  const [publishers, setPublishers] = useState<TrustedPublisher[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setPublishers(await listTrustedPublishers());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      frontendLog("trusted_publishers", `failed to load trust store: ${message}`);
      toast.error(`Failed to load trusted publishers: ${message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // A pin/revoke elsewhere (e.g. a trust-on-first-use install) emits the
    // plugin-changed event; re-fetch so the list stays current.
    const unlisten = listen("plugin-changed", () => void load());
    return () => {
      void unlisten.then((off) => off());
    };
  }, [load]);

  const handleRevoke = useCallback(async (publisher: TrustedPublisher) => {
    try {
      await revokeTrustedPublisher(publisher.keyId);
      setPublishers((prev) => prev.filter((p) => p.keyId !== publisher.keyId));
      toast.success(`Revoked trust for ${publisher.label}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to revoke publisher: ${message}`);
      throw err; // keep the async Button in its error path (no success flash)
    }
  }, []);

  return (
    <div className="settings-panel__category">
      <div className="settings-panel__section" data-testid="settings-trusted-publishers">
        <h3 className="settings-panel__section-title">Trusted Publishers</h3>
        <p className="settings-panel__description">
          Publisher keys termiHub trusts to sign plugins. Plugins signed by a trusted key install as
          "Verified" with no untrusted-source warning. Bundled first-party keys cannot be revoked;
          revoking a pinned key returns its plugins to "signed (unknown)" on the next install.
        </p>

        {loading ? (
          <p className="settings-panel__empty">Loading…</p>
        ) : publishers.length === 0 ? (
          <p className="settings-panel__empty" data-testid="trusted-publishers-empty">
            No trusted publishers yet. Trust a publisher when installing a signed plugin.
          </p>
        ) : (
          <ul className="settings-panel__file-list">
            {publishers.map((p) => (
              <li
                key={p.keyId}
                className="settings-panel__file-item"
                data-testid="trusted-publisher-row"
              >
                <div>
                  <span className="settings-panel__subsection-title">{p.label}</span>{" "}
                  <code className="settings-panel__file-path">{fingerprintShort(p.keyId)}</code>{" "}
                  <span className="settings-panel__description">
                    · {p.source === "bundled" ? "bundled" : "user-pinned"}
                  </span>
                </div>
                {p.source === "user-pinned" && (
                  <Tooltip content="Revoke this publisher">
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      icon={<Trash2 size={14} />}
                      onClick={() => handleRevoke(p)}
                      errorToast={false}
                      aria-label={`Revoke trust for ${p.label}`}
                      data-testid={`trusted-publisher-revoke-${p.keyId}`}
                    />
                  </Tooltip>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
