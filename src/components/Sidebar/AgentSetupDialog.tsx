/**
 * Dialog for setting up a remote agent on a host.
 *
 * Opens in a "detecting" phase: immediately connects via SSH and detects the
 * remote architecture. Once detected, the form appears with the detected arch
 * pre-selected in a dropdown (overridable). GitHub download is the default
 * binary source; a local file picker is available as fallback.
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

/** Supported target architectures for GitHub downloads. */
const ARCH_OPTIONS = [
  { suffix: "linux-x64", uname: "x86_64", os: "Linux", label: "linux-x64 (x86_64)" },
  { suffix: "linux-arm64", uname: "aarch64", os: "Linux", label: "linux-arm64 (aarch64)" },
  { suffix: "linux-armv7", uname: "armv7l", os: "Linux", label: "linux-armv7 (armv7l)" },
  { suffix: "macos-x64", uname: "x86_64", os: "Darwin", label: "macos-x64 (x86_64)" },
  { suffix: "macos-arm64", uname: "arm64", os: "Darwin", label: "macos-arm64 (arm64)" },
] as const;

type ArchSuffix = (typeof ARCH_OPTIONS)[number]["suffix"];

function isKnownSuffix(s: string | null): s is ArchSuffix {
  return ARCH_OPTIONS.some((o) => o.suffix === s);
}

export function AgentSetupDialog({ open: isOpen, onOpenChange, agent }: AgentSetupDialogProps) {
  const [phase, setPhase] = useState<DialogPhase>({ kind: "detecting" });
  const [selectedArch, setSelectedArch] = useState<ArchSuffix>("linux-x64");
  const [remotePath, setRemotePath] = useState("~/.local/bin/termihub-agent");
  const [installService, setInstallService] = useState(false);
  const [binarySource, setBinarySource] = useState<"github" | "branch" | "local">("github");
  const [branchName, setBranchName] = useState("");
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
      setSelectedArch(isKnownSuffix(archInfo.archSuffix) ? archInfo.archSuffix : "linux-x64");
      if (archInfo.buildBranch) {
        setBranchName(archInfo.buildBranch);
        setBinarySource("branch");
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
    setBranchName("");
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
    if (binarySource === "branch" && !branchName.trim()) return;

    setLoading(true);
    setSubmitError(null);

    const archOption = ARCH_OPTIONS.find((o) => o.suffix === selectedArch);
    const remoteOs = archOption?.os ?? phase.archInfo.os;
    const remoteArch = archOption?.uname ?? phase.archInfo.arch;

    try {
      const binarySourcePayload =
        binarySource === "github"
          ? ({ type: "githubDownload" } as const)
          : binarySource === "branch"
            ? ({ type: "branchBuild", branch: branchName.trim() } as const)
            : ({ type: "localFile", path: localBinaryPath } as const);

      const result = await setupRemoteAgent(agent.id, configRef.current, {
        binarySource: binarySourcePayload,
        remoteOs,
        remoteArch,
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
    selectedArch,
    binarySource,
    branchName,
    localBinaryPath,
    remotePath,
    installService,
    agent,
    addTab,
    onOpenChange,
  ]);

  const effectiveDownloadUrl =
    phase.kind === "ready" ? `${phase.archInfo.downloadBaseUrl}${selectedArch}` : null;

  const sanitizeBranch = (b: string) =>
    b
      .replace(/[^a-zA-Z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

  const branchBuildUrl = branchName.trim()
    ? `https://github.com/armaxri/termiHub/releases/download/agent-branch-${sanitizeBranch(branchName.trim())}/termihub-agent-${selectedArch}`
    : null;

  const isSubmitDisabled =
    loading ||
    phase.kind !== "ready" ||
    (binarySource === "local" && !localBinaryPath) ||
    (binarySource === "branch" && !branchName.trim());

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
                <label className="agent-setup-dialog__label" htmlFor="arch-select">
                  Target Architecture
                </label>
                <select
                  id="arch-select"
                  className="agent-setup-dialog__input agent-setup-dialog__select"
                  value={selectedArch}
                  onChange={(e) => setSelectedArch(e.target.value as ArchSuffix)}
                  data-testid="agent-setup-arch-select"
                >
                  {ARCH_OPTIONS.map((o) => (
                    <option key={o.suffix} value={o.suffix}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <span className="agent-setup-dialog__arch-hint">
                  Detected: {phase.archInfo.os} / {phase.archInfo.arch}
                  {!isKnownSuffix(phase.archInfo.archSuffix) && (
                    <span className="agent-setup-dialog__unsupported">
                      {" "}
                      (unsupported — please verify the selection above)
                    </span>
                  )}
                </span>
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
                        data-testid="agent-setup-source-github"
                      />
                      <span>Download from GitHub</span>
                    </div>
                    {effectiveDownloadUrl && (
                      <div className="agent-setup-dialog__url">{effectiveDownloadUrl}</div>
                    )}
                  </label>

                  <label
                    className={`agent-setup-dialog__source-option${binarySource === "branch" ? " agent-setup-dialog__source-option--selected" : ""}`}
                  >
                    <div className="agent-setup-dialog__source-option-header">
                      <input
                        type="radio"
                        name="binarySource"
                        value="branch"
                        checked={binarySource === "branch"}
                        onChange={() => setBinarySource("branch")}
                        data-testid="agent-setup-source-branch"
                      />
                      <span>Branch build</span>
                    </div>
                    {binarySource === "branch" && (
                      <>
                        <input
                          className="agent-setup-dialog__input"
                          type="text"
                          value={branchName}
                          onChange={(e) => setBranchName(e.target.value)}
                          placeholder="e.g. feature/666-my-branch"
                          data-testid="agent-setup-branch-name"
                        />
                        {branchBuildUrl && (
                          <div className="agent-setup-dialog__url">{branchBuildUrl}</div>
                        )}
                      </>
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
