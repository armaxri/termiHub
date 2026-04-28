/**
 * Dialog for setting up a remote agent on a host.
 *
 * Opens in a "detecting" phase: immediately connects via SSH and detects the
 * remote architecture. Once detected, the form appears pre-configured with a
 * GitHub download as the default binary source. A local file picker is
 * available as a fallback.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { open } from "@tauri-apps/plugin-dialog";
import { RemoteAgentDefinition } from "@/types/connection";
import { RemoteAgentConfig } from "@/types/terminal";
import { detectAgentArch, setupRemoteAgent, RemoteArchInfo } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import "./AgentSetupDialog.css";

interface AgentSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: RemoteAgentDefinition;
}

type DialogPhase =
  | { kind: "detecting" }
  | { kind: "error"; message: string }
  | { kind: "ready"; archInfo: RemoteArchInfo };

export function AgentSetupDialog({ open: isOpen, onOpenChange, agent }: AgentSetupDialogProps) {
  const [phase, setPhase] = useState<DialogPhase>({ kind: "detecting" });
  const [remotePath, setRemotePath] = useState("~/.local/bin/termihub-agent");
  const [installService, setInstallService] = useState(false);
  const [binarySource, setBinarySource] = useState<"github" | "local">("github");
  const [localBinaryPath, setLocalBinaryPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const configRef = useRef<RemoteAgentConfig | null>(null);
  const addTab = useAppStore((s) => s.addTab);
  const requestPassword = useAppStore((s) => s.requestPassword);

  const runDetection = useCallback(async () => {
    setPhase({ kind: "detecting" });
    setSubmitError(null);

    try {
      const config: RemoteAgentConfig = { ...agent.config };

      if (config.authMethod === "password" && !config.password) {
        const pw = await requestPassword(config.host, config.username);
        if (!pw) {
          onOpenChange(false);
          return;
        }
        config.password = pw;
      }

      configRef.current = config;
      const archInfo = await detectAgentArch(config);
      setPhase({ kind: "ready", archInfo });

      // If arch is unsupported for download, fall back to local file
      if (!archInfo.archSuffix) {
        setBinarySource("local");
      }
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [agent, requestPassword, onOpenChange]);

  useEffect(() => {
    if (!isOpen) return;
    setRemotePath("~/.local/bin/termihub-agent");
    setInstallService(false);
    setBinarySource("github");
    setLocalBinaryPath("");
    setLoading(false);
    setSubmitError(null);
    configRef.current = null;
    runDetection();
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleBrowse = useCallback(async () => {
    const selected = await open({
      multiple: false,
      title: "Select termihub-agent binary",
    });
    if (selected) {
      setLocalBinaryPath(selected as string);
    }
  }, []);

  const handleSetup = useCallback(async () => {
    if (!configRef.current || phase.kind !== "ready") return;
    if (binarySource === "local" && !localBinaryPath) return;

    setLoading(true);
    setSubmitError(null);

    try {
      const result = await setupRemoteAgent(agent.id, configRef.current, {
        binarySource:
          binarySource === "github"
            ? { type: "githubDownload" }
            : { type: "localFile", path: localBinaryPath },
        remoteArch: phase.archInfo.arch,
        remotePath,
        installService,
      });

      const cfg = configRef.current;
      addTab(
        `Setup: ${agent.name}`,
        "ssh",
        {
          type: "ssh",
          config: {
            host: cfg.host,
            port: cfg.port,
            username: cfg.username,
            authMethod: cfg.authMethod,
            password: cfg.password,
            keyPath: cfg.keyPath,
            enableX11Forwarding: false,
          },
        },
        undefined,
        "terminal",
        undefined,
        result.sessionId
      );

      onOpenChange(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [
    phase,
    binarySource,
    localBinaryPath,
    remotePath,
    installService,
    agent,
    addTab,
    onOpenChange,
  ]);

  const isSubmitDisabled =
    loading || phase.kind !== "ready" || (binarySource === "local" && !localBinaryPath);

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

          {phase.kind === "detecting" && (
            <div className="agent-setup-dialog__detecting">
              <div className="agent-setup-dialog__spinner" />
              <span className="agent-setup-dialog__detecting-label">
                Connecting and detecting architecture…
              </span>
            </div>
          )}

          {phase.kind === "error" && (
            <div className="agent-setup-dialog__detection-error">
              <p className="agent-setup-dialog__error">{phase.message}</p>
              <button
                className="agent-setup-dialog__btn agent-setup-dialog__btn--secondary"
                onClick={runDetection}
                type="button"
              >
                Retry
              </button>
            </div>
          )}

          {phase.kind === "ready" && (
            <>
              <div className="agent-setup-dialog__field">
                <label className="agent-setup-dialog__label">Detected Architecture</label>
                <div className="agent-setup-dialog__arch-badge">
                  {phase.archInfo.archSuffix ?? phase.archInfo.arch}
                  <span className="agent-setup-dialog__arch-raw">
                    ({phase.archInfo.os} / {phase.archInfo.arch})
                  </span>
                </div>
              </div>

              <div className="agent-setup-dialog__field">
                <label className="agent-setup-dialog__label">Binary Source</label>
                <div className="agent-setup-dialog__source-selector">
                  <label
                    className={`agent-setup-dialog__source-option${binarySource === "github" ? " agent-setup-dialog__source-option--selected" : ""}`}
                  >
                    <div className="agent-setup-dialog__source-option-header">
                      <input
                        type="radio"
                        name="binarySource"
                        value="github"
                        checked={binarySource === "github"}
                        onChange={() => setBinarySource("github")}
                        disabled={!phase.archInfo.archSuffix}
                        data-testid="agent-setup-source-github"
                      />
                      <span>Download from GitHub</span>
                      {!phase.archInfo.archSuffix && (
                        <span className="agent-setup-dialog__unsupported">(unsupported arch)</span>
                      )}
                    </div>
                    {phase.archInfo.downloadUrl && (
                      <div className="agent-setup-dialog__url">{phase.archInfo.downloadUrl}</div>
                    )}
                  </label>

                  <label
                    className={`agent-setup-dialog__source-option${binarySource === "local" ? " agent-setup-dialog__source-option--selected" : ""}`}
                  >
                    <div className="agent-setup-dialog__source-option-header">
                      <input
                        type="radio"
                        name="binarySource"
                        value="local"
                        checked={binarySource === "local"}
                        onChange={() => setBinarySource("local")}
                        data-testid="agent-setup-source-local"
                      />
                      <span>Use local file</span>
                    </div>
                    {binarySource === "local" && (
                      <div className="agent-setup-dialog__file-row">
                        <input
                          className="agent-setup-dialog__input"
                          type="text"
                          value={localBinaryPath}
                          onChange={(e) => setLocalBinaryPath(e.target.value)}
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
                    )}
                  </label>
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
            </>
          )}

          {submitError && (
            <p className="agent-setup-dialog__error" data-testid="agent-setup-error">
              {submitError}
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
              disabled={isSubmitDisabled}
              data-testid="agent-setup-submit"
            >
              {loading ? "Setting up…" : "Start Setup"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
