/**
 * Dialog for setting up a remote agent on a host.
 *
 * Opens in a "detecting" phase: immediately connects via SSH and detects the
 * remote architecture. Once detected, the form appears with the detected arch
 * pre-selected in a dropdown (overridable). GitHub download is the default
 * binary source; a local file picker is available as fallback.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { RemoteAgentDefinition } from "@/types/connection";
import { RemoteAgentConfig } from "@/types/terminal";
import {
  detectAgentArch,
  setupRemoteAgent,
  cancelAgentSetup,
  RemoteArchInfo,
} from "@/services/api";
import { onAgentSetupProgress } from "@/services/events";
import { useAppStore } from "@/store/appStore";
import { Modal, Button, Input, toast } from "@/components/ui";
import "./AgentSetupDialog.css";

interface AgentSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: RemoteAgentDefinition;
}

type DialogPhase =
  | { kind: "detecting" }
  | { kind: "error"; message: string }
  | { kind: "ready"; archInfo: RemoteArchInfo }
  | { kind: "running"; step: string; message: string };

/** Supported target architectures for GitHub downloads. */
const ARCH_OPTIONS = [
  { suffix: "linux-x64", uname: "x86_64", os: "Linux", label: "linux-x64 (x86_64)" },
  { suffix: "linux-arm64", uname: "aarch64", os: "Linux", label: "linux-arm64 (aarch64)" },
  { suffix: "linux-armv7", uname: "armv7l", os: "Linux", label: "linux-armv7 (armv7l)" },
  { suffix: "macos-x64", uname: "x86_64", os: "Darwin", label: "macos-x64 (x86_64)" },
  { suffix: "macos-arm64", uname: "arm64", os: "Darwin", label: "macos-arm64 (arm64)" },
  { suffix: "windows-x64", uname: "x86_64", os: "Windows_NT", label: "windows-x64 (x86_64)" },
  { suffix: "windows-arm64", uname: "arm64", os: "Windows_NT", label: "windows-arm64 (aarch64)" },
] as const;

type ArchSuffix = (typeof ARCH_OPTIONS)[number]["suffix"];

/** Default POSIX install path. */
const POSIX_INSTALL_PATH = "~/.local/bin/termihub-agent";

/**
 * Fixed Windows install location. The backend always installs the agent under
 * `%LOCALAPPDATA%\termiHub\agent\` on Windows, so this path is informational
 * (the backend ignores a custom path on Windows for Phase 1).
 */
const WINDOWS_INSTALL_PATH = "%LOCALAPPDATA%\\termiHub\\agent\\termihub-agent.exe";

function isKnownSuffix(s: string | null): s is ArchSuffix {
  return ARCH_OPTIONS.some((o) => o.suffix === s);
}

