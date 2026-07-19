import { Download, Terminal } from "lucide-react";
import { Button, Modal, toast } from "@/components/ui";
import { frontendLog } from "@/utils/frontendLog";
import { GIT_FOR_WINDOWS_WINGET_COMMAND } from "@/utils/gitBashSetup";
import { guideGitForWindowsInstall, openGitForWindowsDownload } from "./guideGitBashInstall";

interface GitBashSetupDialogProps {
  /** Whether the dialog is open (controlled). */
  open: boolean;
  /** Called with the next open state (Modal fires `false` on ESC / close / cancel). */
  onOpenChange: (open: boolean) => void;
  /**
   * Invoked once the guided-install terminal tab has been opened, so the caller
   * can re-detect the now-installing Git Bash (e.g. re-query available shells).
   */
  onInstallGuided?: () => void;
}

/**
 * Consent-gated guided install for Git for Windows (#1672), shown when a Windows
 * user asks for a Unix shell but none is detected. Nothing is installed until
 * the user acts: "Install in terminal" opens a local tab pre-loaded with the
 * winget command (reusing the shared `guideTerminalInstall` primitive), and
 * "Open git-scm.com" deep-links the official installer for machines without
 * winget. Composed from the shared `src/components/ui/` primitives — no bespoke
 * dialog CSS. Mirrors the X-server VcXsrv consent prompt.
 */
export function GitBashSetupDialog({
  open,
  onOpenChange,
  onInstallGuided,
}: GitBashSetupDialogProps) {
  const handleInstall = async () => {
    try {
      await guideGitForWindowsInstall();
      frontendLog("git_bash_setup", "opened guided Git for Windows install terminal");
      toast.success("Opened a terminal to install Git for Windows");
      onInstallGuided?.();
      onOpenChange(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      frontendLog("git_bash_setup", `guided install failed to start: ${msg}`);
      throw e; // return the Button to idle and surface its error toast
    }
  };

  const handleDownload = async () => {
    await openGitForWindowsDownload();
    frontendLog("git_bash_setup", "opened git-scm.com download page");
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Set up Git Bash"
      description="Install Git for Windows to get a Unix shell (bash, grep, curl, ssh) on Windows."
      data-testid="git-bash-setup"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            data-testid="git-bash-setup-not-now"
          >
            Not now
          </Button>
          <Button
            variant="ghost"
            icon={<Download size={16} aria-hidden />}
            onClick={handleDownload}
            data-testid="git-bash-setup-download"
          >
            Open git-scm.com
          </Button>
          <Button
            icon={<Terminal size={16} aria-hidden />}
            onClick={handleInstall}
            data-testid="git-bash-setup-install"
          >
            Install in terminal
          </Button>
        </>
      }
    >
      <p>
        A Unix shell needs <strong>Git for Windows</strong>, which isn&rsquo;t installed. It
        provides <strong>bash, grep, sed, curl, ssh</strong> and 20+ more tools.
      </p>
      <p>
        termiHub can open a terminal to run <code>{GIT_FOR_WINDOWS_WINGET_COMMAND}</code> (needs
        winget / App&nbsp;Installer), or you can download the official installer from git-scm.com.
        Once it finishes, Git Bash is detected and offered automatically &mdash; no app restart.
      </p>
    </Modal>
  );
}
