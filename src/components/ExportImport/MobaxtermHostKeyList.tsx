import { Ban, KeyRound, ShieldCheck } from "lucide-react";
import { Checkbox } from "@/components/ui";
import type { MobaxtermHostKey } from "@/types/connection";

interface MobaxtermHostKeyListProps {
  /** Every `[SSH_Hostkeys]` entry of the preview. */
  hostKeys: MobaxtermHostKey[];
  /** Whether the user opted in to trusting the new keys. */
  importNew: boolean;
  onImportNewChange: (value: boolean) => void;
}

/** `server.example.com:2222` for a key's target. */
function hostLabel(key: MobaxtermHostKey): string {
  if (!key.host) return key.id;
  return key.port === undefined ? key.host : `${key.host}:${key.port}`;
}

/** `ssh-ed25519 · SHA256:…`, leaving out what an invalid key lacks. */
function keyMeta(key: MobaxtermHostKey): string {
  return [key.keyType, key.fingerprint].filter(Boolean).join(" · ");
}

/** A key the import will not add, with why. */
function reasonFor(key: MobaxtermHostKey): string {
  if (key.status === "trusted") return "Already trusted.";
  return key.reason ?? "Not imported.";
}

/**
 * The host-key step of the MobaXterm import (#4852). MobaXterm's accepted SSH
 * host keys are trust anchors, so importing them is an explicit opt-in (off by
 * default): one checkbox for the new keys, listed with their fingerprints so
 * the user sees exactly what will be trusted. Keys that are already trusted,
 * conflict with an existing trusted key, or fail validation are listed with
 * their reason and never imported.
 */
export function MobaxtermHostKeyList({
  hostKeys,
  importNew,
  onImportNewChange,
}: MobaxtermHostKeyListProps) {
  const fresh = hostKeys.filter((k) => k.status === "new");
  const others = hostKeys.filter((k) => k.status !== "new");
  if (hostKeys.length === 0) return null;

  return (
    <section className="mobaxterm-import__hostkeys" data-testid="mobaxterm-import-hostkeys">
      <h3 className="mobaxterm-import__skipped-title">SSH host keys ({hostKeys.length})</h3>
      {fresh.length > 0 && (
        <>
          <label className="bulk-ssh-import__selectall">
            <Checkbox
              checked={importNew}
              onCheckedChange={(v) => onImportNewChange(v === true)}
              data-testid="mobaxterm-import-hostkeys-optin"
            />
            <span className="bulk-ssh-import__selectall-label">
              Also import {fresh.length} trusted host {fresh.length === 1 ? "key" : "keys"}
            </span>
          </label>
          <p className="mobaxterm-import__reason mobaxterm-import__hostkeys-hint">
            termiHub will connect to these hosts without asking to confirm their key. Only import
            keys you trust.
          </p>
          <ul className="ssh-config-import__list">
            {fresh.map((key) => (
              <li
                key={key.id}
                className="mobaxterm-import__skipped-row"
                data-testid={`mobaxterm-import-hostkey-${key.id}`}
              >
                <KeyRound size={14} aria-hidden className="mobaxterm-import__skipped-icon" />
                <span className="ssh-config-import__row-text">
                  <span className="ssh-config-import__row-name">{hostLabel(key)}</span>
                  <span className="ssh-config-import__row-chain">{keyMeta(key)}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {others.length > 0 && (
        <ul className="ssh-config-import__list">
          {others.map((key) => (
            <li
              key={key.id}
              className="mobaxterm-import__skipped-row"
              data-testid={`mobaxterm-import-hostkey-${key.id}`}
            >
              {key.status === "trusted" ? (
                <ShieldCheck size={14} aria-hidden className="mobaxterm-import__skipped-icon" />
              ) : (
                <Ban size={14} aria-hidden className="mobaxterm-import__skipped-icon" />
              )}
              <span className="ssh-config-import__row-text">
                <span className="ssh-config-import__row-name">{hostLabel(key)}</span>
                {keyMeta(key) && (
                  <span className="ssh-config-import__row-chain">{keyMeta(key)}</span>
                )}
                <span className="mobaxterm-import__reason">{reasonFor(key)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