/** Returns true if the given arch suffix targets a Windows host. */
function isWindowsSuffix(s: ArchSuffix): boolean {
  return ARCH_OPTIONS.find((o) => o.suffix === s)?.os === "Windows_NT";
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
  const progressUnlistenRef = useRef<UnlistenFn | null>(null);
  const progressToastIdRef = useRef<string | number | null>(null);
  const addTab = useAppStore((s) => s.addTab);
  const requestPassword = useAppStore((s) => s.requestPassword);

  const isWindows = isWindowsSuffix(selectedArch);

  /** Tear down the progress subscription (idempotent). */
  const stopProgressListener = useCallback(() => {
    if (progressUnlistenRef.current) {
      progressUnlistenRef.current();
      progressUnlistenRef.current = null;
    }
  }, []);

  // Never leak the progress listener across unmount.
  useEffect(() => stopProgressListener, [stopProgressListener]);

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

  // Keep the install-path field in sync with the selected target OS: Windows
  // installs to a fixed `%LOCALAPPDATA%` location, POSIX to `~/.local/bin`.
  useEffect(() => {
    setRemotePath(isWindows ? WINDOWS_INSTALL_PATH : POSIX_INSTALL_PATH);
    if (isWindows) setInstallService(false);
  }, [isWindows]);

  useEffect(() => {
    if (!isOpen) {
      // Leaving the dialog: drop any live progress subscription.
      stopProgressListener();
      progressToastIdRef.current = null;
      return;
    }
    setRemotePath(POSIX_INSTALL_PATH);
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

    // Long-running background op: a single loading toast resolves in place as
    // progress events arrive (done → success, error/cancelled → error).
    const toastId = toast.loading(`Deploying agent to ${agent.name}…`);
    progressToastIdRef.current = toastId;

    try {
      const binarySourcePayload =
        binarySource === "github"
          ? ({ type: "githubDownload" } as const)
          : binarySource === "branch"
            ? ({ type: "branchBuild", branch: branchName.trim() } as const)
            : ({ type: "localFile", path: localBinaryPath } as const);

      // Subscribe before initiating so no early progress event is missed. The
      // upload + script injection run in the background and stream steps here.
      stopProgressListener();
      const unlisten = await onAgentSetupProgress((agentId, step, message) => {
        if (agentId !== agent.id) return;

        if (step === "done") {
          toast.success(`Agent deployed to ${agent.name}`, {
            id: progressToastIdRef.current ?? undefined,
          });
          stopProgressListener();
          onOpenChange(false);
          return;
        }

        if (step === "error" || step === "cancelled") {
          const label = step === "cancelled" ? "cancelled" : "failed";
          toast.error(`Agent deploy to ${agent.name} ${label}: ${message}`, {
            id: progressToastIdRef.current ?? undefined,
          });
          stopProgressListener();
          setSubmitError(message);
          setPhase({ kind: "ready", archInfo: phase.archInfo });
          setLoading(false);
          return;
        }

        // In-flight step: reflect the live status in the running row.
        setPhase({ kind: "running", step, message });
      });
      progressUnlistenRef.current = unlisten;

      const result = await setupRemoteAgent(agent.id, configRef.current, {
        binarySource: binarySourcePayload,
        remoteOs,
        remoteArch,
        remotePath,
        installService,
      });

      // The SSH terminal session now exists — surface it immediately so the user
      // watches the setup, then enter the running phase to track background steps.
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
        { contentType: "terminal", sessionId: result.sessionId }
      );

      setPhase({ kind: "running", step: "connect", message: "Setup started…" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stopProgressListener();
      setSubmitError(message);
      setLoading(false);
      toast.error(`Agent deploy to ${agent.name} failed: ${message}`, { id: toastId });
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
    stopProgressListener,
  ]);

  /**
   * Cancel an in-flight setup: fire the backend cancellation token (which aborts
   * the background upload/injection and rolls back the partial upload), then
   * close the dialog. The rollback continues on the backend and surfaces via the
   * SSH terminal + a progress toast.
   */
  const handleCancelRunning = useCallback(async () => {
    try {
      await cancelAgentSetup(agent.id);
      toast.success(`Cancelling agent deploy to ${agent.name}…`, {
        id: progressToastIdRef.current ?? undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to cancel agent deploy: ${message}`);
      throw err;
    } finally {
      stopProgressListener();
    }
    onOpenChange(false);
  }, [agent.id, agent.name, onOpenChange, stopProgressListener]);

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
    <Modal
      open={isOpen}
      onOpenChange={onOpenChange}
      title={`Setup Agent: ${agent.name}`}
      footer={
        phase.kind === "running" ? (
          <Button
            variant="danger"
            onClick={handleCancelRunning}
            pendingLabel="Cancelling…"
            data-testid="agent-setup-cancel-running"
          >
            Cancel Setup
          </Button>
        ) : (
          <>
            <Button
              variant="secondary"
              onClick={() => onOpenChange(false)}
              data-testid="agent-setup-cancel"
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSetup}
              disabled={isSubmitDisabled}
              data-testid="agent-setup-submit"
            >
              {loading ? "Setting up…" : "Start Setup"}
            </Button>
          </>
        )
      }
    >
      <div className="agent-setup-dialog__body">
        <p className="agent-setup-dialog__description">
          Upload and install the termihub-agent binary on {agent.config.host}. The setup process
          will be visible in an SSH terminal.
        </p>

        {phase.kind === "detecting" && (
          <div className="agent-setup-dialog__detecting">
            <div className="agent-setup-dialog__spinner motion-essential-spinner" />
            <span className="agent-setup-dialog__detecting-label">
              Connecting and detecting architecture…
            </span>
          </div>
        )}

        {phase.kind === "running" && (
          <div className="agent-setup-dialog__running" data-testid="agent-setup-progress">
            <div className="agent-setup-dialog__spinner motion-essential-spinner" />
            <div className="agent-setup-dialog__running-text">
              <span className="agent-setup-dialog__running-step">{phase.step}</span>
              <span className="agent-setup-dialog__running-message">{phase.message}</span>
            </div>
          </div>
        )}

        {phase.kind === "error" && (
          <div className="agent-setup-dialog__detection-error">
            <p className="agent-setup-dialog__error">{phase.message}</p>
            <Button variant="secondary" onClick={runDetection}>
              Retry
            </Button>
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
                className="agent-setup-dialog__select"
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
                      <Input
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
                      <Input
                        value={localBinaryPath}
                        onChange={(e) => setLocalBinaryPath(e.target.value)}
                        placeholder="Path to termihub-agent binary"
                        data-testid="agent-setup-binary-path"
                      />
                      <Button
                        variant="secondary"
                        onClick={handleBrowse}
                        data-testid="agent-setup-browse"
                      >
                        Browse
                      </Button>
                    </div>
                  )}
                </label>
              </div>
            </div>

            <div className="agent-setup-dialog__field">
              <label className="agent-setup-dialog__label">Remote Install Path</label>
              <Input
                value={remotePath}
                onChange={(e) => setRemotePath(e.target.value)}
                readOnly={isWindows}
                data-testid="agent-setup-remote-path"
              />
              {isWindows && (
                <span className="agent-setup-dialog__arch-hint">
                  On Windows the agent is always installed under %LOCALAPPDATA%\termiHub\agent.
                </span>
              )}
            </div>

            {!isWindows && (
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
            )}
          </>
        )}

        {submitError && (
          <p className="agent-setup-dialog__error" data-testid="agent-setup-error">
            {submitError}
          </p>
        )}
      </div>
    </Modal>
  );
}
