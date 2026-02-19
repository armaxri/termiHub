/**
 * Dialog for setting up a remote agent on a host.
 *
 * Lets the user select a pre-built agent binary, configure the remote
 * install path, and optionally install a systemd service. On submit,
 * it uploads the binary and opens a visible SSH terminal with setup
 * commands.
 */

import { useState, useCallback, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { open } from "@tauri-apps/plugin-dialog";
import { RemoteAgentDefinition } from "@/types/connection";
import { RemoteAgentConfig } from "@/types/terminal";
import { setupRemoteAgent } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import "./AgentSetupDialog.css";

interface AgentSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: RemoteAgentDefinition;
}

export function AgentSetupDialog({ open: isOpen, onOpenChange, agent }: AgentSetupDialogProps) {
  const [binaryPath, setBinaryPath] = useState("");
  const [remotePath, setRemotePath] = useState("/usr/local/bin/termihub-agent");
  const [installService, setInstallService] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addTab = useAppStore((s) => s.addTab);
  const requestPassword = useAppStore((s) => s.requestPassword);

  useEffect(() => {
    if (isOpen) {
      setBinaryPath("");
      setError(null);
      setLoading(false);
    }
  }, [isOpen]);

  const handleBrowse = useCallback(async () => {
    const selected = await open({
      multiple: false,
      title: "Select termihub-agent binary",
    });
    if (selected) {
      setBinaryPath(selected as string);
    }
  }, []);

  const handleSetup = useCallback(async () => {
    if (!binaryPath) return;
    setLoading(true);
    setError(null);

    try {
      const config: RemoteAgentConfig = { ...agent.config };

      if (config.authMethod === "password" && !config.password) {
        const pw = await requestPassword(config.host, config.username);
        if (!pw) {
          setLoading(false);
          return;
        }
        config.password = pw;
      }

      const result = await setupRemoteAgent(agent.id, config, {
        binaryPath,
        remotePath,
        installService,
      });

      // Open a terminal tab with the pre-existing SSH session
      const sshConfig = {
        host: config.host,
        port: config.port,
        username: config.username,
        authMethod: config.authMethod,
        password: config.password,
        keyPath: config.keyPath,
        enableX11Forwarding: false,
      };
      addTab(
        `Setup: ${agent.name}`,
        "ssh",
        { type: "ssh", config: sshConfig },
        undefined,
        "terminal",
        undefined,
        result.sessionId
      );

      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [binaryPath, remotePath, installService, agent, requestPassword, addTab, onOpenChange]);

  return (
    <Dialog.Root open={isOpen} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="agent-setup-dialog__overlay" />
        <Dialog.Content className="agent-setup-dialog__content">
          <Dialog.Title className="agent-setup-dialog__title">
            Setup Agent: {agent.name}
          </Dialog.Title>
          <Dialog.Description className="agent-setup-dialog__description">
            Upload and install the termihub-agent binary on {agent.config.host}. The setup process
            will be visible in an SSH terminal.
          </Dialog.Description>

          <div className="agent-setup-dialog__field">
            <label className="agent-setup-dialog__label">Agent Binary</label>
            <div className="agent-setup-dialog__file-row">
              <input
                className="agent-setup-dialog__input"
                type="text"
                value={binaryPath}
                onChange={(e) => setBinaryPath(e.target.value)}
                placeholder="Path to termihub-agent binary"
                data-testid="agent-setup-binary-path"
              />
              <button
                className="agent-setup-dialog__browse-btn"
                onClick={handleBrowse}
                type="button"
                data-testid="agent-setup-browse"
              >
                Browse
              </button>
            </div>
          </div>

          <div className="agent-setup-dialog__field">
            <label className="agent-setup-dialog__label">Remote Install Path</label>
            <input
              className="agent-setup-dialog__input"
              type="text"
              value={remotePath}
              onChange={(e) => setRemotePath(e.target.value)}
              data-testid="agent-setup-remote-path"
            />
          </div>

          <div className="agent-setup-dialog__checkbox-row">
            <input
              type="checkbox"
              id="install-service"
              checked={installService}
              onChange={(e) => setInstallService(e.target.checked)}
              data-testid="agent-setup-install-service"
            />
            <label htmlFor="install-service">Install systemd service</label>
          </div>

          {error && (
            <p className="agent-setup-dialog__error" data-testid="agent-setup-error">
              {error}
            </p>
          )}

          <div className="agent-setup-dialog__actions">
            <button
              className="agent-setup-dialog__btn agent-setup-dialog__btn--secondary"
              onClick={() => onOpenChange(false)}
              data-testid="agent-setup-cancel"
            >
              Cancel
            </button>
            <button
              className="agent-setup-dialog__btn agent-setup-dialog__btn--primary"
              onClick={handleSetup}
              disabled={!binaryPath || loading}
              data-testid="agent-setup-submit"
            >
              {loading ? "Setting up..." : "Start Setup"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
