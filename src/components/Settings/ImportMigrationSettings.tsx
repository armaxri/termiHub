import { useEffect, useState } from "react";
import { FileInput } from "lucide-react";
import { Button } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { discoverMobaxtermConfigs } from "@/services/api";
import { withLoggedFallback } from "@/utils/loggedFallback";
import "./CredentialVault.css";
import "./ImportMigrationSettings.css";

type Discovery = { status: "checking" } | { status: "found"; path: string } | { status: "none" };

/**
 * Settings → Import & Migration (#4850): one-time imports from other tools.
 * Holds the MobaXterm import — a migration, not a daily action, so it lives
 * here (and in the gear menu) rather than in the Connections sidebar. Shows
 * whether a MobaXterm configuration was found on this computer, and opens the
 * app-level preview dialog (`MobaxtermImportHost`) through the store.
 */
export function ImportMigrationSettings() {
  const setMobaxtermImportOpen = useAppStore((s) => s.setMobaxtermImportOpen);
  const [discovery, setDiscovery] = useState<Discovery>({ status: "checking" });

  useEffect(() => {
    let cancelled = false;
    void withLoggedFallback(
      discoverMobaxtermConfigs(),
      [],
      "mobaxterm_import",
      "look for a MobaXterm configuration"
    ).then((found) => {
      if (cancelled) return;
      const first = found?.[0];
      setDiscovery(first ? { status: "found", path: first.path } : { status: "none" });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="settings-panel__section" data-testid="import-migration-settings">
      <h3 className="settings-panel__section-title">Import from MobaXterm</h3>
      <p className="settings-panel__description">
        Bring your saved MobaXterm sessions into termiHub, folders included: SSH (with keys and jump
        hosts), Telnet, Serial, RDP, VNC, FTP, local shell and WSL sessions. You see a preview and
        choose what to import. Passwords are never imported.
      </p>
      <p className="import-migration__hint" data-testid="import-migration-mobaxterm-hint">
        {discovery.status === "checking" && "Looking for MobaXterm on this computer…"}
        {discovery.status === "found" && (
          <>
            Found MobaXterm configuration at{" "}
            <span className="import-migration__path">{discovery.path}</span>
          </>
        )}
        {discovery.status === "none" &&
          "No MobaXterm configuration was found on this computer. You can pick a MobaXterm.ini or an exported .mxtsessions file."}
      </p>
      <div className="credential-vault__actions">
        <Button
          variant="secondary"
          size="sm"
          icon={<FileInput size={14} />}
          onClick={() => setMobaxtermImportOpen(true)}
          data-testid="import-migration-mobaxterm-btn"
        >
          Import from MobaXterm…
        </Button>
      </div>
    </div>
  );
}
